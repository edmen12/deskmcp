import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ObservationRequiredError, ObservationStore } from '../src/observation-store.js';
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

test('ObservationStore evicts oldest observations without weakening write safety', async () => {
  const files = ['obs-a.txt', 'obs-b.txt', 'obs-c.txt'].map(name => path.join(TEST_AREA, name));
  try {
    await Promise.all(files.map((file, index) => writeFile(file, `value-${index}`, 'utf8')));
    const store = new ObservationStore(1024 * 1024, 2);
    await store.observe(files[0]!);
    await store.observe(files[1]!);
    await store.observe(files[2]!);
    assert.equal(store.size(), 2);
    await assert.rejects(store.requireFresh(files[0]!), ObservationRequiredError);
    await assert.doesNotReject(store.requireFresh(files[1]!));
    await assert.doesNotReject(store.requireFresh(files[2]!));
  } finally {
    await Promise.all(files.map(file => rm(file, { force: true })));
  }
});
