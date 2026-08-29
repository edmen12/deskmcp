import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT } from './paths.js';
import type { PermissionProfile } from './desktop-policy.js';

export type AuditOutcome = 'allow' | 'deny' | 'fail';
export type AuditRisk = 'read' | 'write' | 'process';

interface AuditBase {
  readonly timestamp: string;
  readonly requestId: string;
  readonly tool: string;
  readonly risk: AuditRisk;
  readonly profile: PermissionProfile;
  readonly target?: string;
}

interface AuditStart extends AuditBase {
  readonly phase: 'start';
}

interface AuditFinish extends AuditBase {
  readonly phase: 'finish';
  readonly outcome: AuditOutcome;
  readonly durationMs: number;
  readonly errorType?: string;
}
export type AuditRecord = AuditStart | AuditFinish;

export interface AuditOperation {
  readonly requestId: string;
  readonly startedAt: number;
  readonly tool: string;
  readonly risk: AuditRisk;
  readonly profile: PermissionProfile;
  readonly target?: string;
}

export class AuditLogger {
  readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    filePath = process.env.DESKTOP_MCP_AUDIT_LOG
      ?? path.join(PROJECT_ROOT, 'runtime', 'logs', 'audit.jsonl'),
    readonly maxBytes = 10 * 1024 * 1024,
    readonly maxBackups = 4
  ) {
    this.filePath = path.resolve(PROJECT_ROOT, filePath);
    if (!Number.isInteger(maxBytes) || maxBytes < 1024) {
      throw new Error(`Invalid audit rotation size: ${maxBytes}`);
    }
    if (!Number.isInteger(maxBackups) || maxBackups < 1 || maxBackups > 20) {
      throw new Error(`Invalid audit backup count: ${maxBackups}`);
    }
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
  }

  private rotatedPath(index: number): string {
    return `${this.filePath}.${index}`;
  }

  private async rotateIfNeeded(nextBytes: number): Promise<void> {
    let currentBytes = 0;
    try { currentBytes = (await stat(this.filePath)).size; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (currentBytes === 0 || currentBytes + nextBytes <= this.maxBytes) return;

    await rm(this.rotatedPath(this.maxBackups), { force: true });
    for (let index = this.maxBackups - 1; index >= 1; index--) {
      try { await rename(this.rotatedPath(index), this.rotatedPath(index + 1)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try { await rename(this.filePath, this.rotatedPath(1)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async append(record: AuditRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const operation = this.writeChain.then(async () => {
      await this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
      await appendFile(this.filePath, line, 'utf8');
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }
  async begin(
    tool: string,
    risk: AuditRisk,
    profile: PermissionProfile,
    target?: string
  ): Promise<AuditOperation> {
    const operation: AuditOperation = {
      requestId: randomUUID(),
      startedAt: performance.now(),
      tool,
      risk,
      profile,
      ...(target ? { target } : {})
    };
    await this.append({
      timestamp: new Date().toISOString(),
      requestId: operation.requestId,
      tool,
      risk,
      profile,
      ...(target ? { target } : {}),
      phase: 'start'
    });
    return operation;
  }
  async finish(
    operation: AuditOperation,
    outcome: AuditOutcome,
    error?: unknown
  ): Promise<void> {
    const errorType = error instanceof Error
      ? error.name
      : error === undefined ? undefined : typeof error;

    await this.append({
      timestamp: new Date().toISOString(),
      requestId: operation.requestId,
      tool: operation.tool,
      risk: operation.risk,
      profile: operation.profile,
      ...(operation.target ? { target: operation.target } : {}),
      phase: 'finish',
      outcome,
      durationMs: Math.max(0, performance.now() - operation.startedAt),
      ...(errorType ? { errorType } : {})
    });
  }
}
