import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger } from './audit.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';
import type { AgentDesktopManager, AgentDesktopStatus } from './agent-desktop-state.js';
import { type TaskContextStore, workspaceFingerprint } from './task-context.js';

function failure(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: `${prefix}: ${message}` }],
    isError: true as const
  };
}

function poolView(status: AgentDesktopStatus) {
  return {
    configured: status.configured,
    desktops: status.desktops.map(desktop => ({
      ...(desktop.desktopNumber !== undefined ? { desktop_number: desktop.desktopNumber } : {}),
      status: desktop.status
    })),
    available_desktops: status.available_desktops
  };
}

function ownControlView(status: AgentDesktopStatus) {
  const control = status.control;
  if (!control.active || !control.leaseId || control.desktopNumber === undefined) return undefined;
  return {
    lease_id: control.leaseId,
    desktop_number: control.desktopNumber,
    hud_ready: status.hud_ready,
    hud_visible: status.hud_visible
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
      description: 'Start, inspect, or stop a user-bound Agent Desktop control lease. Status reports the bound Agent Desktop pool as free, occupied, or unavailable. Before start, inspect status and explicitly choose desktop_number; DeskMCP rechecks that desktop atomically before granting the lease. Desktop 1 is reserved for the local user. A native blue safety HUD must be heartbeating before control is granted. Agent Desktop is a workspace/isolation capability; Browser and Computer Use remain independent capabilities and do not inherit its lifecycle.',
      inputSchema: z.object({
        action: z.enum(['status', 'start', 'stop']),
        lease_id: z.string().uuid().optional(),
        desktop_number: z.number().int().min(2).optional(),
        task_label: z.string().min(1).max(200).optional(),
        task_id: z.string().max(64).optional(),
        context_handle: z.string().max(256).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ action, lease_id, desktop_number, task_label, task_id, context_handle }) => {
      let operation;
      try {
        operation = await audit.begin('desktop_agent_desktop', 'computer', policy.profile, action);
      } catch (error) {
        return failure('Audit start failed', error);
      }
      try {
        policy.assertCanUseComputer();
        let result;
        if (action === 'status') {
          const status = await manager.status(lease_id);
          const own = lease_id ? ownControlView(status) : undefined;
          result = { ...poolView(status), ...(own ? { control: own } : {}) };
        } else if (action === 'start') {
          if (desktop_number === undefined) {
            throw new PolicyDeniedError('Starting Agent Desktop requires desktop_number. Call status, choose a free Agent Desktop, then start it explicitly.');
          }
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
          const status = await manager.startControl(effectiveLabel, linkedTaskId, desktop_number);
          const own = ownControlView(status);
          if (!own) throw new Error('Agent Desktop control did not become active after start.');
          result = { ...poolView(status), control: own };
        } else {
          if (!lease_id) throw new PolicyDeniedError('Stopping Agent Desktop control requires the active lease_id.');
          const status = await manager.stopControl(lease_id);
          result = { ...poolView(status), stopped: true };
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
