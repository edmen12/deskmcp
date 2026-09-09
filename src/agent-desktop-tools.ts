import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger } from './audit.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';
import type { AgentDesktopManager } from './agent-desktop-state.js';
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
  taskStore?: TaskContextStore
): void {
  server.registerTool(
    'desktop_agent_desktop',
    {
      title: 'Manage Agent Desktop',
      description: 'Start, inspect, or stop a user-bound Agent Desktop control lease. A native blue safety HUD must be visible and heartbeating before control is granted. Start may bind the lease to a verified Task Room task; completing that task automatically revokes control and closes DeskMCP browser sessions owned by the lease. Binding the desktop itself is a local user action in the DeskMCP Control Panel and cannot be performed by an agent.',
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
          result = await manager.stopControl(lease_id);
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
