import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger } from './audit.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';
import type { AgentDesktopManager } from './agent-desktop-state.js';

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
  manager: AgentDesktopManager
): void {
  server.registerTool(
    'desktop_agent_desktop',
    {
      title: 'Manage Agent Desktop',
      description: 'Start, inspect, or stop a user-bound Agent Desktop control lease. A native blue safety HUD must be visible and heartbeating before control is granted. Binding the desktop itself is a local user action in the DeskMCP Control Panel and cannot be performed by an agent.',
      inputSchema: z.object({
        action: z.enum(['status', 'start', 'stop']),
        lease_id: z.string().uuid().optional(),
        task_label: z.string().min(1).max(200).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ action, lease_id, task_label }) => {
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
        else if (action === 'start') result = await manager.startControl(task_label);
        else {
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
