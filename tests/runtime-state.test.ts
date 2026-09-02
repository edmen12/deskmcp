import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ObservationCapabilityError, ObservationRequiredError, ObservationStore, StaleObservationError } from '../src/observation-store.js';
import { ProcessSessionRegistry } from '../src/process-session-registry.js';
import { TEST_AREA } from '../src/paths.js';

test('ProcessSessionRegistry rejects new live sessions at the ownership cap', () => {
  const sessions = new ProcessSessionRegistry(2, () => true);
  const first = sessions.register(101);
  sessions.register(202);
  assert.equal(sessions.size(), 2);
  assert.throws(() => sessions.register(303), /Process session limit reached/);
  sessions.forget(first);
  assert.doesNotThrow(() => sessions.register(303));
  assert.equal(sessions.size(), 2);
});

test('ProcessSessionRegistry prunes exited sessions before enforcing the cap', () => {
  const alive = new Set([101, 202]);
  const sessions = new ProcessSessionRegistry(2, pid => alive.has(pid));
  const first = sessions.register(101);
  sessions.register(202);
  alive.delete(101);
  alive.add(303);
  assert.doesNotThrow(() => sessions.register(303));
  assert.equal(sessions.size(), 2);
  assert.equal(sessions.has(first), false);
  assert.throws(() => sessions.resolve(first), /Unknown or unowned process session/);
});

test('ObservationStore evicts oldest capabilities without weakening write safety', async () => {
  const files = ['obs-a.txt', 'obs-b.txt', 'obs-c.txt'].map(name => path.join(TEST_AREA, name));
  try {
    await Promise.all(files.map((file, index) => writeFile(file, `value-${index}`, 'utf8')));
    const store = new ObservationStore(1024 * 1024, 2);
    const first = await store.observe(files[0]!);
    const second = await store.observe(files[1]!);
    const third = await store.observe(files[2]!);
    assert.equal(store.size(), 2);
    await assert.rejects(
      store.withObservedMutation(files[0]!, first.observationId, async () => undefined),
      ObservationCapabilityError
    );
    await assert.doesNotReject(
      store.withObservedMutation(files[1]!, second.observationId, async () => undefined)
    );
    await assert.doesNotReject(
      store.withObservedMutation(files[2]!, third.observationId, async () => undefined)
    );
    await assert.rejects(
      store.withObservedMutation(files[2]!, undefined, async () => undefined),
      ObservationRequiredError
    );
  } finally {
    await Promise.all(files.map(file => rm(file, { force: true })));
  }
});

test('Observation capabilities are single-use and serialize concurrent mutations', async () => {
  const file = path.join(TEST_AREA, 'obs-concurrent.txt');
  try {
    await writeFile(file, 'base', 'utf8');
    const store = new ObservationStore();
    const first = await store.observe(file);
    const second = await store.observe(file);

    const outcomes = await Promise.allSettled([
      store.withObservedMutation(file, first.observationId, async () => {
        await writeFile(file, 'first', 'utf8');
      }),
      store.withObservedMutation(file, second.observationId, async () => {
        await writeFile(file, 'second', 'utf8');
      })
    ]);

    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(result => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.ok(rejected.reason instanceof StaleObservationError);
    await assert.rejects(
      store.withObservedMutation(file, first.observationId, async () => undefined),
      ObservationCapabilityError
    );
  } finally {
    await rm(file, { force: true });
  }
});
