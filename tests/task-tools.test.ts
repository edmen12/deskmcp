import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';
import { AuditLogger } from '../src/audit.js';
import type { BrowserRuntime } from '../src/browser-runtime.js';
import { DesktopBackendBridge } from '../src/desktop-backend-bridge.js';
import { DesktopPolicy, type PermissionProfile } from '../src/desktop-policy.js';
import { startHttpServer } from '../src/http-server.js';
import { ObservationStore } from '../src/observation-store.js';
import { ProcessSessionRegistry } from '../src/process-session-registry.js';
import { TaskContextStore } from '../src/task-context.js';

function contentText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return result.content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n');
}

function contentJson<T>(result: Awaited<ReturnType<Client['callTool']>>): T {
  return JSON.parse(contentText(result)) as T;
}

async function withTaskClient<T>(
  profile: PermissionProfile,
  operation: (client: Client, root: string) => Promise<T>,
  extras: { agentDesktop?: AgentDesktopManager; browser?: BrowserRuntime } = {}
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-task-tools-'));
  const policy = await DesktopPolicy.create({ profile, allowedRoots: [root] });
  const audit = new AuditLogger(path.join(root, 'audit.jsonl'));
  await audit.init();
  const bridge = new DesktopBackendBridge();
  const observations = new ObservationStore();
  const sessions = new ProcessSessionRegistry();
  const tasks = new TaskContextStore(path.join(root, 'tasks'));
  await tasks.init();
  const running = await startHttpServer(
    '127.0.0.1',
    0,
    bridge,
    policy,
    audit,
    observations,
    sessions,
    undefined,
    tasks,
    undefined,
    undefined,
    extras.browser,
    undefined,
    extras.agentDesktop
  );
  const client = new Client(
    { name: 'deskmcp-task-tools-test', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } }
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)));
    return await operation(client, root);
  } finally {
    await client.close().catch(() => undefined);
    await running.close();
    await bridge.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

test('Read profile can discover Task Rooms but cannot create or mutate them', async () => {
  await withTaskClient('read-only', async client => {
    const listed = await client.listTools();
    assert.equal(listed.tools.some(tool => tool.name === 'desktop_task_manage'), true);

    const discover = await client.callTool({
      name: 'desktop_task_manage',
      arguments: { action: 'context_discover' }
    });
    assert.equal(discover.isError, undefined);
    assert.match(contentText(discover), /"count": 0/);

    const createContext = await client.callTool({
      name: 'desktop_task_manage',
      arguments: { action: 'context_create', context_label: 'read must not create' }
    });
    assert.equal(createContext.isError, true);
    assert.match(contentText(createContext), /Write denied|read-only/i);

    const createTask = await client.callTool({
      name: 'desktop_task_manage',
      arguments: {
        action: 'create',
        context_handle: 'tctx_0000000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        title: 'denied',
        goal: 'denied',
        completion_conditions: ['denied']
      }
    });
    assert.equal(createTask.isError, true);
    assert.match(contentText(createTask), /Write denied|read-only/i);
  });
});

test('Write profile creates isolated Task Rooms and only lists tasks for the presented capability', async () => {
  await withTaskClient('workspace-write', async client => {
    const firstContext = await client.callTool({
      name: 'desktop_task_manage',
      arguments: { action: 'context_create', context_label: 'window A' }
    });
    assert.equal(firstContext.isError, undefined);
    const first = contentJson<{ context: { context_id: string; context_handle: string } }>(firstContext).context;

    const secondContext = await client.callTool({
      name: 'desktop_task_manage',
      arguments: { action: 'context_create', context_label: 'window B' }
    });
    assert.equal(secondContext.isError, undefined);
    const second = contentJson<{ context: { context_id: string; context_handle: string } }>(secondContext).context;
    assert.notEqual(first.context_id, second.context_id);

    const taskA = await client.callTool({
      name: 'desktop_task_manage',
      arguments: {
        action: 'create',
        context_handle: first.context_handle,
        title: 'Task A',
        goal: 'Stay in room A',
        completion_conditions: ['A only']
      }
    });
    assert.equal(taskA.isError, undefined);
    const taskAId = contentJson<{ task: { id: string } }>(taskA).task.id;

    const taskB = await client.callTool({
      name: 'desktop_task_manage',
      arguments: {
        action: 'create',
        context_handle: second.context_handle,
        title: 'Task B',
        goal: 'Stay in room B',
        completion_conditions: ['B only']
      }
    });
    assert.equal(taskB.isError, undefined);
    const taskBId = contentJson<{ task: { id: string } }>(taskB).task.id;

    const listA = await client.callTool({
      name: 'desktop_task_manage',
      arguments: { action: 'list', context_handle: first.context_handle }
    });
    assert.equal(listA.isError, undefined);
    assert.match(contentText(listA), new RegExp(taskAId));
    assert.doesNotMatch(contentText(listA), new RegExp(taskBId));

    const missingContext = await client.callTool({
      name: 'desktop_task_manage',
      arguments: { action: 'list' }
    });
    assert.equal(missingContext.isError, true);
    assert.match(contentText(missingContext), /requires context_handle/i);
  });
});

test('context discovery does not leak task ids and explicit reattach can recover by exact task id', async () => {
  await withTaskClient('workspace-write', async client => {
    const createdContext = await client.callTool({
      name: 'desktop_task_manage',
      arguments: { action: 'context_create', context_label: 'recover me' }
    });
    const context = contentJson<{ context: { context_id: string; context_handle: string } }>(createdContext).context;
    const createdTask = await client.callTool({
      name: 'desktop_task_manage',
      arguments: {
        action: 'create',
        context_handle: context.context_handle,
        title: 'Recovery anchor',
        goal: 'Use exact task id to recover',
        completion_conditions: ['recoverable']
      }
    });
    const taskId = contentJson<{ task: { id: string } }>(createdTask).task.id;

    const discover = await client.callTool({
      name: 'desktop_task_manage',
      arguments: { action: 'context_discover' }
    });
    assert.equal(discover.isError, undefined);
    assert.match(contentText(discover), /recover me/);
    assert.doesNotMatch(contentText(discover), new RegExp(taskId));

    const reattach = await client.callTool({
      name: 'desktop_task_manage',
      arguments: { action: 'context_reattach', task_id: taskId }
    });
    assert.equal(reattach.isError, undefined);
    const recovered = contentJson<{ context: { context_handle: string } }>(reattach).context;
    assert.notEqual(recovered.context_handle, context.context_handle);

    const get = await client.callTool({
      name: 'desktop_task_manage',
      arguments: { action: 'get', context_handle: recovered.context_handle, task_id: taskId }
    });
    assert.equal(get.isError, undefined);
    assert.match(contentText(get), /Recovery anchor/);
  });
});


test('completing a linked Task Room auto-revokes Agent Desktop and closes lease browser sessions', async () => {
  const leaseId = '33333333-3333-4333-8333-333333333333';
  let stoppedTaskId: string | undefined;
  let closedLeaseId: string | undefined;
  const agentDesktop = {
    async stopControlForTask(taskId: string) {
      stoppedTaskId = taskId;
      return {
        stopped: true,
        leaseId,
        status: {
          configured: true,
          control: { schemaVersion: 1, generation: 2, active: false },
          hud_ready: false,
          hud_visible: false
        }
      };
    }
  } as unknown as AgentDesktopManager;
  const browser = {
    async closeAgentDesktopLease(value: string) {
      closedLeaseId = value;
      return { lease_id: value, closed_sessions: 2 };
    }
  } as unknown as BrowserRuntime;

  await withTaskClient('workspace-write', async client => {
    const createdContext = await client.callTool({
      name: 'desktop_task_manage',
      arguments: { action: 'context_create', context_label: 'auto cleanup' }
    });
    const context = contentJson<{ context: { context_handle: string } }>(createdContext).context;
    const createdTask = await client.callTool({
      name: 'desktop_task_manage',
      arguments: {
        action: 'create',
        context_handle: context.context_handle,
        title: 'Auto cleanup task',
        goal: 'Close Agent Desktop lifecycle resources on completion',
        completion_conditions: ['cleanup verified']
      }
    });
    const taskId = contentJson<{ task: { id: string } }>(createdTask).task.id;

    const review = await client.callTool({
      name: 'desktop_task_manage',
      arguments: {
        action: 'final_review',
        context_handle: context.context_handle,
        task_id: taskId,
        review_status: 'pass',
        summary: 'Ready to complete.',
        verified_facts: ['Cleanup path is ready.']
      }
    });
    assert.equal(review.isError, undefined);

    const complete = await client.callTool({
      name: 'desktop_task_manage',
      arguments: { action: 'complete', context_handle: context.context_handle, task_id: taskId }
    });
    assert.equal(complete.isError, undefined);
    const result = contentJson<{
      task: { status: string };
      agent_desktop_cleanup: {
        linked: boolean;
        control_stopped: boolean;
        lease_id: string;
        browser_sessions_closed: number;
      };
    }>(complete);
    assert.equal(result.task.status, 'completed');
    assert.equal(result.agent_desktop_cleanup.linked, true);
    assert.equal(result.agent_desktop_cleanup.control_stopped, true);
    assert.equal(result.agent_desktop_cleanup.lease_id, leaseId);
    assert.equal(result.agent_desktop_cleanup.browser_sessions_closed, 2);
    assert.equal(stoppedTaskId, taskId);
    assert.equal(closedLeaseId, leaseId);
  }, { agentDesktop, browser });
});
