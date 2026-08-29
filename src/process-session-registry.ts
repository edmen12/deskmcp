import { randomUUID } from 'node:crypto';
import { PolicyDeniedError } from './desktop-policy.js';

interface ProcessSession {
  readonly id: string;
  readonly pid: number;
  readonly createdAt: number;
}

export class ProcessSessionRegistry {
  private readonly sessions = new Map<string, ProcessSession>();

  constructor(readonly maxSessions = 32) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 1024) {
      throw new Error(`Invalid process session limit: ${maxSessions}`);
    }
  }

  register(pid: number): string {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Invalid process PID: ${pid}`);
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new PolicyDeniedError(`Process session limit reached (${this.maxSessions}). Terminate an owned session before starting another.`);
    }
    const id = randomUUID();
    this.sessions.set(id, { id, pid, createdAt: Date.now() });
    return id;
  }

  resolve(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new PolicyDeniedError('Unknown or unowned process session.');
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
