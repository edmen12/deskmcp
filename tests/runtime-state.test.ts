import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ObservationCapabilityError, ObservationRequiredError, ObservationStore, StaleObservationError } from '../src/observation-store.js';
import { ProcessSessionRegistry } from '../src/process-session-registry.js';
import { TEST_AREA } from '../src/paths.js';

test('ProcessSessionRegistry enforces the active-session cap without OS PID liveness guesses', () => {
  const sessions = new ProcessSessionRegistry(2, 4);
  const first = sessions.register(101);
  sessions.register(202);
  assert.equal(sessions.activeSize(), 2);
  assert.throws(() => sessions.register(303), /Process session limit reached/);

  sessions.reconcileActivePids([202]);
  assert.equal(sessions.isActive(first), false);
  assert.equal(sessions.activeSize(), 1);
  assert.equal(sessions.resolve(first), 101, 'completed-session capability should remain readable');
  assert.doesNotThrow(() => sessions.register(303));
  assert.equal(sessions.activeSize(), 2);
});

test('ProcessSessionRegistry reserves capacity before process spawn', () => {
  const sessions = new ProcessSessionRegistry(2, 4);
  const firstReservation = sessions.reserveStart();
  const secondReservation = sessions.reserveStart();
  assert.equal(sessions.pendingSize(), 2);
  assert.equal(sessions.atCapacity(), true);
  assert.throws(() => sessions.reserveStart(), /Process session limit reached/);

  const firstSession = sessions.registerReserved(firstReservation, 101);
  assert.equal(sessions.pendingSize(), 1);
  assert.equal(sessions.activeSize(), 1);
  assert.equal(sessions.resolve(firstSession), 101);

  sessions.releaseStart(secondReservation);
  assert.equal(sessions.pendingSize(), 0);
  assert.equal(sessions.atCapacity(), false);
});

test('ProcessSessionRegistry bounds inactive history while preserving active sessions', () => {
  const sessions = new ProcessSessionRegistry(2, 3);
  const first = sessions.register(101);
  sessions.reconcileActivePids([]);
  const second = sessions.register(202);
  sessions.reconcileActivePids([]);
  const third = sessions.register(303);
  sessions.reconcileActivePids([]);
  const fourth = sessions.register(404);

  assert.equal(sessions.size(), 3);
  assert.equal(sessions.has(first), false, 'oldest inactive capability should be evicted first');
  assert.equal(sessions.has(second), true);
  assert.equal(sessions.has(third), true);
  assert.equal(sessions.has(fourth), true);
  assert.equal(sessions.activeSize(), 1);
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
