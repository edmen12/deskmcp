import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentDesktopNativeBridge } from './agent-desktop-native.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TASK_ID_PATTERN = /^tsk_[0-9a-f]{16}$/u;
const HUD_HEARTBEAT_MAX_AGE_MS = 2500;
const HUD_READY_TIMEOUT_MS = 3500;
const LOCK_TIMEOUT_MS = 2500;

export interface AgentDesktopBinding {
  readonly schemaVersion: 1;
  readonly desktopId: string;
  readonly desktopNumber?: number;
  readonly boundAtUtc: string;
}

interface AgentDesktopConfigDocument {
  readonly schemaVersion: 2;
  readonly bindings: readonly AgentDesktopBinding[];
}

export interface AgentDesktopControlState {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly active: boolean;
  readonly leaseId?: string;
  readonly desktopId?: string;
  readonly desktopNumber?: number;
  readonly taskLabel?: string;
  readonly taskId?: string;
  readonly startedAtUtc?: string;
  readonly revokedAtUtc?: string;
}

interface AgentDesktopControlDocument {
  readonly schemaVersion: 2;
  readonly generation: number;
  readonly controls: readonly AgentDesktopControlState[];
}

export interface AgentDesktopHudState {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly leaseId: string;
  readonly armed: true;
  readonly visible: boolean;
  readonly processId: number;
  readonly heartbeatAtUtc: string;
}

interface AgentDesktopHudDocument {
  readonly schemaVersion: 2;
  readonly entries: readonly AgentDesktopHudState[];
}

export interface AgentDesktopStatus {
  readonly configured: boolean;
  readonly bindings: readonly AgentDesktopBinding[];
  readonly binding?: AgentDesktopBinding;
  readonly controls: readonly AgentDesktopControlState[];
  readonly control: AgentDesktopControlState;
  readonly available_desktops: number;
  readonly hud_ready: boolean;
  readonly hud_visible: boolean;
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validBinding(value: unknown): value is AgentDesktopBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === 1
    && typeof row.desktopId === 'string'
    && UUID_PATTERN.test(row.desktopId)
    && (row.desktopNumber === undefined || (Number.isInteger(row.desktopNumber) && Number(row.desktopNumber) >= 0))
    && validIso(row.boundAtUtc);
}

function validConfig(value: unknown): value is AgentDesktopConfigDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 2 || !Array.isArray(row.bindings) || !row.bindings.every(validBinding)) return false;
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const binding of row.bindings as AgentDesktopBinding[]) {
    const id = binding.desktopId.toLowerCase();
    if (ids.has(id)) return false;
    ids.add(id);
    if (binding.desktopNumber !== undefined) {
      if (numbers.has(binding.desktopNumber)) return false;
      numbers.add(binding.desktopNumber);
    }
  }
  return true;
}

function validControl(value: unknown, requireDesktop = false): value is AgentDesktopControlState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.generation) || Number(row.generation) < 0 || typeof row.active !== 'boolean') return false;
  if (row.active) {
    if (typeof row.leaseId !== 'string' || !UUID_PATTERN.test(row.leaseId)) return false;
    if (!validIso(row.startedAtUtc)) return false;
    if (requireDesktop) {
      if (typeof row.desktopId !== 'string' || !UUID_PATTERN.test(row.desktopId)) return false;
      if (!Number.isInteger(row.desktopNumber) || Number(row.desktopNumber) <= 0) return false;
    }
  }
  return (row.desktopId === undefined || (typeof row.desktopId === 'string' && UUID_PATTERN.test(row.desktopId)))
    && (row.desktopNumber === undefined || (Number.isInteger(row.desktopNumber) && Number(row.desktopNumber) >= 0))
    && (row.taskLabel === undefined || typeof row.taskLabel === 'string')
    && (row.taskId === undefined || (typeof row.taskId === 'string' && TASK_ID_PATTERN.test(row.taskId)));
}

function validControlDocument(value: unknown): value is AgentDesktopControlDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 2 || !Number.isSafeInteger(row.generation) || Number(row.generation) < 0 || !Array.isArray(row.controls)) return false;
  if (!row.controls.every(control => validControl(control, true) && (control as AgentDesktopControlState).active)) return false;
  const leases = new Set<string>();
  const desktops = new Set<string>();
  for (const control of row.controls as AgentDesktopControlState[]) {
    const lease = control.leaseId!.toLowerCase();
    const desktop = control.desktopId!.toLowerCase();
    if (leases.has(lease) || desktops.has(desktop)) return false;
    leases.add(lease);
    desktops.add(desktop);
  }
  return true;
}

