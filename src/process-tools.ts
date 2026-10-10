import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AgentDesktopManager } from './agent-desktop-state.js';
import type { AuditLogger } from './audit.js';
import type { DesktopBackendBridge, DesktopBackendToolResult } from './desktop-backend-bridge.js';
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

function resultText(result: DesktopBackendToolResult) {
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
  action: () => Promise<DesktopBackendToolResult>
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
      'Process tools require the session-only Full Control or Fully Unlocked profile.'
    );
  }
}

export function requireSupportedProcessPresentation(
  windowMode: 'hidden' | 'visible',
  elevation: 'standard' | 'admin',
  platform = process.platform
): void {
  if ((windowMode === 'visible' || elevation === 'admin') && platform !== 'win32') {
    throw new PolicyDeniedError('Visible console and admin elevation modes are supported on Windows only.');
  }
}

const WINDOWS_LEGACY_FILE_PATH_LIMIT = 259;
const WINDOWS_PATH_HARD_MIN_HEADROOM = 48;
const WINDOWS_PATH_WARNING_HEADROOM = 96;

export function windowsRelativePathBudget(basePath: string): number {
  return WINDOWS_LEGACY_FILE_PATH_LIMIT - basePath.length - 1;
}

function resolveShortTempDirectory(): string {
  const override = process.env.DESKTOP_MCP_SHORT_TEMP_ROOT?.trim();
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new PolicyDeniedError('DESKTOP_MCP_SHORT_TEMP_ROOT must be an absolute path.');
    }
    return path.normalize(override);
  }
  const base = process.env.LOCALAPPDATA?.trim() || os.tmpdir();
  return path.join(base, 'DMC', 't');
}

async function resolveProcessLaunchContext(
  policy: DesktopPolicy,
  cwd: string | undefined,
  tempMode: 'inherit' | 'short' | undefined,
  platform = process.platform
): Promise<{ workingDirectory?: string; tempDirectory?: string; warning?: string }> {
  if (platform !== 'win32') {
    if (cwd || tempMode === 'short') {
      throw new PolicyDeniedError('Process cwd and short temp mode are currently supported on Windows only.');
    }
    return {};
  }

  let workingDirectory: string | undefined;
  let warning: string | undefined;
  if (cwd) {
    workingDirectory = await policy.resolveReadPath(cwd);
    const metadata = await stat(workingDirectory);
    if (!metadata.isDirectory()) {
      throw new PolicyDeniedError(`Process cwd is not a directory: ${workingDirectory}`);
    }
    const headroom = windowsRelativePathBudget(workingDirectory);
    if (headroom < WINDOWS_PATH_HARD_MIN_HEADROOM) {
      throw new PolicyDeniedError(
        `Windows path budget is too small for safe development/test execution: cwd length=${workingDirectory.length}, remaining legacy relative budget=${headroom}. Use a shorter project path.`
      );
    }
    if (headroom < WINDOWS_PATH_WARNING_HEADROOM) {
      warning = `WINDOWS_PATH_BUDGET_WARNING cwd_length=${workingDirectory.length} remaining_relative=${headroom}`;
    }
  }

  const effectiveTempMode = tempMode ?? (workingDirectory ? 'short' : 'inherit');
  if (effectiveTempMode === 'inherit') {
    return {
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(warning ? { warning } : {})
    };
  }

  const tempDirectory = resolveShortTempDirectory();
  const tempHeadroom = windowsRelativePathBudget(tempDirectory);
  if (tempHeadroom < WINDOWS_PATH_HARD_MIN_HEADROOM) {
    throw new PolicyDeniedError(
      `DeskMCP short temp root is still too deep for safe Windows execution: ${tempDirectory}`
    );
  }
  return {
    ...(workingDirectory ? { workingDirectory } : {}),
    tempDirectory,
    ...(warning ? { warning } : {})
  };
}

async function reconcileActiveProcessSessions(
  bridge: DesktopBackendBridge,
  sessions: ProcessSessionRegistry
): Promise<void> {
  const listed = await bridge.listProcessSessions();
  if (listed.isError) return;
  sessions.reconcileActivePids(extractListedProcessPids(listed.text));
}

