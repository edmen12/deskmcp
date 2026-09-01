import { randomUUID } from 'node:crypto';
import { PolicyDeniedError } from './desktop-policy.js';

interface ProcessSession {
  readonly id: string;
  readonly pid: number;
  readonly createdAt: number;
}

function defaultProcessAliveCheck(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH';
  }
}

export class ProcessSessionRegistry {
  private readonly sessions = new Map<string, ProcessSession>();

  constructor(
    readonly maxSessions = 32,
    private readonly isProcessAlive: (pid: number) => boolean = defaultProcessAliveCheck
  ) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 1024) {
      throw new Error(`Invalid process session limit: ${maxSessions}`);
    }
  }

  pruneDeadSessions(): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (this.isProcessAlive(session.pid)) continue;
      this.sessions.delete(id);
      removed += 1;
    }
    return removed;
  }

  assertCapacity(): void {
    this.pruneDeadSessions();
    if (this.sessions.size >= this.maxSessions) {
      throw new PolicyDeniedError(`Process session limit reached (${this.maxSessions}). Terminate an owned session before starting another.`);
    }
  }

  register(pid: number): string {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Invalid process PID: ${pid}`);
    }
    this.assertCapacity();
    const id = randomUUID();
    this.sessions.set(id, { id, pid, createdAt: Date.now() });
    return id;
  }

  resolve(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new PolicyDeniedError('Unknown or unowned process session.');
    }
    if (!this.isProcessAlive(session.pid)) {
      this.sessions.delete(sessionId);
      throw new PolicyDeniedError('Process session has already exited.');
    }
    return session.pid;
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  size(): number {
    return this.sessions.size;
  }

  ownedSessions(): ReadonlyArray<{ id: string; pid: number }> {
    return [...this.sessions.values()].map(session => ({
      id: session.id,
      pid: session.pid
    }));
  }
  clear(): void {
    this.sessions.clear();
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

export function redactPid(text: string, pid: number, sessionId: string): string {
  const escaped = String(pid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\b${escaped}\\b`, 'g'), sessionId);
}
