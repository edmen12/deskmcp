import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RecoverableTaskStore,
  type CheckpointInput,
  type CreateTaskInput,
  type RecoverableTask,
  type TaskFinalReviewInput,
  type TaskListFilter
} from './task-state.js';

const CONTEXT_SCHEMA_VERSION = 1;
const CONTEXT_ID_PATTERN = /^ctx_[0-9a-f]{16}$/u;
const CONTEXT_HANDLE_PATTERN = /^tctx_([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/u;
const TASK_ID_PATTERN = /^tsk_[0-9a-f]{16}$/u;
const WORKSPACE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;
const MAX_CONTEXT_LABEL_BYTES = 256;
const MAX_CONTEXTS = 256;
const MAX_CAPABILITIES = 8;

interface ContextCapabilityRecord {
  readonly sha256: string;
  readonly issued_at: string;
}

interface ContextFile {
  readonly schema_version: number;
  readonly context_id: string;
  readonly label: string;
  readonly workspace_fingerprint: string;
  readonly capabilities: readonly ContextCapabilityRecord[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TaskContextDescriptor {
  readonly context_id: string;
  readonly label: string;
  readonly task_count: number;
  readonly active_task_count: number;
  readonly active_task_titles: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TaskContextAccess {
  readonly context_id: string;
  readonly label: string;
  readonly context_handle: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function normalizeLabel(value: string): string {
  const label = value.trim();
  if (!label) throw new Error('Task context label is required.');
  if (byteLength(label) > MAX_CONTEXT_LABEL_BYTES) {
    throw new Error(`Task context label exceeds ${MAX_CONTEXT_LABEL_BYTES} bytes.`);
  }
  return label;
}

function normalizeWorkspaceFingerprint(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!WORKSPACE_FINGERPRINT_PATTERN.test(normalized)) {
    throw new Error('Invalid workspace fingerprint.');
  }
  return normalized;
}

function normalizeContextId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!CONTEXT_ID_PATTERN.test(normalized)) throw new Error('Invalid task context id.');
  return normalized;
}

function normalizeTaskId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!TASK_ID_PATTERN.test(normalized)) throw new Error('Invalid task id.');
  return normalized;
}

function capabilityHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function newContextId(): string {
  return `ctx_${randomBytes(8).toString('hex')}`;
}

function newContextHandle(contextId: string): { handle: string; record: ContextCapabilityRecord } {
  const secret = randomBytes(32).toString('base64url');
  const issuedAt = new Date().toISOString();
  return {
    handle: `tctx_${contextId.slice(4)}.${secret}`,
    record: { sha256: capabilityHash(secret), issued_at: issuedAt }
  };
}

function parseContextHandle(value: string): { contextId: string; secret: string } {
  const match = CONTEXT_HANDLE_PATTERN.exec(value.trim());
  if (!match?.[1] || !match[2]) throw new Error('Invalid task context handle.');
  return { contextId: `ctx_${match[1]}`, secret: match[2] };
}

function hashMatches(actual: string, expected: string): boolean {
  try {
    const left = Buffer.from(actual, 'hex');
    const right = Buffer.from(expected, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function validateContextFile(value: unknown): ContextFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Task context file is invalid.');
  const candidate = value as Partial<ContextFile>;
  if (candidate.schema_version !== CONTEXT_SCHEMA_VERSION) {
    throw new Error(`Unsupported task context schema: ${String(candidate.schema_version)}.`);
  }
  if (typeof candidate.context_id !== 'string' || typeof candidate.label !== 'string' || typeof candidate.workspace_fingerprint !== 'string') {
    throw new Error('Task context identity is invalid.');
  }
  const contextId = normalizeContextId(candidate.context_id);
  const label = normalizeLabel(candidate.label);
  const workspaceFingerprint = normalizeWorkspaceFingerprint(candidate.workspace_fingerprint);
  if (!Array.isArray(candidate.capabilities) || candidate.capabilities.length < 1 || candidate.capabilities.length > MAX_CAPABILITIES) {
    throw new Error('Task context capabilities are invalid.');
  }
  const capabilities = candidate.capabilities.map(record => {
    if (!record || typeof record !== 'object') throw new Error('Task context capability record is invalid.');
    const typed = record as Partial<ContextCapabilityRecord>;
    if (typeof typed.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(typed.sha256) || typeof typed.issued_at !== 'string') {
      throw new Error('Task context capability record is invalid.');
    }
    return { sha256: typed.sha256, issued_at: typed.issued_at };
  });
  if (typeof candidate.created_at !== 'string' || typeof candidate.updated_at !== 'string') {
    throw new Error('Task context timestamps are invalid.');
  }
  return {
    schema_version: CONTEXT_SCHEMA_VERSION,
    context_id: contextId,
    label,
    workspace_fingerprint: workspaceFingerprint,
    capabilities,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at
  };
}

export function workspaceFingerprint(allowedRoots: readonly string[]): string {
  const normalized = allowedRoots
    .map(root => path.normalize(root))
    .map(root => process.platform === 'win32' ? root.toLowerCase() : root)
    .sort((left, right) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

export class TaskContextStore {
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly taskStores = new Map<string, RecoverableTaskStore>();

  constructor(readonly root: string) {}

  private get contextsRoot(): string {
    return path.join(this.root, 'contexts');
  }

  private contextRoot(contextId: string): string {
    return path.join(this.contextsRoot, normalizeContextId(contextId));
  }

  private contextPath(contextId: string): string {
    return path.join(this.contextRoot(contextId), 'context.json');
  }

  private taskRoot(contextId: string): string {
    return path.join(this.contextRoot(contextId), 'tasks');
  }

  private async taskStore(contextId: string): Promise<RecoverableTaskStore> {
    const normalized = normalizeContextId(contextId);
    let store = this.taskStores.get(normalized);
    if (!store) {
      store = new RecoverableTaskStore(this.taskRoot(normalized));
      this.taskStores.set(normalized, store);
      await store.init();
    }
    return store;
  }

  async init(): Promise<void> {
    await mkdir(this.contextsRoot, { recursive: true, mode: 0o700 });
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async loadContext(contextId: string): Promise<ContextFile> {
    const file = this.contextPath(contextId);
    const metadata = await stat(file).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Task context not found: ${contextId}.`);
      throw error;
    });
    if (metadata.size > MAX_CONTEXT_FILE_BYTES) throw new Error(`Task context file is too large: ${contextId}.`);
    const parsed = validateContextFile(JSON.parse(await readFile(file, 'utf8')) as unknown);
    if (parsed.context_id !== normalizeContextId(contextId)) throw new Error('Task context path/id mismatch.');
    return parsed;
  }

  private async saveContext(context: ContextFile): Promise<void> {
    const directory = this.contextRoot(context.context_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.contextPath(context.context_id);
    const temporary = path.join(directory, `.context.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`);
    const payload = `${JSON.stringify(context, null, 2)}\n`;
    if (byteLength(payload) > MAX_CONTEXT_FILE_BYTES) throw new Error('Task context file exceeds size limit.');
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  }

  private async listContextIds(): Promise<string[]> {
    const entries = await readdir(this.contextsRoot, { withFileTypes: true });
    const ids = entries
      .filter(entry => entry.isDirectory() && CONTEXT_ID_PATTERN.test(entry.name))
      .map(entry => entry.name);
    if (ids.length > MAX_CONTEXTS) throw new Error(`Task context count exceeds ${MAX_CONTEXTS}.`);
    return ids;
  }

  private async descriptor(context: ContextFile): Promise<TaskContextDescriptor> {
    const store = await this.taskStore(context.context_id);
    const all = await store.list({ limit: 200 });
    const active = all.filter(task => task.status === 'active' || task.status === 'blocked');
    const taskUpdatedAt = all.reduce((latest, task) => task.updated_at > latest ? task.updated_at : latest, context.updated_at);
    return {
      context_id: context.context_id,
      label: context.label,
      task_count: all.length,
      active_task_count: active.length,
      active_task_titles: active.slice(0, 3).map(task => task.title),
      created_at: context.created_at,
      updated_at: taskUpdatedAt
    };
  }

  async createContext(workspace: string, labelInput: string): Promise<TaskContextAccess> {
    const workspaceFingerprintValue = normalizeWorkspaceFingerprint(workspace);
    const label = normalizeLabel(labelInput);
    return this.serializeMutation(async () => {
      if ((await this.listContextIds()).length >= MAX_CONTEXTS) throw new Error(`Task context limit reached: ${MAX_CONTEXTS}.`);
      const contextId = newContextId();
      const issued = newContextHandle(contextId);
      const now = new Date().toISOString();
      const context: ContextFile = {
        schema_version: CONTEXT_SCHEMA_VERSION,
        context_id: contextId,
        label,
        workspace_fingerprint: workspaceFingerprintValue,
        capabilities: [issued.record],
        created_at: now,
        updated_at: now
      };
      await mkdir(this.taskRoot(contextId), { recursive: true, mode: 0o700 });
      await this.saveContext(context);
      return { context_id: contextId, label, context_handle: issued.handle, created_at: now, updated_at: now };
    });
  }

  async discoverContexts(workspace: string): Promise<TaskContextDescriptor[]> {
    const workspaceFingerprintValue = normalizeWorkspaceFingerprint(workspace);
    const out: TaskContextDescriptor[] = [];
    for (const contextId of await this.listContextIds()) {
      try {
        const context = await this.loadContext(contextId);
        if (context.workspace_fingerprint !== workspaceFingerprintValue) continue;
        out.push(await this.descriptor(context));
      } catch {
        // Corrupt contexts stay isolated and cannot be reattached implicitly.
      }
    }
    return out.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  private async contextForTask(workspace: string, taskId: string): Promise<ContextFile | undefined> {
    const workspaceFingerprintValue = normalizeWorkspaceFingerprint(workspace);
    const normalizedTaskId = normalizeTaskId(taskId);
    let found: ContextFile | undefined;
    for (const contextId of await this.listContextIds()) {
      const context = await this.loadContext(contextId).catch(() => undefined);
      if (!context || context.workspace_fingerprint !== workspaceFingerprintValue) continue;
      const file = path.join(this.taskRoot(context.context_id), `${normalizedTaskId}.json`);
      const exists = await stat(file).then(metadata => metadata.isFile(), () => false);
      if (!exists) continue;
      if (found) throw new Error('Task id is ambiguous across contexts.');
      found = context;
    }
    return found;
  }

  async reattachContext(
    workspace: string,
    input: { readonly task_id?: string; readonly context_id?: string; readonly confirm_label?: string }
  ): Promise<TaskContextAccess> {
    const workspaceFingerprintValue = normalizeWorkspaceFingerprint(workspace);
    return this.serializeMutation(async () => {
      let context: ContextFile | undefined;
      if (input.task_id) {
        context = await this.contextForTask(workspaceFingerprintValue, input.task_id);
        if (!context) throw new Error(`No task context in this workspace contains ${normalizeTaskId(input.task_id)}.`);
      } else {
        if (!input.context_id || !input.confirm_label) {
          throw new Error('Context reattach requires task_id, or context_id plus confirm_label.');
        }
        context = await this.loadContext(input.context_id);
        if (context.workspace_fingerprint !== workspaceFingerprintValue) throw new Error('Task context belongs to a different workspace.');
        if (context.label !== normalizeLabel(input.confirm_label)) throw new Error('Task context label confirmation does not match.');
      }
      const issued = newContextHandle(context.context_id);
      const now = new Date().toISOString();
      const capabilities = [...context.capabilities, issued.record].slice(-MAX_CAPABILITIES);
      const updated: ContextFile = { ...context, capabilities, updated_at: now };
      await this.saveContext(updated);
      return {
        context_id: updated.context_id,
        label: updated.label,
        context_handle: issued.handle,
        created_at: updated.created_at,
        updated_at: updated.updated_at
      };
    });
  }

  private async resolveAccess(handle: string, workspace: string): Promise<{ context: ContextFile; store: RecoverableTaskStore }> {
    const parsed = parseContextHandle(handle);
    const workspaceFingerprintValue = normalizeWorkspaceFingerprint(workspace);
    const context = await this.loadContext(parsed.contextId);
    if (context.workspace_fingerprint !== workspaceFingerprintValue) throw new Error('Task context belongs to a different workspace.');
    const presented = capabilityHash(parsed.secret);
    if (!context.capabilities.some(record => hashMatches(record.sha256, presented))) {
      throw new Error('Task context capability is invalid or expired.');
    }
    const store = await this.taskStore(context.context_id);
    return { context, store };
  }

  async createTask(handle: string, workspace: string, input: CreateTaskInput): Promise<RecoverableTask> {
    const { store } = await this.resolveAccess(handle, workspace);
    return store.create(input);
  }

  async listTasks(handle: string, workspace: string, filter: TaskListFilter = {}): Promise<RecoverableTask[]> {
    const { store } = await this.resolveAccess(handle, workspace);
    return store.list(filter);
  }

  async getTask(handle: string, workspace: string, taskId: string): Promise<RecoverableTask> {
    const { store } = await this.resolveAccess(handle, workspace);
    return store.get(taskId);
  }

  async checkpoint(handle: string, workspace: string, taskId: string, input: CheckpointInput): Promise<RecoverableTask> {
    const { store } = await this.resolveAccess(handle, workspace);
    return store.checkpoint(taskId, input);
  }

  async block(handle: string, workspace: string, taskId: string, summary: string): Promise<RecoverableTask> {
    const { store } = await this.resolveAccess(handle, workspace);
    return store.block(taskId, summary);
  }

  async resume(handle: string, workspace: string, taskId: string, summary: string): Promise<RecoverableTask> {
    const { store } = await this.resolveAccess(handle, workspace);
    return store.resume(taskId, summary);
  }

  async finalReview(handle: string, workspace: string, taskId: string, input: TaskFinalReviewInput): Promise<RecoverableTask> {
    const { store } = await this.resolveAccess(handle, workspace);
    return store.finalReview(taskId, input);
  }

  async complete(handle: string, workspace: string, taskId: string): Promise<RecoverableTask> {
    const { store } = await this.resolveAccess(handle, workspace);
    return store.complete(taskId);
  }
}