async function terminateVerifiedOwnedProcess(
  bridge: DesktopBackendBridge,
  sessions: ProcessSessionRegistry,
  pid: number
): Promise<DesktopBackendToolResult> {
  const listed = await bridge.listProcessSessions();
  if (listed.isError) return listed;
  const activePids = extractListedProcessPids(listed.text);
  sessions.reconcileActivePids(activePids);
  if (!activePids.includes(pid)) {
    return { text: 'Process session is no longer active.', isError: true };
  }

  const terminated = await bridge.forceTerminateProcess(pid);
  if (!terminated.isError) return terminated;

  // force_terminate can race a process exiting naturally. If DeskMCP backend
  // confirms the owned root is gone after the attempt, termination is complete.
  // Descendants are owned by DeskMCP.ProcessHost's Windows Job Object and are
  // killed by the kernel when that host/root session closes.
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

function resultShowsCompletedProcess(result: DesktopBackendToolResult): boolean {
  return /Process completed with exit code/i.test(result.text);
}

function resultShowsMissingActiveProcess(result: DesktopBackendToolResult): boolean {
  return /No active session found|No active process found|No session found/i.test(result.text);
}

function sanitizeProcessResult(
  result: DesktopBackendToolResult,
  pid: number,
  sessionId: string
): DesktopBackendToolResult {
  const text = redactPid(result.text, pid, sessionId)
    .replace(`Process started with PID ${sessionId}`, `Process session started: ${sessionId}`);
  return { text, isError: result.isError };
}

const sessionSchema = z.string().uuid();

// A live Agent lease is a hard launch boundary. A hidden shell can still
// spawn visible children, so window_mode='hidden' is not an exemption.
export async function assertAgentDesktopProcessLaunchScope(
  agentDesktop: AgentDesktopManager | undefined,
  leaseId: string | undefined
): Promise<void> {
  if (!leaseId && agentDesktop && await agentDesktop.hasActiveControls()) {
    throw new PolicyDeniedError(
      'An Agent Desktop lease is active: process launch requires its agent_desktop_lease_id. ' +
      'Unscoped commands may open windows on Desktop 1 and are blocked until the lease stops.'
    );
  }
}

export function registerProcessTools(
  server: McpServer,
  bridge: DesktopBackendBridge,
  policy: DesktopPolicy,
  audit: AuditLogger,
  sessions: ProcessSessionRegistry,
  agentDesktop?: AgentDesktopManager
): void {
  server.registerTool(
    'desktop_start_process',
    {
      title: 'Start Owned Desktop Process',
      description: 'Start a terminal process in the session-only Full Control or Fully Unlocked profile and return an opaque Gateway-owned session ID instead of a Windows PID. For Windows project development and test commands, pass cwd instead of embedding cd/Set-Location in command: DeskMCP verifies the project directory, applies a legacy path-budget guard, and defaults TEMP/TMP to a short internal path to reduce MAX_PATH failures. When any Agent Desktop control lease is active, agent_desktop_lease_id is mandatory for every process launch (even a hidden shell). DeskMCP creates the process inside an isolated Win32 Desktop Object, NOT the real Windows Win+Tab virtual Desktop 2. A lease-bound process launch therefore does NOT prove that any window is visible on virtual Desktop 2; use the separate native VDA inventory and validated virtual-desktop placement before making that claim. It fails closed if the lease is invalid or placement verification fails. process_lifetime=job is only allowed with Agent Desktop and is intended for GUI launchers whose shell exits while owned descendants remain alive.',
      inputSchema: z.object({
        command: z.string().min(1).max(32768),
        timeout_ms: z.number().int().min(250).max(30000).optional().default(3000),
        shell: z.enum(['powershell.exe', 'cmd.exe']).optional(),
        cwd: z.string().min(1).max(4096).optional().describe(
          'Windows project working directory. DeskMCP resolves and verifies it before launch and applies a legacy path-budget guard.'
        ),
        temp_mode: z.enum(['inherit', 'short']).optional().describe(
          'Windows TEMP/TMP behavior. With cwd, the default is short; otherwise the default is inherit.'
        ),
        window_mode: z.enum(['hidden', 'visible']).optional().default('hidden').describe(
          'Controls whether the CMD/PowerShell console itself is hidden or visible. It does not control UAC.'
        ),
        elevation: z.enum(['standard', 'admin']).optional().default('standard').describe(
          'Controls process privilege. admin uses the standard Windows UAC prompt and is valid with either hidden or visible window mode.'
        ),
        process_lifetime: z.enum(['root', 'job']).optional().default('root').describe(
          'root ends owned descendants when the shell exits. job keeps the owned Windows job alive until all descendants exit and is only allowed with Agent Desktop.'
        ),
        agent_desktop_lease_id: z.string().uuid().optional().describe(
          'Bind this owned process tree to an active Agent Desktop lease. On Windows this launches inside a private Win32 Desktop Object; it does not place a window on the human-visible Win+Tab virtual Desktop 2. Never treat this tool result as real Desktop2 GUI placement proof.'
        )
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ command, timeout_ms, shell, cwd, temp_mode, window_mode, elevation, process_lifetime, agent_desktop_lease_id }) => auditedProcessCall(
      audit,
      policy,
      'desktop_start_process',
      agent_desktop_lease_id ? `agent-desktop:${agent_desktop_lease_id}` : undefined,
      'Desktop process start denied or failed',
      async () => {
        requireFullControl(policy);
        await assertAgentDesktopProcessLaunchScope(agentDesktop, agent_desktop_lease_id);
        if (process_lifetime === 'job' && !agent_desktop_lease_id) {
          throw new PolicyDeniedError('process_lifetime=job is only supported with agent_desktop_lease_id so owned GUI descendants remain scoped to an Agent Desktop lease.');
        }
        let desktopObjectName: string | undefined;
        if (agent_desktop_lease_id) {
          if (!agentDesktop) throw new PolicyDeniedError('Agent Desktop runtime is unavailable.');
          if (elevation === 'admin') {
            throw new PolicyDeniedError('Administrator process launch is not supported inside Agent Desktop background control. Stop Agent Control before requesting a user-desktop elevation.');
          }
          desktopObjectName = await agentDesktop.desktopObjectNameForLease(agent_desktop_lease_id);
        }
        requireSupportedProcessPresentation(window_mode, elevation);
        const launchContext = await resolveProcessLaunchContext(policy, cwd, temp_mode);
        if (sessions.atCapacity()) {
          await reconcileActiveProcessSessions(bridge, sessions);
        }
        const reservationId = sessions.reserveStart();
        let pid: number | undefined;
        let sessionId: string | undefined;
        try {
          const result = await bridge.startProcess(
            command,
            timeout_ms,
            shell,
            window_mode,
            elevation,
            process_lifetime,
            launchContext.workingDirectory,
            launchContext.tempDirectory,
            desktopObjectName
          );
          if (result.isError) {
            sessions.releaseStart(reservationId);
            return result;
          }
          pid = extractStartedPid(result.text);
          sessionId = sessions.registerReserved(reservationId, pid, window_mode);
          if (agent_desktop_lease_id) await agentDesktop!.assertLease(agent_desktop_lease_id);
          const sanitized = sanitizeProcessResult(result, pid, sessionId);
          let placed = agent_desktop_lease_id
            ? sanitized.text + '\\nOwned process tree launched inside the active Agent Desktop isolated desktop object.'
            : sanitized.text;
          if (launchContext.warning) placed += `\\n${launchContext.warning}`;
          if (launchContext.tempDirectory) placed += '\\nWindows short TEMP/TMP enabled for this owned process.';
          return window_mode === 'visible'
            ? { ...sanitized, text: placed + '\\nVisible console opened. Use the console window for interactive input.' }
            : { ...sanitized, text: placed };
        } catch (error) {
          sessions.releaseStart(reservationId);
          if (sessionId) sessions.forget(sessionId);
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
