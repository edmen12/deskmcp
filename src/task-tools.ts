import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger, AuditRisk } from './audit.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';
import { TaskContextStore, workspaceFingerprint } from './task-context.js';
import {
  type RecoverableTask,
  TASK_PHASES,
  TASK_STATUSES,
  TASK_STEP_STATUSES
} from './task-state.js';

const ACTIONS = [
  'context_create',
  'context_discover',
  'context_reattach',
  'create',
  'list',
  'get',
  'checkpoint',
  'block',
  'resume',
  'final_review',
  'complete'
] as const;

type TaskAction = typeof ACTIONS[number];

function failure(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: `${prefix}: ${message}` }],
    isError: true as const
  };
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
  };
}

function compactTask(task: RecoverableTask) {
  const completedSteps = task.steps.filter(step => step.status === 'completed').length;
  const inProgress = task.steps.find(step => step.status === 'in_progress');
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    status: task.status,
    phase: task.phase,
    ...(task.summary ? { summary: task.summary } : {}),
    ...(task.blocker ? { blocker: task.blocker } : {}),
    steps: {
      completed: completedSteps,
      total: task.steps.length,
      ...(inProgress ? { current: inProgress.id } : {})
    },
    ...(task.final_review ? { final_review: task.final_review.status } : {}),
    created_at: task.created_at,
    updated_at: task.updated_at,
    ...(task.completed_at ? { completed_at: task.completed_at } : {})
  };
}

function riskForAction(action: TaskAction): AuditRisk {
  return action === 'context_discover' || action === 'list' || action === 'get' ? 'read' : 'write';
}

function requiresContextHandle(action: TaskAction): boolean {
  return !action.startsWith('context_');
}

