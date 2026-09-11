import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskContextStore, workspaceFingerprint } from '../src/task-context.js';

async function withStore(run: (store: TaskContextStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-task-context-'));
  try {
    const store = new TaskContextStore(root);
    await store.init();
    await run(store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const WORKSPACE_A = 'a'.repeat(64);
const WORKSPACE_B = 'b'.repeat(64);

test('task rooms isolate parallel windows even inside the same workspace', async () => {
  await withStore(async store => {
    const roomA = await store.createContext(WORKSPACE_A, 'browser work');
    const roomB = await store.createContext(WORKSPACE_A, 'release work');

    const taskA = await store.createTask(roomA.context_handle, WORKSPACE_A, {
      title: 'Browser E2E',
      goal: 'Verify browser runtime',
      completion_conditions: ['E2E passes'],
      steps: [{ id: 'verify', title: 'Verify browser', phase: 'verify' }]
    });
    const taskB = await store.createTask(roomB.context_handle, WORKSPACE_A, {
      title: 'Release smoke',
      goal: 'Verify release stage',
      completion_conditions: ['smoke passes'],
      steps: [{ id: 'smoke', title: 'Run smoke', phase: 'verify' }]
    });

    assert.deepEqual((await store.listTasks(roomA.context_handle, WORKSPACE_A)).map(task => task.id), [taskA.id]);
    assert.deepEqual((await store.listTasks(roomB.context_handle, WORKSPACE_A)).map(task => task.id), [taskB.id]);
    await assert.rejects(() => store.getTask(roomA.context_handle, WORKSPACE_A, taskB.id), /Task not found/i);
    await assert.rejects(() => store.getTask(roomB.context_handle, WORKSPACE_A, taskA.id), /Task not found/i);

    const discovered = await store.discoverContexts(WORKSPACE_A);
    assert.equal(discovered.length, 2);
    assert.deepEqual(new Set(discovered.map(item => item.label)), new Set(['browser work', 'release work']));
    assert.equal(JSON.stringify(discovered).includes(taskA.id), false);
    assert.equal(JSON.stringify(discovered).includes(taskB.id), false);
  });
});

test('task room capability is bound to the selected workspace', async () => {
  await withStore(async store => {
    const room = await store.createContext(WORKSPACE_A, 'workspace-a-only');
    await store.createTask(room.context_handle, WORKSPACE_A, {
      title: 'Scoped task',
      goal: 'Stay in workspace A',
      completion_conditions: ['never appears in workspace B']
    });

    assert.equal((await store.discoverContexts(WORKSPACE_A)).length, 1);
    assert.equal((await store.discoverContexts(WORKSPACE_B)).length, 0);
    await assert.rejects(() => store.listTasks(room.context_handle, WORKSPACE_B), /different workspace/i);
  });
});

test('lost context can reattach by exact task id without invalidating the old capability', async () => {
  await withStore(async store => {
    const room = await store.createContext(WORKSPACE_A, 'recoverable room');
    const task = await store.createTask(room.context_handle, WORKSPACE_A, {
      title: 'Long task',
      goal: 'Recover after chat context loss',
      completion_conditions: ['reattach succeeds']
    });

    const recovered = await store.reattachContext(WORKSPACE_A, { task_id: task.id });
    assert.equal(recovered.context_id, room.context_id);
    assert.notEqual(recovered.context_handle, room.context_handle);
    assert.equal((await store.getTask(recovered.context_handle, WORKSPACE_A, task.id)).id, task.id);
    assert.equal((await store.getTask(room.context_handle, WORKSPACE_A, task.id)).id, task.id);
  });
});

test('reattach by discovery requires exact context id plus exact label confirmation', async () => {
  await withStore(async store => {
    const room = await store.createContext(WORKSPACE_A, 'release validation');
    const discovered = await store.discoverContexts(WORKSPACE_A);
    assert.equal(discovered[0]?.context_id, room.context_id);

    await assert.rejects(
      () => store.reattachContext(WORKSPACE_A, { context_id: room.context_id, confirm_label: 'wrong label' }),
      /does not match/i
    );
    await assert.rejects(
      () => store.reattachContext(WORKSPACE_B, { context_id: room.context_id, confirm_label: 'release validation' }),
      /different workspace/i
    );

    const recovered = await store.reattachContext(WORKSPACE_A, {
      context_id: room.context_id,
      confirm_label: 'release validation'
    });
    assert.equal(recovered.context_id, room.context_id);
  });
});

test('concurrent context reattach preserves both capabilities across store instances', async () => {
  await withStore(async (store, root) => {
    const second = new TaskContextStore(root);
    await second.init();
    const room = await store.createContext(WORKSPACE_A, 'shared recovery room');
    const task = await store.createTask(room.context_handle, WORKSPACE_A, {
      title: 'Shared recovery task',
      goal: 'Preserve every concurrently issued context capability.',
      completion_conditions: ['both reattach handles remain valid']
    });

    const [left, right] = await Promise.all([
      store.reattachContext(WORKSPACE_A, { task_id: task.id }),
      second.reattachContext(WORKSPACE_A, { task_id: task.id })
    ]);
    assert.notEqual(left.context_handle, right.context_handle);
    assert.equal((await store.getTask(left.context_handle, WORKSPACE_A, task.id)).id, task.id);
    assert.equal((await second.getTask(right.context_handle, WORKSPACE_A, task.id)).id, task.id);
  });
});

test('same task room preserves one serialized mutation queue for concurrent agents', async () => {
  await withStore(async store => {
    const room = await store.createContext(WORKSPACE_A, 'concurrent room');
    const task = await store.createTask(room.context_handle, WORKSPACE_A, {
      title: 'Parallel checkpoints',
      goal: 'Only one step can be current',
      completion_conditions: ['one current step'],
      steps: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' }
      ]
    });

    const results = await Promise.allSettled([
      store.checkpoint(room.context_handle, WORKSPACE_A, task.id, {
        step_id: 'a', status: 'in_progress', summary: 'A running'
      }),
      store.checkpoint(room.context_handle, WORKSPACE_A, task.id, {
        step_id: 'b', status: 'in_progress', summary: 'B running'
      })
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const loaded = await store.getTask(room.context_handle, WORKSPACE_A, task.id);
    assert.equal(loaded.steps.filter(step => step.status === 'in_progress').length, 1);
  });
});

test('workspace fingerprint is deterministic regardless of root order', () => {
  const left = workspaceFingerprint(['C:\\Work\\B', 'C:\\Work\\A']);
  const right = workspaceFingerprint(['C:\\Work\\A', 'C:\\Work\\B']);
  assert.equal(left, right);
  assert.match(left, /^[0-9a-f]{64}$/u);
});
