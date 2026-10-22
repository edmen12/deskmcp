import assert from 'node:assert/strict';
import test from 'node:test';
import { ProcessSessionRegistry } from '../src/process-session-registry.js';
import { registerProcessTools } from '../src/process-tools.js';

test('capacity diagnostic remains readable at full capacity without spawning ProcessHost', async () => {
  const sessions = new ProcessSessionRegistry(2);
  sessions.register(16111);
  sessions.register(16222);
  assert.equal(sessions.atCapacity(), true);
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    registerTool(name: string, _spec: unknown, callback: (input: Record<string, unknown>) => Promise<unknown>) {
      handlers.set(name, callback);
    }
  } as unknown as Parameters<typeof registerProcessTools>[0];
  const bridge = {
    async listProcessSessions() { throw new Error('Capacity reporting must never reach native process backend'); },
    async startProcess() { throw new Error('Capacity reporting must never spawn'); }
  } as unknown as Parameters<typeof registerProcessTools>[1];
  const policy = {profile:'fully-unlocked'} as unknown as Parameters<typeof registerProcessTools>[2];
  const audit = {
    async begin() { return {tool:'desktop_process_capacity'}; },
    async finish() {}
  } as unknown as Parameters<typeof registerProcessTools>[3];
  registerProcessTools(server, bridge, policy, audit, sessions);
  const call = handlers.get('desktop_process_capacity');
  assert.ok(call, 'Read-only capacity tool is registered');
  const result = await call({}) as {isError?:boolean;content:{type:string;text:string}[]};
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]!.text) as Record<string,unknown>;
  assert.equal(payload.limit, 2);
  assert.equal(payload.active, 2);
  assert.equal(payload.available, 0);
  assert.match(String(payload.interpretation), /age is not a failure signal/i);
  assert.ok(!('sessions' in payload), 'Do not leak owned process capabilities to another client');
  assert.ok(!('pids' in payload), 'No OS PIDs are returned');
});
