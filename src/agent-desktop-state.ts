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

export interface AgentDesktopControlState {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly active: boolean;
  readonly leaseId?: string;
  readonly taskLabel?: string;
  readonly taskId?: string;
  readonly startedAtUtc?: string;
  readonly revokedAtUtc?: string;
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

export interface AgentDesktopStatus {
  readonly configured: boolean;
  readonly binding?: AgentDesktopBinding;
  readonly control: AgentDesktopControlState;
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

function validControl(value: unknown): value is AgentDesktopControlState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.generation) || Number(row.generation) < 0 || typeof row.active !== 'boolean') return false;
  if (row.active) {
    if (typeof row.leaseId !== 'string' || !UUID_PATTERN.test(row.leaseId)) return false;
    if (!validIso(row.startedAtUtc)) return false;
  }
  return (row.taskLabel === undefined || typeof row.taskLabel === 'string')
    && (row.taskId === undefined || (typeof row.taskId === 'string' && TASK_ID_PATTERN.test(row.taskId)));
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
    const current = await this.readControl();
    if (!current) {
      await atomicJson(this.controlPath, { schemaVersion: 1, generation: 0, active: false } satisfies AgentDesktopControlState);
      return;
    }
    if (current.active) {
      await atomicJson(this.controlPath, {
        schemaVersion: 1,
        generation: current.generation + 1,
        active: false,
        revokedAtUtc: new Date().toISOString()
      } satisfies AgentDesktopControlState);
      await rm(this.hudPath, { force: true }).catch(() => undefined);
    }
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

  async binding(): Promise<AgentDesktopBinding | undefined> {
    const raw = await readJson(this.configPath);
    if (raw === undefined) return undefined;
    if (!validBinding(raw)) throw new Error('Agent Desktop binding state is invalid. Re-bind it from the DeskMCP Control Panel.');
    return raw;
  }

  private async readControl(): Promise<AgentDesktopControlState | undefined> {
    const raw = await readJson(this.controlPath);
    if (raw === undefined) return undefined;
    if (!validControl(raw)) throw new Error('Agent Desktop control state is invalid.');
    return raw;
  }

  private async hud(): Promise<AgentDesktopHudState | undefined> {
    const raw = await readJson(this.hudPath);
    if (raw === undefined) return undefined;
    if (!validHud(raw)) return undefined;
    return raw;
  }

  private async hudMatches(control: AgentDesktopControlState): Promise<boolean> {
    if (!control.active || !control.leaseId) return false;
    const hud = await this.hud();
    if (!hud || hud.leaseId !== control.leaseId || hud.generation !== control.generation || !hud.armed) return false;
    const age = Date.now() - Date.parse(hud.heartbeatAtUtc);
    return age >= 0 && age <= HUD_HEARTBEAT_MAX_AGE_MS;
  }

  async status(): Promise<AgentDesktopStatus> {
    const [binding, control] = await Promise.all([
      this.binding(),
      this.readControl()
    ]);
    const effective = control ?? { schemaVersion: 1, generation: 0, active: false } satisfies AgentDesktopControlState;
    const hudReady = await this.hudMatches(effective);
    const hud = hudReady ? await this.hud() : undefined;
    return {
      configured: Boolean(binding),
      ...(binding ? { binding } : {}),
      control: effective,
      hud_ready: hudReady,
      hud_visible: Boolean(hudReady && hud?.visible)
    };
  }

  async startControl(taskLabel?: string, taskId?: string): Promise<AgentDesktopStatus> {
    const label = taskLabel?.trim();
    const normalizedTaskId = taskId?.trim().toLowerCase();
    if (label && label.length > 200) throw new Error('Agent Desktop task label is too long.');
    if (normalizedTaskId && !TASK_ID_PATTERN.test(normalizedTaskId)) throw new Error('Invalid Agent Desktop task id.');
    const binding = await this.binding();
    if (!binding) throw new Error('Agent Desktop is not bound. Switch to the desktop you want to dedicate to the agent and bind it in DeskMCP Settings.');
    await this.native.info();

    const control = await this.serialize(() => this.withCrossProcessLock(async () => {
      const existing = await this.readControl() ?? { schemaVersion: 1, generation: 0, active: false } satisfies AgentDesktopControlState;
      if (existing.active) throw new Error('Agent Desktop is already under agent control. Stop the existing control lease first.');
      const next: AgentDesktopControlState = {
        schemaVersion: 1,
        generation: existing.generation + 1,
        active: true,
        leaseId: randomUUID(),
        ...(label ? { taskLabel: label } : {}),
        ...(normalizedTaskId ? { taskId: normalizedTaskId } : {}),
        startedAtUtc: new Date().toISOString()
      };
      await atomicJson(this.controlPath, next);
      return next;
    }));

    const deadline = Date.now() + HUD_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.hudMatches(control)) return this.status();
      await new Promise(resolve => setTimeout(resolve, 75));
    }

    await this.serialize(() => this.withCrossProcessLock(async () => {
      const live = await this.readControl();
      if (live?.active && live.leaseId === control.leaseId && live.generation === control.generation) {
        await atomicJson(this.controlPath, {
          schemaVersion: 1,
          generation: live.generation + 1,
          active: false,
          revokedAtUtc: new Date().toISOString()
        } satisfies AgentDesktopControlState);
      }
    }));
    throw new Error('Agent Desktop native safety guard did not become ready. Control was revoked instead of running without local safety supervision.');
  }

  async stopControl(leaseId: string): Promise<AgentDesktopStatus> {
    if (!UUID_PATTERN.test(leaseId)) throw new Error('Invalid Agent Desktop lease id.');
    await this.serialize(() => this.withCrossProcessLock(async () => {
      const live = await this.readControl();
      if (!live?.active) return;
      if (live.leaseId !== leaseId) throw new Error('Agent Desktop lease does not match the active control session.');
      await atomicJson(this.controlPath, {
        schemaVersion: 1,
        generation: live.generation + 1,
        active: false,
        revokedAtUtc: new Date().toISOString()
      } satisfies AgentDesktopControlState);
    }));
    return this.status();
  }

  async stopControlForTask(taskId: string): Promise<{ stopped: boolean; leaseId?: string; status: AgentDesktopStatus }> {
    const normalizedTaskId = taskId.trim().toLowerCase();
    if (!TASK_ID_PATTERN.test(normalizedTaskId)) throw new Error('Invalid Agent Desktop task id.');
    let stoppedLeaseId: string | undefined;
    await this.serialize(() => this.withCrossProcessLock(async () => {
      const live = await this.readControl();
      if (!live?.active || live.taskId !== normalizedTaskId || !live.leaseId) return;
      stoppedLeaseId = live.leaseId;
      await atomicJson(this.controlPath, {
        schemaVersion: 1,
        generation: live.generation + 1,
        active: false,
        revokedAtUtc: new Date().toISOString()
      } satisfies AgentDesktopControlState);
    }));
    return {
      stopped: Boolean(stoppedLeaseId),
      ...(stoppedLeaseId ? { leaseId: stoppedLeaseId } : {}),
      status: await this.status()
    };
  }

  async assertLease(leaseId: string): Promise<{ binding: AgentDesktopBinding; control: AgentDesktopControlState }> {
    if (!UUID_PATTERN.test(leaseId)) throw new Error('Invalid Agent Desktop lease id.');
    const [binding, control] = await Promise.all([this.binding(), this.readControl()]);
    if (!binding) throw new Error('Agent Desktop binding is missing.');
    if (!control?.active || control.leaseId !== leaseId) throw new Error('Agent Desktop control was revoked or replaced.');
    if (!await this.hudMatches(control)) throw new Error('Agent Desktop safety HUD heartbeat is missing or stale. Control is fail-closed.');
    return { binding, control };
  }

  async assertWindowOnLease(hwnd: number, leaseId: string): Promise<void> {
    const { binding } = await this.assertLease(leaseId);
    const info = await this.native.windowInfo(hwnd);
    if (info.desktopId.toLowerCase() !== binding.desktopId.toLowerCase()) {
      throw new Error('Target window is not on the bound Agent Desktop.');
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
