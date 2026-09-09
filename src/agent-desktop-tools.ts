import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger } from './audit.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';
import type { AgentDesktopManager } from './agent-desktop-state.js';
import type { BrowserRuntime } from './browser-runtime.js';
import { type TaskContextStore, workspaceFingerprint } from './task-context.js';

function failure(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: `${prefix}: ${message}` }],
    isError: true as const
  };
}

export function registerAgentDesktopTools(
  server: McpServer,
  policy: DesktopPolicy,
  audit: AuditLogger,
  manager: AgentDesktopManager,
  taskStore?: TaskContextStore,
  browser?: BrowserRuntime
): void {
  server.registerTool(
    'desktop_agent_desktop',
    {
      title: 'Manage Agent Desktop',
      description: 'Start, inspect, or stop a user-bound Agent Desktop control lease. DeskMCP allocates the first free desktop from the locally bound Agent Desktop pool, so multiple agents can control different virtual desktops concurrently. A native blue safety HUD must be heartbeating before control is granted. Browser sessions bound to a lease stay open for the lifetime of that Agent Control lease and are closed only when that lease exits or is revoked. Binding desktops is a local user action in the DeskMCP Control Panel.',
      inputSchema: z.object({
        action: z.enum(['status', 'start', 'stop']),
        lease_id: z.string().uuid().optional(),
        task_label: z.string().min(1).max(200).optional(),
        task_id: z.string().max(64).optional(),
        context_handle: z.string().max(256).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ action, lease_id, task_label, task_id, context_handle }) => {
      let operation;
      try {
        operation = await audit.begin('desktop_agent_desktop', 'computer', policy.profile, action);
      } catch (error) {
        return failure('Audit start failed', error);
      }
      try {
        policy.assertCanUseComputer();
        let result;
        if (action === 'status') result = await manager.status();
        else if (action === 'start') {
          let linkedTaskId: string | undefined;
          let effectiveLabel = task_label;
          if (task_id || context_handle) {
            if (!task_id || !context_handle) {
              throw new PolicyDeniedError('Task-linked Agent Desktop start requires both task_id and context_handle.');
            }
            if (!taskStore) throw new Error('Recoverable Task Rooms are unavailable.');
            const task = await taskStore.getTask(context_handle, workspaceFingerprint(policy.allowedRoots), task_id);
            if (task.status !== 'active') throw new Error(`Agent Desktop can only bind to an active task, got ${task.status}.`);
            linkedTaskId = task.id;
            effectiveLabel ??= task.title;
          }
          result = await manager.startControl(effectiveLabel, linkedTaskId);
        } else {
          if (!lease_id) throw new PolicyDeniedError('Stopping Agent Desktop control requires the active lease_id.');
          const status = await manager.stopControl(lease_id);
          let browserCleanup: Record<string, unknown> | undefined;
          if (browser) {
            try {
              const cleanup = await browser.closeAgentDesktopLease(lease_id);
              browserCleanup = { closed_sessions: cleanup.closed_sessions };
            } catch (error) {
              browserCleanup = { cleanup_error: error instanceof Error ? error.message : String(error) };
            }
          }
          result = { ...status, ...(browserCleanup ? { browser_cleanup: browserCleanup } : {}) };
        }
        await audit.finish(operation, 'allow');
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const outcome = error instanceof PolicyDeniedError ? 'deny' : 'fail';
        try { await audit.finish(operation, outcome, error); }
        catch (auditError) { return failure('Audit finalization failed', auditError); }
        return failure('Agent Desktop denied or failed', error);
      }
    }
  );
}
