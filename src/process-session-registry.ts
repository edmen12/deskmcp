import { randomUUID } from 'node:crypto';
import { PolicyDeniedError } from './desktop-policy.js';

interface ProcessSession {
  readonly id: string;
  readonly pid: number;
  readonly createdAt: number;
  active: boolean;
}

export class ProcessSessionRegistry {
  private readonly sessions = new Map<string, ProcessSession>();
  private readonly startReservations = new Set<string>();

  constructor(
    readonly maxSessions = 32,
    readonly maxTrackedSessions = 128
  ) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 1024) {
      throw new Error(`Invalid process session limit: ${maxSessions}`);
    }
    if (
      !Number.isInteger(maxTrackedSessions)
      || maxTrackedSessions < maxSessions
      || maxTrackedSessions > 4096
    ) {
      throw new Error(`Invalid tracked process session limit: ${maxTrackedSessions}`);
    }
  }

  private pruneInactiveHistory(): number {
    let removed = 0;
    if (this.sessions.size <= this.maxTrackedSessions) return removed;

    const inactive = [...this.sessions.values()]
      .filter(session => !session.active)
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const session of inactive) {
      if (this.sessions.size <= this.maxTrackedSessions) break;
      this.sessions.delete(session.id);
      removed += 1;
    }
    return removed;
  }

  reconcileActivePids(activePids: Iterable<number>): number {
    const active = new Set(activePids);
    let changed = 0;
    for (const session of this.sessions.values()) {
      const next = active.has(session.pid);
      if (next === session.active) continue;
      session.active = next;
      changed += 1;
    }
    this.pruneInactiveHistory();
    return changed;
  }

  assertCapacity(): void {
    if (this.activeSize() + this.startReservations.size >= this.maxSessions) {
      throw new PolicyDeniedError(
        `Process session limit reached (${this.maxSessions}). Terminate an owned session before starting another.`
      );
    }
  }

  atCapacity(): boolean {
    return this.activeSize() + this.startReservations.size >= this.maxSessions;
  }

  reserveStart(): string {
    this.assertCapacity();
    const reservationId = randomUUID();
    this.startReservations.add(reservationId);
    return reservationId;
  }

  releaseStart(reservationId: string): void {
    this.startReservations.delete(reservationId);
  }

  registerReserved(reservationId: string, pid: number): string {
    if (!this.startReservations.has(reservationId)) {
      throw new Error('Unknown process start reservation.');
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      this.startReservations.delete(reservationId);
      throw new Error(`Invalid process PID: ${pid}`);
    }
    this.startReservations.delete(reservationId);

    // Desktop Commander identifies terminal sessions by the OS PID. Windows may
    // eventually reuse a PID after a completed process exits. Invalidate every
    // older opaque capability for that PID before attaching the PID to a new
    // process so an old session_id can never target a later process instance.
    for (const [existingId, existing] of this.sessions) {
      if (existing.pid === pid) this.sessions.delete(existingId);
    }

    const id = randomUUID();
    this.sessions.set(id, { id, pid, createdAt: Date.now(), active: true });
    this.pruneInactiveHistory();
    return id;
  }

  register(pid: number): string {
    const reservationId = this.reserveStart();
    return this.registerReserved(reservationId, pid);
  }

  resolve(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new PolicyDeniedError('Unknown or unowned process session.');
    }
    return session.pid;
  }

  markInactive(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.active = false;
    this.pruneInactiveHistory();
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  isActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.active === true;
  }

  size(): number {
    return this.sessions.size;
  }

  activeSize(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.active) count += 1;
    }
    return count;
  }

  pendingSize(): number {
    return this.startReservations.size;
  }

  ownedSessions(): ReadonlyArray<{ id: string; pid: number; active: boolean }> {
    return [...this.sessions.values()].map(session => ({
      id: session.id,
      pid: session.pid,
      active: session.active
    }));
  }

  clear(): void {
    this.sessions.clear();
    this.startReservations.clear();
  }
}

export function extractStartedPid(text: string): number {
  const match = text.match(/Process started with PID\s+(\d+)/i);
  if (!match) throw new Error('Desktop Commander start_process response did not include a PID.');
  const pid = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('Desktop Commander returned an invalid PID.');
  }
  return pid;
}

export function extractListedProcessPids(text: string): number[] {
  const pids: number[] = [];
  for (const match of text.matchAll(/\bPID:\s*(\d+)\b/gi)) {
    const pid = Number.parseInt(match[1] ?? '', 10);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return [...new Set(pids)];
}

export function redactPid(text: string, pid: number, sessionId: string): string {
  const escaped = String(pid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\b${escaped}\\b`, 'g'), sessionId);
}
