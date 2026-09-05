import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger } from './audit.js';
import type {
  DesktopCommanderBridge,
  DesktopCommanderToolResult,
  ProcessShell
} from './desktop-commander-bridge.js';
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

function requireSupportedShell(shell: ProcessShell): void {
  const windowsShells: ReadonlySet<ProcessShell> = new Set([
    'auto', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe'
  ]);
  const posixShells: ReadonlySet<ProcessShell> = new Set([
    'auto', 'bash', 'zsh', 'sh', 'fish'
  ]);
  const supported = process.platform === 'win32' ? windowsShells : posixShells;
  if (!supported.has(shell)) {
    throw new PolicyDeniedError(
      `Shell '${shell}' is not supported on ${process.platform === 'win32' ? 'Windows' : 'this POSIX platform'}.`
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

async function terminateVerifiedOwnedProcess(
  bridge: DesktopCommanderBridge,
  sessions: ProcessSessionRegistry,
  pid: number
): Promise<DesktopCommanderToolResult> {
  const listed = await bridge.listProcessSessions();
  if (listed.isError) return listed;
  const activePids = extractListedProcessPids(listed.text);
  sessions.reconcileActivePids(activePids);
  if (!activePids.includes(pid)) {
    return { text: 'Process session is no longer active.', isError: true };
  }

  const terminated = await bridge.forceTerminateProcess(pid);
  if (!terminated.isError) return terminated;

  // Termination can race a process exiting naturally. If Desktop Commander
  // confirms the owned root is gone after the attempt, termination is complete.
  // Descendants use an OS-native ownership boundary: Windows Job Objects on
  // Windows and a dedicated POSIX process group on macOS.
  const after = await bridge.listProcessSessions();
  if (!after.isError) {
    const afterPids = extractListedProcessPids(after.text);
    sessions.reconcileActivePids(afterPids);
    if (!afterPids.includes(pid)) {
      return { text: 'Process session terminated.', isError: false };
    }
  }
  return terminated;
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
      description: 'Start an owned terminal process in full-control or fully-unlocked mode and return an opaque Gateway-owned session ID instead of an OS PID. Prefer shell=auto unless a specific shell is required.',
      inputSchema: z.object({
        command: z.string().min(1).max(32768),
        timeout_ms: z.number().int().min(250).max(30000).optional().default(3000),
        shell: z.enum([
          'auto',
          'cmd', 'cmd.exe',
          'powershell', 'powershell.exe',
          'bash', 'zsh', 'sh', 'fish'
        ]).optional().default('auto').describe(
          'Cross-platform shell selector. Use auto by default. Windows supports cmd/powershell aliases; macOS/POSIX supports bash/zsh/sh/fish.'
        ),
        window_mode: z.enum(['hidden', 'visible']).optional().default('hidden').describe(
          'Process window mode. visible is currently supported on Windows only.'
        ),
        elevation: z.enum(['standard', 'admin']).optional().default('standard').describe(
          'Privilege mode. admin is currently supported on Windows only and requires window_mode=visible.'
        )
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ command, timeout_ms, shell, window_mode, elevation }) => auditedProcessCall(
      audit,
      policy,
      'desktop_start_process',
      undefined,
      'Desktop process start denied or failed',
      async () => {
        requireFullControl(policy);
        requireSupportedShell(shell);
        if (sessions.atCapacity()) {
          await reconcileActiveProcessSessions(bridge, sessions);
        }
        const reservationId = sessions.reserveStart();
        let pid: number | undefined;
        try {
          if ((window_mode === 'visible' || elevation === 'admin') && process.platform !== 'win32') {
            throw new PolicyDeniedError('Visible console and admin elevation modes are supported on Windows only.');
          }
          if (elevation === 'admin' && window_mode !== 'visible') {
            throw new PolicyDeniedError('Admin elevation requires window_mode=visible so Windows can surface UAC and the user can interact.');
          }
          const result = await bridge.startProcess(command, timeout_ms, shell, window_mode, elevation);
          if (result.isError) {
            sessions.releaseStart(reservationId);
            return result;
          }
          pid = extractStartedPid(result.text);
          const sessionId = sessions.registerReserved(reservationId, pid, window_mode);
          const sanitized = sanitizeProcessResult(result, pid, sessionId);
          return window_mode === 'visible'
            ? { ...sanitized, text: sanitized.text + '\\nVisible console opened. Use the console window for interactive input.' }
            : sanitized;
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
        if (sessions.windowMode(session_id) === 'visible') {
          throw new PolicyDeniedError('Visible console sessions accept input from their Windows console, not desktop_interact_process.');
        }
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
          await terminateVerifiedOwnedProcess(bridge, sessions, pid),
          pid,
          session_id
        );
        if (!result.isError) sessions.forget(session_id);
        return result;
      }
    )
  );
}
