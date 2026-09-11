import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecoverableTaskStore } from '../src/task-state.js';

async function withStore(run: (store: RecoverableTaskStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-task-state-'));
  try {
    const store = new RecoverableTaskStore(root);
    await store.init();
    await run(store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('recoverable task requires completed steps and evidence before completion', async () => {
  await withStore(async store => {
    const created = await store.create({
      title: 'Ship a safe change',
      goal: 'Modify, verify, and close out the change without losing state.',
      completion_conditions: ['implementation is correct', 'tests pass'],
      steps: [
        { id: 'inspect', title: 'Inspect current state', phase: 'check' },
        { id: 'implement', title: 'Implement change', phase: 'execute' },
        { id: 'verify', title: 'Run verification', phase: 'verify' }
      ]
    });

    await assert.rejects(
      store.finalReview(created.id, {
        status: 'pass',
        summary: 'Looks good',
        verified_facts: ['one check passed']
      }),
      /all task steps completed/i
    );

    await store.checkpoint(created.id, {
      step_id: 'inspect',
      status: 'in_progress',
      summary: 'inspection started'
    });
    await assert.rejects(
      store.checkpoint(created.id, {
        step_id: 'implement',
        status: 'in_progress',
        summary: 'implementation started too early'
      }),
      /already in progress/i
    );

    await store.checkpoint(created.id, {
      completed_step_ids: ['inspect'],
      current_step_id: 'implement',
      summary: 'inspection complete; implementation started'
    });
    await store.checkpoint(created.id, {
      completed_step_ids: ['implement'],
      current_step_id: 'verify',
      summary: 'implementation complete; verification started'
    });
    const verified = await store.checkpoint(created.id, {
      step_id: 'verify',
      status: 'completed',
      summary: 'verification passed'
    });
    assert.equal(verified.steps.every(step => step.status === 'completed'), true);

    const reviewed = await store.finalReview(created.id, {
      status: 'pass',
      summary: 'All required checks passed.',
      verified_facts: ['implementation test passed', 'regression test passed']
    });
    assert.equal(reviewed.phase, 'closeout');
    assert.equal(reviewed.final_review?.status, 'pass');

    const completed = await store.complete(created.id);
    assert.equal(completed.status, 'completed');
    assert.ok(completed.completed_at);
    await assert.rejects(
      store.block(created.id, 'should not mutate'),
      /immutable/i
    );
  });
});

test('passing final review rejects any remaining open risks or missing checks', async () => {
  await withStore(async store => {
    const created = await store.create({
      title: 'Strict final review',
      goal: 'Do not declare completion while verification gaps remain.',
      completion_conditions: ['review evidence is complete'],
      steps: [{ id: 'verify', title: 'Verify result', phase: 'verify' }]
    });
    await store.checkpoint(created.id, {
      step_id: 'verify',
      status: 'completed',
      summary: 'verification step completed'
    });

    await assert.rejects(
      store.finalReview(created.id, {
        status: 'pass',
        summary: 'Looks good except for a known risk.',
        verified_facts: ['core checks passed'],
        open_risks: ['installer was not checked']
      }),
      /zero open risks and zero missing checks/i
    );
    await assert.rejects(
      store.finalReview(created.id, {
        status: 'pass',
        summary: 'Looks good except for a missing check.',
        verified_facts: ['core checks passed'],
        missing_checks: ['macOS parity was not checked']
      }),
      /zero open risks and zero missing checks/i
    );
  });
});

test('recoverable task persists blockers and resumes across store instances', async () => {
  await withStore(async (store, root) => {
    const created = await store.create({
      title: 'Resume after interruption',
      goal: 'Keep enough state to continue later.',
      completion_conditions: ['resume point is retained'],
      steps: [{ id: 'work', title: 'Perform work' }]
    });
    const blocked = await store.block(created.id, 'Waiting for an external dependency.');
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blocker, 'Waiting for an external dependency.');

    const reopened = new RecoverableTaskStore(root);
    await reopened.init();
    const loaded = await reopened.get(created.id);
    assert.equal(loaded.status, 'blocked');
    assert.equal(loaded.blocker, 'Waiting for an external dependency.');

    const resumed = await reopened.resume(created.id, 'Dependency is available.');
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.blocker, undefined);
  });
});

test('failed final review stays explicit and is cleared only after new checkpoint evidence', async () => {
  await withStore(async store => {
    const created = await store.create({
      title: 'Review failure path',
      goal: 'Do not hide incomplete verification.',
      completion_conditions: ['verification evidence exists'],
      steps: [{ id: 'verify', title: 'Verify result', phase: 'verify' }]
    });
    await store.checkpoint(created.id, {
      step_id: 'verify',
      status: 'completed',
      summary: 'initial verification finished'
    });
    const failed = await store.finalReview(created.id, {
      status: 'failed',
      summary: 'Verification evidence is insufficient.',
      missing_checks: ['independent regression check']
    });
    assert.equal(failed.final_review?.status, 'failed');

    const updated = await store.checkpoint(created.id, {
      step_id: 'verify',
      status: 'completed',
      summary: 'independent regression evidence added'
    });
    assert.equal(updated.final_review, undefined);

    const passed = await store.finalReview(created.id, {
      status: 'pass',
      summary: 'Independent regression check now passes.',
      verified_facts: ['independent regression check passed']
    });
    assert.equal(passed.final_review?.status, 'pass');
  });
});

test('concurrent task checkpoints are serialized across store instances', async () => {
  await withStore(async (store, root) => {
    const second = new RecoverableTaskStore(root);
    await second.init();
    const created = await store.create({
      title: 'Concurrent clients',
      goal: 'Prevent two agents from claiming different current steps.',
      completion_conditions: ['only one current step exists'],
      steps: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' }
      ]
    });

    const results = await Promise.allSettled([
      store.checkpoint(created.id, { step_id: 'a', status: 'in_progress', summary: 'A running' }),
      second.checkpoint(created.id, { step_id: 'b', status: 'in_progress', summary: 'B running' })
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);

    const task = await store.get(created.id);
    assert.equal(task.steps.filter(step => step.status === 'in_progress').length, 1);
  });
});
