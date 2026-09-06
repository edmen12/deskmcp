import { randomUUID } from 'node:crypto';
import type { ComputerWindow } from './computer-use-backend.js';

interface WindowRecord {
  readonly id: string;
  readonly hwnd: number;
  readonly processId: number;
  readonly processName: string;
  readonly className?: string;
  lastSeenAt: number;
}

const WINDOW_TTL_MS = 5 * 60 * 1000;
const MAX_WINDOW_RECORDS = 256;

function identity(window: Pick<ComputerWindow, 'hwnd' | 'processId' | 'processName' | 'className'>): string {
  return `${window.hwnd}:${window.processId}:${window.processName}:${window.className ?? ''}`;
}

export class ComputerWindowRegistry {
  private readonly byId = new Map<string, WindowRecord>();
  private readonly byIdentity = new Map<string, string>();

  issue(window: ComputerWindow): string {
    this.prune();
    const key = identity(window);
    const existingId = this.byIdentity.get(key);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing) {
        existing.lastSeenAt = Date.now();
        return existing.id;
      }
    }

    const record: WindowRecord = {
      id: randomUUID(),
      hwnd: window.hwnd,
      processId: window.processId,
      processName: window.processName,
      ...(window.className ? { className: window.className } : {}),
      lastSeenAt: Date.now()
    };
    this.byId.set(record.id, record);
    this.byIdentity.set(key, record.id);
    this.prune();
    return record.id;
  }

  resolve(windowId: string, liveWindows: readonly ComputerWindow[]): ComputerWindow {
    this.prune();
    const record = this.byId.get(windowId);
    if (!record) throw new Error('Computer window capability is stale or unknown. Refresh desktop_ui_windows or desktop_ui_snapshot.');
    const live = liveWindows.find(window => (
      window.hwnd === record.hwnd &&
      window.processId === record.processId &&
      window.processName === record.processName &&
      (record.className === undefined || window.className === record.className)
    ));
    if (!live) {
      this.revoke(record);
      throw new Error('Target window changed or closed. Refresh the window list before acting.');
    }
    record.lastSeenAt = Date.now();
    return live;
  }

  private revoke(record: WindowRecord): void {
    this.byId.delete(record.id);
    this.byIdentity.delete(identity(record));
  }

  private prune(): void {
    const cutoff = Date.now() - WINDOW_TTL_MS;
    for (const record of this.byId.values()) {
      if (record.lastSeenAt < cutoff) this.revoke(record);
    }
    if (this.byId.size <= MAX_WINDOW_RECORDS) return;
    const oldest = [...this.byId.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    for (const record of oldest.slice(0, this.byId.size - MAX_WINDOW_RECORDS)) this.revoke(record);
  }
}

export class ComputerUseCoordinator {
  private tail: Promise<void> = Promise.resolve();

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.catch(() => undefined).then(() => turn);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
    }
  }
}
