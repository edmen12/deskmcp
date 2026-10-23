import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AuditLogger } from '../src/audit.js';
import type { DesktopPolicy } from '../src/desktop-policy.js';
import type { ComputerUseRuntime } from '../src/computer-use-runtime.js';
import type { ComputerWindow } from '../src/computer-use-backend.js';
import { ComputerObservationRegistry } from '../src/computer-use-observation.js';
import { ComputerUseCoordinator, ComputerWindowRegistry } from '../src/computer-use-registry.js';
import { registerComputerUseTools } from '../src/computer-use-tools.js';

type Response = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (input: Record<string, unknown>) => Promise<Response>;

function setup() {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _schema: unknown, handler: Handler) { handlers.set(name, handler); }
  } as unknown as McpServer;
  const audit = {
    async begin() { return {}; },
    async finish() { return undefined; }
  } as unknown as AuditLogger;
  const policy = {
    assertCanUseComputer() { return undefined; },
    isFullyUnlocked() { return false; }
  } as unknown as DesktopPolicy;
  const target: ComputerWindow = {
    hwnd: 101, processId: 202, processName: 'fixture.exe', title: 'Test',
    className: 'FixtureWindow', width: 800, height: 600, isForeground: true
  };
  let inspectFails = false;
  let listFailureOnCall = Number.POSITIVE_INFINITY;
  let listCalls = 0;
  let actCalls = 0;
  const backend = {
    async listWindows() {
      listCalls += 1;
      if (listCalls >= listFailureOnCall) throw new Error('postaction enumeration lost');
      return [target];
    },
    async inspect() {
      if (inspectFails) throw new Error('screenshot or UIA unavailable');
      return { hwnd: target.hwnd, elements: [{ type: 'Window' }], elementsTruncated: true };
    },
    async act() { actCalls += 1; return {}; }
  };
  const runtime = {
    backend,
    observations: new ComputerObservationRegistry(),
    windows: new ComputerWindowRegistry(),
    coordinator: new ComputerUseCoordinator()
  } as unknown as ComputerUseRuntime;
  registerComputerUseTools(server, policy, audit, runtime);
  const tool = (name: string) => {
    const handler = handlers.get(name);
    assert.ok(handler);
    return handler;
  };
  const decode = (result: Response) => JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
  const snapshot = async () => {
    const result = await tool('desktop_ui_snapshot')({
      window_id: runtime.windows.issue(target), include_tree: true,
      include_screenshot: false, interactive_only: true, max_elements: 3
    });
    assert.equal(result.isError, undefined);
    return decode(result);
  };
  return {
    runtime, tool, decode, snapshot,
    setInspectFails(value: boolean) { inspectFails = value; },
    setListFails(value: boolean) { listFailureOnCall = value ? listCalls + 2 : Number.POSITIVE_INFINITY; },
    getActCalls() { return actCalls; }
  };
}

test('actual snapshot tool includes precise tree truncation and scope', async () => {
  const fixture = setup();
  const result = await fixture.snapshot();
  assert.equal(result.semantic_tree_truncated, true);
  assert.equal(result.semantic_tree_scope, 'winapp_depth_and_filter_limited');
  assert.equal(result.semantic_tree_status, 'limited');
  assert.match(String(result.semantic_tree_warning), /omitted controls must not be treated as absent/i);
});

test('actual action tool reports transport completion without claiming app outcome', async () => {
  const fixture = setup();
  const before = await fixture.snapshot();
  const response = await fixture.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'click', selector: 'Submit', observe_after: 'tree', settle_ms: 0,
    allow_system_keys: false, allow_user_desktop: false
  });
  assert.equal(response.isError, undefined);
  const result = fixture.decode(response);
  assert.equal(fixture.getActCalls(), 1);
  assert.equal(result.action_dispatched, true);
  assert.equal(result.outcome_verified, false);
  assert.equal(result.post_action_state, 'snapshot_available');
  assert.equal((result.state as Record<string, unknown>).semantic_tree_truncated, true);
});

test('lost post-action window enumeration reports unknown outcome without re-dispatch', async () => {
  const fixture = setup();
  const before = await fixture.snapshot();
  fixture.setListFails(true);
  const response = await fixture.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'click', selector: 'Submit', observe_after: 'tree', settle_ms: 0,
    allow_system_keys: false, allow_user_desktop: false
  });
  const result = fixture.decode(response);
  assert.equal(result.action_dispatched, true);
  assert.equal(result.outcome_verified, false);
  assert.equal(result.post_action_state, 'observation_unavailable');
  assert.equal(fixture.getActCalls(), 1);
});

test('lost post-action UI inspection reports unknown outcome without re-dispatch', async () => {
  const fixture = setup();
  const before = await fixture.snapshot();
  fixture.setInspectFails(true);
  const response = await fixture.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'invoke', selector: 'Submit', observe_after: 'tree', settle_ms: 0,
    allow_system_keys: false, allow_user_desktop: false
  });
  const result = fixture.decode(response);
  assert.equal(result.action_dispatched, true);
  assert.equal(result.outcome_verified, false);
  assert.equal(result.post_action_state, 'observation_unavailable');
  assert.equal(fixture.getActCalls(), 1);
});
