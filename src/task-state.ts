import { randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';

export const TASK_SCHEMA_VERSION = 1;
export const TASK_PHASES = ['check', 'execute', 'verify', 'closeout'] as const;
export const TASK_STATUSES = ['active', 'blocked', 'completed'] as const;
export const TASK_STEP_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export const FINAL_REVIEW_STATUSES = ['pass', 'failed'] as const;

export type TaskPhase = typeof TASK_PHASES[number];
export type TaskStatus = typeof TASK_STATUSES[number];
export type TaskStepStatus = typeof TASK_STEP_STATUSES[number];
export type FinalReviewStatus = typeof FINAL_REVIEW_STATUSES[number];

const MAX_TASK_TITLE_BYTES = 512;
const MAX_TASK_GOAL_BYTES = 16 * 1024;
const MAX_CONDITION_BYTES = 4 * 1024;
const MAX_CONDITIONS = 64;
const MAX_STEP_TITLE_BYTES = 512;
const MAX_STEPS = 12;
const MAX_SUMMARY_BYTES = 8 * 1024;
const MAX_REVIEW_ITEM_BYTES = 4 * 1024;
const MAX_REVIEW_ITEMS = 64;
const MAX_EVENTS = 256;
const MAX_EVENT_SUMMARY_BYTES = 4 * 1024;
const MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;
const TASK_ID_PATTERN = /^tsk_[0-9a-f]{16}$/u;
const STEP_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface TaskCondition {
  readonly id: string;
  readonly text: string;
  readonly created_at: string;
}

export interface TaskStepInput {
  readonly id: string;
  readonly title: string;
  readonly phase?: TaskPhase;
}

export interface TaskStep {
  readonly id: string;
  readonly title: string;
  readonly phase: TaskPhase;
  readonly status: TaskStepStatus;
  readonly updated_at: string;
}

export interface TaskEvent {
  readonly type: string;
  readonly summary: string;
  readonly created_at: string;
}

export interface TaskFinalReviewInput {
  readonly status: FinalReviewStatus;
  readonly summary: string;
  readonly verified_facts?: readonly string[];
  readonly open_risks?: readonly string[];
  readonly missing_checks?: readonly string[];
}

export interface TaskFinalReview {
  readonly status: FinalReviewStatus;
  readonly summary: string;
  readonly verified_facts: readonly string[];
  readonly open_risks: readonly string[];
  readonly missing_checks: readonly string[];
  readonly review_revision: string;
  readonly reviewed_at: string;
}

export interface RecoverableTask {
  readonly schema_version: number;
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly project?: string;
  readonly device?: string;
  readonly status: TaskStatus;
  readonly phase: TaskPhase;
  readonly conditions: readonly TaskCondition[];
  readonly steps: readonly TaskStep[];
  readonly events: readonly TaskEvent[];
  readonly blocker?: string;
  readonly summary?: string;
  readonly final_review?: TaskFinalReview;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at?: string;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly goal: string;
  readonly completion_conditions: readonly string[];
  readonly steps?: readonly TaskStepInput[];
  readonly project?: string;
  readonly device?: string;
}

export interface CheckpointInput {
  readonly step_id?: string;
  readonly status?: TaskStepStatus;
  readonly completed_step_ids?: readonly string[];
  readonly current_step_id?: string;
  readonly summary: string;
}

export interface TaskListFilter {
  readonly status?: TaskStatus;
  readonly limit?: number;
}

interface MutableTask {
  schema_version: number;
  id: string;
  title: string;
  goal: string;
  project?: string;
  device?: string;
  status: TaskStatus;
  phase: TaskPhase;
  conditions: TaskCondition[];
  steps: TaskStep[];
  events: TaskEvent[];
  blocker?: string;
  summary?: string;
  final_review?: TaskFinalReview;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function requiredText(label: string, value: string, maxBytes: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (byteLength(normalized) > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  }
  return normalized;
}

function optionalText(label: string, value: string | undefined, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (byteLength(normalized) > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  }
  return normalized;
}

function uniqueTexts(values: readonly string[], label: string, maxItems: number, maxBytes: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = requiredText(label, raw, maxBytes);
    const key = value.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  if (out.length > maxItems) throw new Error(`${label} items cannot exceed ${maxItems}.`);
  return out;
}

function normalizeStepIds(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function newOpaqueId(prefix: 'tsk_' | 'rev_'): string {
  return `${prefix}${randomBytes(8).toString('hex')}`;
}

function validateTaskId(id: string): string {
  const normalized = id.trim();
  if (!TASK_ID_PATTERN.test(normalized)) throw new Error('Invalid task id.');
  return normalized;
}

function validateStepId(id: string): string {
  const normalized = id.trim();
  if (!normalized || !STEP_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid task step id: ${JSON.stringify(id)}.`);
  }
  return normalized;
}

function isTaskPhase(value: unknown): value is TaskPhase {
  return typeof value === 'string' && (TASK_PHASES as readonly string[]).includes(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

function isTaskStepStatus(value: unknown): value is TaskStepStatus {
  return typeof value === 'string' && (TASK_STEP_STATUSES as readonly string[]).includes(value);
}

function isFinalReviewStatus(value: unknown): value is FinalReviewStatus {
  return typeof value === 'string' && (FINAL_REVIEW_STATUSES as readonly string[]).includes(value);
}

function normalizeSteps(values: readonly TaskStepInput[] | undefined, now: string): TaskStep[] {
  const source = values ?? [];
  if (source.length > MAX_STEPS) throw new Error(`Task steps cannot exceed ${MAX_STEPS}.`);
  const seen = new Set<string>();
  return source.map(value => {
    const id = validateStepId(value.id);
    if (seen.has(id)) throw new Error(`Duplicate task step id: ${id}.`);
    seen.add(id);
    const title = requiredText('Task step title', value.title, MAX_STEP_TITLE_BYTES);
    const phase = value.phase ?? 'execute';
    if (!isTaskPhase(phase)) throw new Error(`Invalid task step phase: ${String(phase)}.`);
    return { id, title, phase, status: 'pending', updated_at: now };
  });
}

function validStepTransition(from: TaskStepStatus, to: TaskStepStatus): boolean {
  if (from === to) return true;
  if (from === 'pending') return to === 'in_progress' || to === 'completed';
  if (from === 'in_progress') return to === 'completed';
  return false;
}

function appendEvent(task: MutableTask, type: string, summary: string, now: string): void {
  const trimmed = summary.trim();
  const limited = byteLength(trimmed) <= MAX_EVENT_SUMMARY_BYTES
    ? trimmed
    : Buffer.from(trimmed, 'utf8').subarray(0, MAX_EVENT_SUMMARY_BYTES).toString('utf8');
  task.events.push({ type, summary: limited, created_at: now });
  if (task.events.length > MAX_EVENTS) {
    task.events.splice(0, task.events.length - MAX_EVENTS);
  }
}

function cloneTask(task: MutableTask): RecoverableTask {
  return structuredClone(task) as RecoverableTask;
}

function validateLoadedTask(value: unknown): MutableTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Task state file is not an object.');
  }
  const candidate = value as Partial<MutableTask>;
  if (candidate.schema_version !== TASK_SCHEMA_VERSION) {
    throw new Error(`Unsupported task schema version: ${String(candidate.schema_version)}.`);
  }
  if (typeof candidate.id !== 'string') throw new Error('Task id is missing.');
  validateTaskId(candidate.id);
  if (typeof candidate.title !== 'string' || typeof candidate.goal !== 'string') {
    throw new Error('Task title or goal is missing.');
  }
  if (!isTaskStatus(candidate.status) || !isTaskPhase(candidate.phase)) {
    throw new Error('Task status or phase is invalid.');
  }
  if (!Array.isArray(candidate.conditions) || !Array.isArray(candidate.steps) || !Array.isArray(candidate.events)) {
    throw new Error('Task collections are invalid.');
  }
  for (const step of candidate.steps) {
    if (!step || typeof step !== 'object') throw new Error('Task step is invalid.');
    const typed = step as Partial<TaskStep>;
    if (typeof typed.id !== 'string' || typeof typed.title !== 'string' || !isTaskPhase(typed.phase) || !isTaskStepStatus(typed.status) || typeof typed.updated_at !== 'string') {
      throw new Error('Task step state is invalid.');
    }
  }
  if (candidate.final_review !== undefined) {
    const review = candidate.final_review as Partial<TaskFinalReview>;
    if (!review || !isFinalReviewStatus(review.status) || typeof review.summary !== 'string') {
      throw new Error('Task final review is invalid.');
    }
  }
  if (typeof candidate.created_at !== 'string' || typeof candidate.updated_at !== 'string') {
    throw new Error('Task timestamps are invalid.');
  }
  return candidate as MutableTask;
}

export class RecoverableTaskStore {
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  private filePath(id: string): string {
    return path.join(this.root, `${validateTaskId(id)}.json`);
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

  private async readTaskLocked(id: string): Promise<MutableTask> {
    const file = this.filePath(id);
    const metadata = await stat(file).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Task not found: ${id}.`);
      throw error;
    });
    if (metadata.size > MAX_STATE_FILE_BYTES) throw new Error(`Task state file is too large: ${id}.`);
    const text = await readFile(file, 'utf8');
    return validateLoadedTask(JSON.parse(text) as unknown);
  }

  private async writeTaskLocked(task: MutableTask): Promise<void> {
    validateTaskId(task.id);
    const target = this.filePath(task.id);
    const temporary = path.join(this.root, `.${task.id}.${process.pid}.${Date.now()}.tmp`);
    const payload = `${JSON.stringify(task, null, 2)}\n`;
    if (byteLength(payload) > MAX_STATE_FILE_BYTES) throw new Error(`Task state exceeds ${MAX_STATE_FILE_BYTES} bytes.`);
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async create(input: CreateTaskInput): Promise<RecoverableTask> {
    return this.serializeMutation(async () => {
      const title = requiredText('Task title', input.title, MAX_TASK_TITLE_BYTES);
      const goal = requiredText('Task goal', input.goal, MAX_TASK_GOAL_BYTES);
      const conditions = uniqueTexts(input.completion_conditions, 'Task completion condition', MAX_CONDITIONS, MAX_CONDITION_BYTES);
      if (conditions.length === 0) throw new Error('At least one completion condition is required.');
      const project = optionalText('Task project', input.project, 256);
      const device = optionalText('Task device', input.device, 256);
      const now = new Date().toISOString();
      const steps = normalizeSteps(input.steps, now);
      const id = newOpaqueId('tsk_');
      const task: MutableTask = {
        schema_version: TASK_SCHEMA_VERSION,
        id,
        title,
        goal,
        status: 'active',
        phase: steps[0]?.phase ?? 'check',
        conditions: conditions.map((text, index) => ({
          id: `cond_${String(index + 1).padStart(2, '0')}`,
          text,
          created_at: now
        })),
        steps,
        events: [{ type: 'created', summary: 'task created', created_at: now }],
        created_at: now,
        updated_at: now,
        ...(project ? { project } : {}),
        ...(device ? { device } : {})
      };
      await this.writeTaskLocked(task);
      return cloneTask(task);
    });
  }

  async get(id: string): Promise<RecoverableTask> {
    const task = await this.readTaskLocked(validateTaskId(id));
    return cloneTask(task);
  }

  async list(filter: TaskListFilter = {}): Promise<RecoverableTask[]> {
    const limit = filter.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Task list limit must be between 1 and 200.');
    const entries = await readdir(this.root, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const tasks: RecoverableTask[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^tsk_[0-9a-f]{16}\.json$/u.test(entry.name)) continue;
      try {
        const task = await this.get(entry.name.slice(0, -5));
        if (filter.status && task.status !== filter.status) continue;
        tasks.push(task);
      } catch {
        // A corrupt task is isolated to its own file. get(id) still surfaces the error explicitly.
      }
    }
    tasks.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    return tasks.slice(0, limit);
  }

  private async mutate(id: string, fn: (task: MutableTask, now: string) => void): Promise<RecoverableTask> {
    return this.serializeMutation(async () => {
      const task = await this.readTaskLocked(validateTaskId(id));
      const now = new Date().toISOString();
      fn(task, now);
      task.updated_at = now;
      await this.writeTaskLocked(task);
      return cloneTask(task);
    });
  }

  async checkpoint(id: string, input: CheckpointInput): Promise<RecoverableTask> {
    return this.mutate(id, (task, now) => {
      if (task.status !== 'active') throw new Error(`Task status must be active, got ${task.status}.`);
      if (task.final_review?.status === 'pass') throw new Error('Task already passed final review.');
      const summary = requiredText('Checkpoint summary', input.summary, MAX_SUMMARY_BYTES);
      const completedIds = normalizeStepIds(input.completed_step_ids);
      const currentId = input.current_step_id?.trim() ?? '';
      const singleId = input.step_id?.trim() ?? '';
      const singleStatus = input.status;
      const batchMode = completedIds.length > 0 || currentId.length > 0;
      const singleMode = singleId.length > 0 || singleStatus !== undefined;
      if (batchMode && singleMode) throw new Error('Use either step_id/status or completed_step_ids/current_step_id, not both.');
      if (!batchMode && !singleMode) throw new Error('Checkpoint requires step_id/status or completed_step_ids/current_step_id.');

      if (singleMode) {
        if (!singleId || !singleStatus) throw new Error('step_id and status are required together.');
        if (!isTaskStepStatus(singleStatus)) throw new Error(`Invalid task step status: ${String(singleStatus)}.`);
        const index = task.steps.findIndex(step => step.id === singleId);
        if (index < 0) throw new Error(`Task step not found: ${singleId}.`);
        const step = task.steps[index]!;
        if (!validStepTransition(step.status, singleStatus)) {
          throw new Error(`Cannot move step ${step.id} from ${step.status} to ${singleStatus}.`);
        }
        if (singleStatus === 'in_progress') {
          const already = task.steps.find(other => other.id !== step.id && other.status === 'in_progress');
          if (already) throw new Error(`Step ${already.id} is already in progress.`);
        }
        task.steps[index] = { ...step, status: singleStatus, updated_at: now };
        task.phase = step.phase;
        task.summary = summary;
        if (task.final_review?.status === 'failed') delete task.final_review;
        appendEvent(task, 'checkpoint', `${step.id}=${singleStatus}: ${summary}`, now);
        return;
      }

      const completedSet = new Set(completedIds);
      if (currentId && completedSet.has(currentId)) {
        throw new Error(`Step ${currentId} cannot be both completed and current.`);
      }
      const indexes = new Map(task.steps.map((step, index) => [step.id, index] as const));
      for (const stepId of completedIds) {
        const index = indexes.get(stepId);
        if (index === undefined) throw new Error(`Task step not found: ${stepId}.`);
        const step = task.steps[index]!;
        if (!validStepTransition(step.status, 'completed')) {
          throw new Error(`Cannot move step ${step.id} from ${step.status} to completed.`);
        }
      }
      let currentIndex: number | undefined;
      if (currentId) {
        currentIndex = indexes.get(currentId);
        if (currentIndex === undefined) throw new Error(`Task step not found: ${currentId}.`);
        const current = task.steps[currentIndex]!;
        if (!validStepTransition(current.status, 'in_progress')) {
          throw new Error(`Cannot move step ${current.id} from ${current.status} to in_progress.`);
        }
        const already = task.steps.find(step => step.id !== current.id && step.status === 'in_progress' && !completedSet.has(step.id));
        if (already) throw new Error(`Step ${already.id} is already in progress.`);
      }
      for (const stepId of completedIds) {
        const index = indexes.get(stepId)!;
        const step = task.steps[index]!;
        task.steps[index] = { ...step, status: 'completed', updated_at: now };
      }
      if (currentIndex !== undefined) {
        const step = task.steps[currentIndex]!;
        task.steps[currentIndex] = { ...step, status: 'in_progress', updated_at: now };
        task.phase = step.phase;
      } else if (completedIds.length > 0) {
        const last = task.steps[indexes.get(completedIds.at(-1)!)!]!;
        task.phase = last.phase;
      }
      task.summary = summary;
      if (task.final_review?.status === 'failed') delete task.final_review;
      const currentPart = currentId ? `, current=${currentId}` : '';
      appendEvent(task, 'checkpoint', `completed=[${completedIds.join(',')}]${currentPart}: ${summary}`, now);
    });
  }

  async block(id: string, summary: string): Promise<RecoverableTask> {
    return this.mutate(id, (task, now) => {
      if (task.status === 'completed') throw new Error('Completed tasks are immutable.');
      if (task.final_review?.status === 'pass') throw new Error('Task already passed final review.');
      const normalized = requiredText('Block summary', summary, MAX_SUMMARY_BYTES);
      task.status = 'blocked';
      task.blocker = normalized;
      task.summary = normalized;
      appendEvent(task, 'blocked', normalized, now);
    });
  }

  async resume(id: string, summary: string): Promise<RecoverableTask> {
    return this.mutate(id, (task, now) => {
      if (task.status !== 'blocked') throw new Error('Only blocked tasks can be resumed.');
      const normalized = requiredText('Resume summary', summary, MAX_SUMMARY_BYTES);
      task.status = 'active';
      delete task.blocker;
      task.summary = normalized;
      appendEvent(task, 'resumed', normalized, now);
    });
  }

  async finalReview(id: string, input: TaskFinalReviewInput): Promise<RecoverableTask> {
    return this.mutate(id, (task, now) => {
      if (task.status !== 'active') throw new Error(`Task status must be active, got ${task.status}.`);
      if (task.final_review?.status === 'pass') throw new Error('Task already passed final review.');
      if (!isFinalReviewStatus(input.status)) throw new Error(`Invalid final review status: ${String(input.status)}.`);
      const summary = requiredText('Final review summary', input.summary, MAX_SUMMARY_BYTES);
      const verifiedFacts = uniqueTexts(input.verified_facts ?? [], 'Final review verified fact', MAX_REVIEW_ITEMS, MAX_REVIEW_ITEM_BYTES);
      const openRisks = uniqueTexts(input.open_risks ?? [], 'Final review open risk', MAX_REVIEW_ITEMS, MAX_REVIEW_ITEM_BYTES);
      const missingChecks = uniqueTexts(input.missing_checks ?? [], 'Final review missing check', MAX_REVIEW_ITEMS, MAX_REVIEW_ITEM_BYTES);

      if (input.status === 'pass') {
        if (verifiedFacts.length === 0) throw new Error('Passing final review requires at least one verified fact.');
        const incomplete = task.steps.filter(step => step.status !== 'completed').map(step => step.id);
        if (incomplete.length > 0) {
          throw new Error(`Passing final review requires all task steps completed: ${incomplete.join(', ')}.`);
        }
      } else if (openRisks.length === 0 && missingChecks.length === 0) {
        throw new Error('Failed final review requires at least one open risk or missing check.');
      }

      task.final_review = {
        status: input.status,
        summary,
        verified_facts: verifiedFacts,
        open_risks: openRisks,
        missing_checks: missingChecks,
        review_revision: newOpaqueId('rev_'),
        reviewed_at: now
      };
      if (input.status === 'pass') task.phase = 'closeout';
      task.summary = summary;
      appendEvent(task, 'final_review', `${input.status}: ${summary}`, now);
    });
  }

  async complete(id: string): Promise<RecoverableTask> {
    return this.mutate(id, (task, now) => {
      if (task.status !== 'active') throw new Error(`Task status must be active, got ${task.status}.`);
      if (task.final_review?.status !== 'pass') throw new Error('final_review must pass before complete.');
      if (task.phase !== 'closeout') throw new Error('Task must reach closeout before completion.');
      task.status = 'completed';
      task.summary = task.final_review.summary;
      task.completed_at = now;
      appendEvent(task, 'completed', task.final_review.summary, now);
    });
  }
}