export function registerTaskTools(
  server: McpServer,
  policy: DesktopPolicy,
  audit: AuditLogger,
  store: TaskContextStore
): void {
  server.registerTool(
    'desktop_task_manage',
    {
      title: 'Manage Recoverable DeskMCP Tasks',
      description: 'Persist substantial agent work across interruptions inside an explicit Workspace-bound Task Room. Task Rooms use opaque capabilities so parallel ChatGPT windows do not share task state by default. Discovery is read-only and scoped to the current Workspace; reattach requires an exact task id or an explicit context id plus matching label.',
      inputSchema: z.object({
        action: z.enum(ACTIONS),
        context_handle: z.string().max(256).optional(),
        context_label: z.string().max(256).optional(),
        context_id: z.string().max(64).optional(),
        confirm_label: z.string().max(256).optional(),
        task_id: z.string().optional(),
        title: z.string().max(512).optional(),
        goal: z.string().max(16384).optional(),
        project: z.string().max(256).optional(),
        device: z.string().max(256).optional(),
        completion_conditions: z.array(z.string().max(4096)).max(64).optional(),
        steps: z.array(z.object({
          id: z.string().min(1).max(128),
          title: z.string().min(1).max(512),
          phase: z.enum(TASK_PHASES).optional()
        })).max(12).optional(),
        task_status: z.enum(TASK_STATUSES).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        step_id: z.string().optional(),
        step_status: z.enum(TASK_STEP_STATUSES).optional(),
        completed_step_ids: z.array(z.string()).max(12).optional(),
        current_step_id: z.string().optional(),
        summary: z.string().max(8192).optional(),
        review_status: z.enum(['pass', 'failed']).optional(),
        verified_facts: z.array(z.string().max(4096)).max(64).optional(),
        open_risks: z.array(z.string().max(4096)).max(64).optional(),
        missing_checks: z.array(z.string().max(4096)).max(64).optional()
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async input => {
      const action = input.action;
      const risk = riskForAction(action);
      const target = input.context_id ?? input.task_id;
      let operation;
      try {
        operation = await audit.begin('desktop_task_manage', risk, policy.profile, target);
      } catch (error) {
        return failure('Task audit start failed', error);
      }

      try {
        if (risk === 'write') policy.assertCanWrite();
        const workspace = workspaceFingerprint(policy.allowedRoots);
        if (requiresContextHandle(action) && !input.context_handle) {
          throw new Error(`${action} requires context_handle. Create or reattach a Task Room first.`);
        }

        let result: unknown;
        switch (action) {
          case 'context_create': {
            if (!input.context_label) throw new Error('context_create requires context_label.');
            result = { action, context: await store.createContext(workspace, input.context_label) };
            break;
          }
          case 'context_discover': {
            const contexts = await store.discoverContexts(workspace);
            result = { action, contexts, count: contexts.length };
            break;
          }
          case 'context_reattach': {
            result = {
              action,
              context: await store.reattachContext(workspace, {
                ...(input.task_id ? { task_id: input.task_id } : {}),
                ...(input.context_id ? { context_id: input.context_id } : {}),
                ...(input.confirm_label ? { confirm_label: input.confirm_label } : {})
              })
            };
            break;
          }
          case 'create': {
            if (!input.title || !input.goal || !input.completion_conditions) {
              throw new Error('create requires title, goal, and completion_conditions.');
            }
            const task = await store.createTask(input.context_handle!, workspace, {
              title: input.title,
              goal: input.goal,
              completion_conditions: input.completion_conditions,
              ...(input.project ? { project: input.project } : {}),
              ...(input.device ? { device: input.device } : {}),
              ...(input.steps ? {
                steps: input.steps.map(step => ({
                  id: step.id,
                  title: step.title,
                  ...(step.phase ? { phase: step.phase } : {})
                }))
              } : {})
            });
            result = { action, task };
            break;
          }
          case 'list': {
            const tasks = await store.listTasks(input.context_handle!, workspace, {
              ...(input.task_status ? { status: input.task_status } : {}),
              ...(input.limit !== undefined ? { limit: input.limit } : {})
            });
            result = { action, tasks: tasks.map(compactTask), count: tasks.length };
            break;
          }
          case 'get': {
            if (!input.task_id) throw new Error('get requires task_id.');
            result = { action, task: await store.getTask(input.context_handle!, workspace, input.task_id) };
            break;
          }
          case 'checkpoint': {
            if (!input.task_id || !input.summary) {
              throw new Error('checkpoint requires task_id and summary.');
            }
            const task = await store.checkpoint(input.context_handle!, workspace, input.task_id, {
              summary: input.summary,
              ...(input.step_id ? { step_id: input.step_id } : {}),
              ...(input.step_status ? { status: input.step_status } : {}),
              ...(input.completed_step_ids ? { completed_step_ids: input.completed_step_ids } : {}),
              ...(input.current_step_id ? { current_step_id: input.current_step_id } : {})
            });
            result = { action, task };
            break;
          }
          case 'block': {
            if (!input.task_id || !input.summary) throw new Error('block requires task_id and summary.');
            result = { action, task: await store.block(input.context_handle!, workspace, input.task_id, input.summary) };
            break;
          }
          case 'resume': {
            if (!input.task_id || !input.summary) throw new Error('resume requires task_id and summary.');
            result = { action, task: await store.resume(input.context_handle!, workspace, input.task_id, input.summary) };
            break;
          }
          case 'final_review': {
            if (!input.task_id || !input.summary || !input.review_status) {
              throw new Error('final_review requires task_id, review_status, and summary.');
            }
            result = {
              action,
              task: await store.finalReview(input.context_handle!, workspace, input.task_id, {
                status: input.review_status,
                summary: input.summary,
                ...(input.verified_facts ? { verified_facts: input.verified_facts } : {}),
                ...(input.open_risks ? { open_risks: input.open_risks } : {}),
                ...(input.missing_checks ? { missing_checks: input.missing_checks } : {})
              })
            };
            break;
          }
          case 'complete': {
            if (!input.task_id) throw new Error('complete requires task_id.');
            result = { action, task: await store.complete(input.context_handle!, workspace, input.task_id) };
            break;
          }
        }
        await audit.finish(operation, 'allow');
        return jsonResult(result);
      } catch (error) {
        const outcome = error instanceof PolicyDeniedError ? 'deny' : 'fail';
        try {
          await audit.finish(operation, outcome, error);
        } catch (auditError) {
          return failure('Task audit finalization failed', auditError);
        }
        return failure('Task operation failed', error);
      }
    }
  );
}
