import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserHandoffProcessPreflight } from '../src/browser-process-handoff-preflight.js';
import { ProcessSessionRegistry } from '../src/process-session-registry.js';

test('handoff preflight refuses active non-browser jobs without terminating them', async () => {
  const registry = new ProcessSessionRegistry();
  const browserSessionId = registry.register(101);
  const unrelatedSessionId = registry.register(202);
  const preflight = createBrowserHandoffProcessPreflight({
    async listProcessSessions() { return { text: 'PID: 101\nPID: 202', isError: false }; }
  }, registry);
  await assert.rejects(preflight([browserSessionId]), /active Gateway-owned non-browser process/i);
  assert.equal(registry.isActive(unrelatedSessionId), true);
});

test('handoff preflight allows a completed unrelated job verified by native inventory', async () => {
  const registry = new ProcessSessionRegistry();
  const browserSessionId = registry.register(101);
  const unrelatedSessionId = registry.register(202);
  const preflight = createBrowserHandoffProcessPreflight({
    async listProcessSessions() { return { text: 'PID: 101', isError: false }; }
  }, registry);
  await preflight([browserSessionId]);
  assert.equal(registry.isActive(browserSessionId), true);
  assert.equal(registry.isActive(unrelatedSessionId), false);
});

test('handoff preflight blocks a pending process startup even without PID', async () => {
  const registry = new ProcessSessionRegistry();
  const id = registry.reserveStart();
  const preflight = createBrowserHandoffProcessPreflight({
    async listProcessSessions() { throw new Error('should not need inventory'); }
  }, registry);
  try {
    await assert.rejects(preflight([]), /pending owned-process startup/i);
  } finally {
    registry.releaseStart(id);
  }
  await preflight([]);
});

test('handoff preflight refuses unknown native inventory and native listing errors', async () => {
  const registry = new ProcessSessionRegistry();
  const browserSessionId = registry.register(101);
  let response = { text: 'backend failed', isError: true };
  const preflight = createBrowserHandoffProcessPreflight({
    async listProcessSessions() { return response; }
  }, registry);
  await assert.rejects(preflight([browserSessionId]), /cannot verify owned-process liveness/i);
  response = { text: 'unexpected process format', isError: false };
  await assert.rejects(preflight([browserSessionId]), /unrecognized owned-process inventory/i);
  assert.equal(registry.isActive(browserSessionId), true);
});

test('handoff preflight permits native verified empty inventory and never kills jobs', async () => {
  const registry = new ProcessSessionRegistry();
  const unknownProcess = registry.register(555);
  const preflight = createBrowserHandoffProcessPreflight({
    async listProcessSessions() { return { text: 'No active process sessions.', isError: false }; }
  }, registry);
  await preflight([]);
  assert.equal(registry.isActive(unknownProcess), false);
});