function validHud(value: unknown): value is AgentDesktopHudState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === 1
    && Number.isSafeInteger(row.generation)
    && Number(row.generation) >= 0
    && typeof row.leaseId === 'string'
    && UUID_PATTERN.test(row.leaseId)
    && row.armed === true
    && typeof row.visible === 'boolean'
    && Number.isSafeInteger(row.processId)
    && Number(row.processId) > 0
    && validIso(row.heartbeatAtUtc);
}

function validHudDocument(value: unknown): value is AgentDesktopHudDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === 2 && Array.isArray(row.entries) && row.entries.every(validHud);
}

async function readJson(pathname: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(pathname, 'utf8')) as unknown; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicJson(pathname: string, value: unknown): Promise<void> {
  const temp = `${pathname}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temp, pathname);
}

function inactiveControl(generation: number): AgentDesktopControlState {
  return { schemaVersion: 1, generation, active: false };
}

export class AgentDesktopManager {
  private readonly configPath: string;
  private readonly controlPath: string;
  private readonly hudPath: string;
  private readonly lockPath: string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string,
    private readonly native: AgentDesktopNativeBridge
  ) {
    this.configPath = path.join(root, 'config.json');
    this.controlPath = path.join(root, 'control.json');
    this.hudPath = path.join(root, 'hud-state.json');
    this.lockPath = path.join(root, 'control.lock');
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const current = await this.readControlDocument();
    const nextGeneration = current.generation + (current.controls.length > 0 ? 1 : 0);
    await atomicJson(this.controlPath, {
      schemaVersion: 2,
      generation: nextGeneration,
      controls: []
    } satisfies AgentDesktopControlDocument);
    if (current.controls.length > 0) await rm(this.hudPath, { force: true }).catch(() => undefined);
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => undefined);
    try { return await operation(); }
    finally { release(); }
  }

  private async withCrossProcessLock<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(`${process.pid}\n`, 'utf8');
          return await operation();
        } finally {
          await handle.close().catch(() => undefined);
          await rm(this.lockPath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('Agent Desktop control lock is busy.');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
  }

  async bindings(): Promise<readonly AgentDesktopBinding[]> {
    const raw = await readJson(this.configPath);
    if (raw === undefined) return [];
    if (validBinding(raw)) return [raw];
    if (!validConfig(raw)) throw new Error('Agent Desktop binding state is invalid. Re-bind Agent Desktops from the DeskMCP Control Panel.');
    return [...raw.bindings].sort((a, b) => (a.desktopNumber ?? Number.MAX_SAFE_INTEGER) - (b.desktopNumber ?? Number.MAX_SAFE_INTEGER));
  }

  async binding(): Promise<AgentDesktopBinding | undefined> {
    return (await this.bindings())[0];
  }

  private async readControlDocument(): Promise<AgentDesktopControlDocument> {
    const raw = await readJson(this.controlPath);
    if (raw === undefined) return { schemaVersion: 2, generation: 0, controls: [] };
    if (validControlDocument(raw)) return raw;
    if (validControl(raw)) {
      return {
        schemaVersion: 2,
        generation: raw.generation,
        controls: raw.active ? [raw] : []
      };
    }
    throw new Error('Agent Desktop control state is invalid.');
  }

  private async hudEntries(): Promise<readonly AgentDesktopHudState[]> {
    const raw = await readJson(this.hudPath);
    if (raw === undefined) return [];
    if (validHud(raw)) return [raw];
    if (validHudDocument(raw)) return raw.entries;
    return [];
  }

  private async hudMatches(control: AgentDesktopControlState): Promise<boolean> {
    if (!control.active || !control.leaseId) return false;
    const hud = (await this.hudEntries()).find(entry => entry.leaseId.toLowerCase() === control.leaseId!.toLowerCase());
    if (!hud || hud.generation !== control.generation || !hud.armed) return false;
    const age = Date.now() - Date.parse(hud.heartbeatAtUtc);
    return age >= 0 && age <= HUD_HEARTBEAT_MAX_AGE_MS;
  }

  private async statusForLease(preferredLeaseId?: string): Promise<AgentDesktopStatus> {
    const [bindings, document, hudEntries] = await Promise.all([
      this.bindings(),
      this.readControlDocument(),
      this.hudEntries()
    ]);
    const controls = [...document.controls];
    const preferred = preferredLeaseId
      ? controls.find(control => control.leaseId?.toLowerCase() === preferredLeaseId.toLowerCase())
      : undefined;
    const selected = preferred ?? controls[0] ?? inactiveControl(document.generation);
    const now = Date.now();
    const liveHud = hudEntries.filter(entry => {
      const age = now - Date.parse(entry.heartbeatAtUtc);
      return age >= 0 && age <= HUD_HEARTBEAT_MAX_AGE_MS;
    });
    const readyLeases = new Set(liveHud.filter(entry => entry.armed).map(entry => entry.leaseId.toLowerCase()));
    const selectedReady = selected.active && selected.leaseId ? readyLeases.has(selected.leaseId.toLowerCase()) : false;
    const selectedVisible = selectedReady && selected.leaseId
      ? Boolean(liveHud.find(entry => entry.leaseId.toLowerCase() === selected.leaseId!.toLowerCase())?.visible)
      : false;
    const usedDesktopIds = new Set(controls.map(control => control.desktopId?.toLowerCase()).filter((value): value is string => Boolean(value)));
    return {
      configured: bindings.length > 0,
      bindings,
      ...(bindings[0] ? { binding: bindings[0] } : {}),
      controls,
      control: selected,
      available_desktops: bindings.filter(binding => !usedDesktopIds.has(binding.desktopId.toLowerCase())).length,
      hud_ready: selectedReady,
      hud_visible: selectedVisible
    };
  }

  status(): Promise<AgentDesktopStatus> {
    return this.statusForLease();
  }

  async startControl(taskLabel?: string, taskId?: string): Promise<AgentDesktopStatus> {
    const label = taskLabel?.trim();
    const normalizedTaskId = taskId?.trim().toLowerCase();
    if (label && label.length > 200) throw new Error('Agent Desktop task label is too long.');
    if (normalizedTaskId && !TASK_ID_PATTERN.test(normalizedTaskId)) throw new Error('Invalid Agent Desktop task id.');
    await this.native.info();

    const control = await this.serialize(() => this.withCrossProcessLock(async () => {
      const [bindings, document] = await Promise.all([this.bindings(), this.readControlDocument()]);
      if (bindings.length === 0) throw new Error('No Agent Desktops are bound. Bind Desktop 2 or later in DeskMCP Settings.');
      const used = new Set(document.controls.map(row => row.desktopId!.toLowerCase()));
      const binding = bindings.find(row => !used.has(row.desktopId.toLowerCase()));
      if (!binding) throw new Error('All bound Agent Desktops are busy. Bind another virtual desktop or wait for an existing Agent Control lease to exit.');
      if (!Number.isInteger(binding.desktopNumber) || binding.desktopNumber! <= 0) throw new Error('Agent Desktop binding is missing a valid desktop number. Re-bind it from DeskMCP Settings.');
      const nextGeneration = document.generation + 1;
      const next: AgentDesktopControlState = {
        schemaVersion: 1,
        generation: nextGeneration,
        active: true,
        leaseId: randomUUID(),
        desktopId: binding.desktopId,
        desktopNumber: binding.desktopNumber!,
        ...(label ? { taskLabel: label } : {}),
        ...(normalizedTaskId ? { taskId: normalizedTaskId } : {}),
        startedAtUtc: new Date().toISOString()
      };
      await atomicJson(this.controlPath, {
        schemaVersion: 2,
        generation: nextGeneration,
        controls: [...document.controls, next]
      } satisfies AgentDesktopControlDocument);
      return next;
    }));

    const deadline = Date.now() + HUD_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.hudMatches(control)) return this.statusForLease(control.leaseId);
      await new Promise(resolve => setTimeout(resolve, 75));
    }

    await this.serialize(() => this.withCrossProcessLock(async () => {
      const document = await this.readControlDocument();
      const remaining = document.controls.filter(row => row.leaseId?.toLowerCase() !== control.leaseId?.toLowerCase());
      if (remaining.length !== document.controls.length) {
        await atomicJson(this.controlPath, {
          schemaVersion: 2,
          generation: document.generation + 1,
          controls: remaining
        } satisfies AgentDesktopControlDocument);
      }
    }));
    throw new Error('Agent Desktop native safety guard did not become ready. This lease was revoked instead of running without local safety supervision.');
  }

  async stopControl(leaseId: string): Promise<AgentDesktopStatus> {
    if (!UUID_PATTERN.test(leaseId)) throw new Error('Invalid Agent Desktop lease id.');
    await this.serialize(() => this.withCrossProcessLock(async () => {
      const document = await this.readControlDocument();
      const live = document.controls.find(row => row.leaseId?.toLowerCase() === leaseId.toLowerCase());
      if (!live) return;
      await atomicJson(this.controlPath, {
        schemaVersion: 2,
        generation: document.generation + 1,
        controls: document.controls.filter(row => row !== live)
      } satisfies AgentDesktopControlDocument);
    }));
    return this.status();
  }

  async stopControlForTask(taskId: string): Promise<{ stopped: boolean; leaseId?: string; status: AgentDesktopStatus }> {
    const normalizedTaskId = taskId.trim().toLowerCase();
    if (!TASK_ID_PATTERN.test(normalizedTaskId)) throw new Error('Invalid Agent Desktop task id.');
    let stoppedLeaseId: string | undefined;
    await this.serialize(() => this.withCrossProcessLock(async () => {
      const document = await this.readControlDocument();
      const live = document.controls.find(row => row.taskId === normalizedTaskId && row.leaseId);
      if (!live?.leaseId) return;
      stoppedLeaseId = live.leaseId;
      await atomicJson(this.controlPath, {
        schemaVersion: 2,
        generation: document.generation + 1,
        controls: document.controls.filter(row => row !== live)
      } satisfies AgentDesktopControlDocument);
    }));
    return {
      stopped: Boolean(stoppedLeaseId),
      ...(stoppedLeaseId ? { leaseId: stoppedLeaseId } : {}),
      status: await this.status()
    };
  }

  async isLeaseActive(leaseId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(leaseId)) return false;
    const document = await this.readControlDocument();
    return document.controls.some(row => row.leaseId?.toLowerCase() === leaseId.toLowerCase());
  }

  async assertLease(leaseId: string): Promise<{ binding: AgentDesktopBinding; control: AgentDesktopControlState }> {
    if (!UUID_PATTERN.test(leaseId)) throw new Error('Invalid Agent Desktop lease id.');
    const [bindings, document] = await Promise.all([this.bindings(), this.readControlDocument()]);
    const control = document.controls.find(row => row.leaseId?.toLowerCase() === leaseId.toLowerCase());
    if (!control) throw new Error('Agent Desktop control was revoked or replaced.');
    const binding = control.desktopId
      ? bindings.find(row => row.desktopId.toLowerCase() === control.desktopId!.toLowerCase())
      : bindings[0];
    if (!binding) throw new Error('Agent Desktop binding is missing for the active lease.');
    if (!await this.hudMatches(control)) throw new Error('Agent Desktop safety HUD heartbeat is missing or stale. Control is fail-closed.');
    return { binding, control };
  }

  async assertWindowOnLease(hwnd: number, leaseId: string): Promise<void> {
    const { binding } = await this.assertLease(leaseId);
    const info = await this.native.windowInfo(hwnd);
    if (info.desktopId.toLowerCase() !== binding.desktopId.toLowerCase()) {
      throw new Error('Target window is not on this Agent Desktop.');
    }
    await this.assertLease(leaseId);
  }

  async filterWindowsForLease<T extends { readonly hwnd: number }>(windows: readonly T[], leaseId: string): Promise<T[]> {
    const { binding } = await this.assertLease(leaseId);
    const targetDesktopId = binding.desktopId.toLowerCase();
    const checks = await Promise.all(windows.map(async window => {
      try {
        const info = await this.native.windowInfo(window.hwnd);
        return info.desktopId.toLowerCase() === targetDesktopId;
      } catch {
        return false;
      }
    }));
    await this.assertLease(leaseId);
    return windows.filter((_, index) => checks[index]);
  }

  async placeProcessWindows(processId: number, leaseId: string): Promise<void> {
    const { binding } = await this.assertLease(leaseId);
    const moved = await this.native.moveProcessWindows(processId, binding.desktopId, {
      timeoutMs: 8000,
      showNoActivate: true
    });
    if (moved.moved < 1) throw new Error('Agent Desktop did not move any browser windows.');
    if (moved.windows.some(window => window.desktopId.toLowerCase() !== binding.desktopId.toLowerCase())) {
      throw new Error('Agent Desktop window placement verification failed.');
    }
    await this.assertLease(leaseId);
  }
}
