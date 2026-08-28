import { appendFile, mkdir } from 'node:fs/promises';
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

  constructor(filePath = process.env.DESKTOP_MCP_AUDIT_LOG
    ?? path.join(PROJECT_ROOT, 'runtime', 'logs', 'audit.jsonl')) {
    this.filePath = path.resolve(PROJECT_ROOT, filePath);
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
  }

  private async append(record: AuditRecord): Promise<void> {
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
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
