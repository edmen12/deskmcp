import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger } from './audit.js';
import type { DesktopCommanderBridge, DesktopCommanderToolResult } from './desktop-commander-bridge.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';
import {
  extractListedProcessPids,
  extractStartedPid,
  ProcessSessionRegistry,
  redactPid
} from './process-session-registry.js';

function failure(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: `${prefix}: ${message}` }],
    isError: true as const
  };
}

function resultText(result: DesktopCommanderToolResult) {
  return {
    content: [{ type: 'text' as const, text: result.text }],
    ...(result.isError ? { isError: true as const } : {})
  };
}

async function auditedProcessCall(
  audit: AuditLogger,
  policy: DesktopPolicy,
  tool: string,
  target: string | undefined,
  prefix: string,
  action: () => Promise<DesktopCommanderToolResult>
) {
  let operation;
  try {
    operation = await audit.begin(tool, 'process', policy.profile, target);
  } catch (error) {
    return failure('Audit start failed', error);
  }

  try {
    const result = await action();
    await audit.finish(operation, result.isError ? 'fail' : 'allow',
      result.isError ? new Error('DownstreamToolError') : undefined);
    return resultText(result);
  } catch (error) {
    const outcome = error instanceof PolicyDeniedError ? 'deny' : 'fail';
    try {
      await audit.finish(operation, outcome, error);
    } catch (auditError) {
      return failure('Audit finalization failed', auditError);
    }
    return failure(prefix, error);
  }
}

function requireFullControl(policy: DesktopPolicy): void {
  if (policy.profile !== 'full-control' && policy.profile !== 'fully-unlocked') {
    throw new PolicyDeniedError(
      'Process tools require DESKTOP_MCP_PROFILE=full-control or fully-unlocked.'
    );
  }
}

async function reconcileActiveProcessSessions(
  bridge: DesktopCommanderBridge,
  sessions: ProcessSessionRegistry
): Promise<void> {
  const listed = await bridge.listProcessSessions();
  if (listed.isError) return;
  sessions.reconcileActivePids(extractListedProcessPids(listed.text));
}

function resultShowsCompletedProcess(result: DesktopCommanderToolResult): boolean {
  return /Process completed with exit code/i.test(result.text);
}

function resultShowsMissingActiveProcess(result: DesktopCommanderToolResult): boolean {
  return /No active session found|No active process found|No session found/i.test(result.text);
}

function sanitizeProcessResult(
  result: DesktopCommanderToolResult,
  pid: number,
  sessionId: string
): DesktopCommanderToolResult {
  const text = redactPid(result.text, pid, sessionId)
    .replace(`Process started with PID ${sessionId}`, `Process session started: ${sessionId}`);
  return { text, isError: result.isError };
}

const sessionSchema = z.string().uuid();

export function registerProcessTools(
  server: McpServer,
  bridge: DesktopCommanderBridge,
  policy: DesktopPolicy,
  audit: AuditLogger,
  sessions: ProcessSessionRegistry
): void {
  server.registerTool(
    'desktop_start_process',
    {
      title: 'Start Owned Desktop Process',
      description: 'Start a terminal process in full-control or fully-unlocked mode and return an opaque Gateway-owned session ID instead of a Windows PID.',
      inputSchema: z.object({
        command: z.string().min(1).max(32768),
        timeout_ms: z.number().int().min(250).max(30000).optional().default(3000),
        shell: z.enum(['powershell.exe', 'cmd.exe']).optional()
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ command, timeout_ms, shell }) => auditedProcessCall(
      audit,
      policy,
      'desktop_start_process',
      undefined,
      'Desktop process start denied or failed',
      async () => {
        requireFullControl(policy);
        if (sessions.atCapacity()) {
          await reconcileActiveProcessSessions(bridge, sessions);
        }
        const reservationId = sessions.reserveStart();
        let pid: number | undefined;
        try {
          const result = await bridge.startProcess(command, timeout_ms, shell);
          if (result.isError) {
            sessions.releaseStart(reservationId);
            return result;
          }
          pid = extractStartedPid(result.text);
          const sessionId = sessions.registerReserved(reservationId, pid);
          return sanitizeProcessResult(result, pid, sessionId);
        } catch (error) {
          sessions.releaseStart(reservationId);
          if (pid !== undefined) {
            await bridge.forceTerminateProcess(pid).catch(() => undefined);
          }
          throw error;
        }
      }
    )
  );

  server.registerTool(
    'desktop_read_process',
    {
      title: 'Read Owned Desktop Process',
      description: 'Read output only from a process session started by this Gateway.',
      inputSchema: z.object({
        session_id: sessionSchema,
        timeout_ms: z.number().int().min(0).max(30000).optional().default(1000),
        offset: z.number().int().min(-100000).max(100000).optional().default(0),
        length: z.number().int().min(1).max(5000).optional().default(1000)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ session_id, timeout_ms, offset, length }) => auditedProcessCall(
      audit,
      policy,
      'desktop_read_process',
      session_id,
      'Desktop process read denied or failed',
      async () => {
        requireFullControl(policy);
        const pid = sessions.resolve(session_id);
        const raw = await bridge.readProcessOutput(pid, timeout_ms, offset, length);
        if (resultShowsCompletedProcess(raw) || resultShowsMissingActiveProcess(raw)) {
          sessions.markInactive(session_id);
        }
        return sanitizeProcessResult(raw, pid, session_id);
      }
    )
  );

  server.registerTool(
    'desktop_interact_process',
    {
      title: 'Interact With Owned Desktop Process',
      description: 'Send input only to a process session started by this Gateway.',
      inputSchema: z.object({
        session_id: sessionSchema,
        input: z.string().max(65536),
        timeout_ms: z.number().int().min(0).max(30000).optional().default(8000),
        wait_for_prompt: z.boolean().optional().default(true)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ session_id, input, timeout_ms, wait_for_prompt }) => auditedProcessCall(
      audit,
      policy,
      'desktop_interact_process',
      session_id,
      'Desktop process interaction denied or failed',
      async () => {
        requireFullControl(policy);
        const pid = sessions.resolve(session_id);
        const raw = await bridge.interactWithProcess(pid, input, timeout_ms, wait_for_prompt);
        if (resultShowsMissingActiveProcess(raw)) sessions.markInactive(session_id);
        return sanitizeProcessResult(raw, pid, session_id);
      }
    )
  );

  server.registerTool(
    'desktop_terminate_process',
    {
      title: 'Terminate Owned Desktop Process',
      description: 'Force-terminate only a process session started by this Gateway.',
      inputSchema: z.object({ session_id: sessionSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ session_id }) => auditedProcessCall(
      audit,
      policy,
      'desktop_terminate_process',
      session_id,
      'Desktop process termination denied or failed',
      async () => {
        requireFullControl(policy);
        const pid = sessions.resolve(session_id);
        const result = sanitizeProcessResult(
          await bridge.forceTerminateProcess(pid),
          pid,
          session_id
        );
        if (!result.isError) sessions.forget(session_id);
        return result;
      }
    )
  );
}
