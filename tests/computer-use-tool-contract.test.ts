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
import { ComputerSnapshotRegistry } from '../src/computer-use-read-model.js';

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
  let snapshotElements = [{ type: 'Window', selector: 'Root', value: '' }];
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
      return { hwnd: target.hwnd, elements: snapshotElements, elementsTruncated: true };
    },
    async act() { actCalls += 1; return {}; }
  };
  const runtime = {
    backend,
    observations: new ComputerObservationRegistry(),
    snapshots: new ComputerSnapshotRegistry(),
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
    setSnapshotElements(value: typeof snapshotElements) { snapshotElements = value; },
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

test('snapshot diff_only returns just changes and a new action observation', async () => {
  const fixture = setup();
  fixture.setSnapshotElements([{ selector: 'Root', value: 'before', type: 'Edit' }]);
  const before = await fixture.snapshot();
  fixture.setSnapshotElements([{ selector: 'Root', value: 'after', type: 'Edit' }]);
  const response = await fixture.tool('desktop_ui_snapshot')({
    window_id: (before.window as Record<string, unknown>).window_id,
    include_tree: true, include_screenshot: false,
    interactive_only: true, max_elements: 3,
    diff_from_observation_id: before.computer_observation_id,
    diff_only: true
  });
  assert.equal(response.isError, undefined);
  const result = fixture.decode(response);
  assert.equal('elements' in result, false);
  assert.equal(result.semantic_tree_truncated, true);
  assert.ok(result.computer_observation_id);
  const diff = result.ui_diff as Record<string, unknown>;
  assert.equal((diff.changed as unknown[]).length, 1);
  assert.equal(diff.scope_complete, false);
});

test('snapshot diff rejects a baseline from another window or invalid scope', async () => {
  const fixture = setup();
  const before = await fixture.snapshot();
  const response = await fixture.tool('desktop_ui_snapshot')({
    window_id: (before.window as Record<string, unknown>).window_id,
    include_tree: true, include_screenshot: false, interactive_only: false,
    max_elements: 3, diff_from_observation_id: before.computer_observation_id
  });
  assert.equal(response.isError, true);
  assert.match(response.content[0]?.text ?? '', /same max_elements and interactive_only/i);
});

test('wait_for verifies UIA condition without dispatching mouse or keyboard input', async () => {
  const fixture = setup();
  const before = await fixture.snapshot();
  fixture.setSnapshotElements([{ selector: 'Root', value: 'saved', type: 'Edit' }]);
  const response = await fixture.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'wait_for', selector: 'Root',
    wait_condition: 'value_equals', expected_value: 'saved',
    wait_ms: 100, poll_ms: 100,
    allow_system_keys: false, allow_user_desktop: false
  });
  assert.equal(response.isError, undefined);
  const result = fixture.decode(response);
  assert.equal(result.condition_met, true);
  assert.equal(result.succeeded, true);
  assert.equal(result.outcome_verified, true);
  assert.equal(result.action_dispatched, false);
  assert.equal(fixture.getActCalls(), 0);
});

test('wait_for timeout is not a false success or automatic retry', async () => {
  const fixture = setup();
  const before = await fixture.snapshot();
  const response = await fixture.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'wait_for', selector: 'Missing',
    wait_condition: 'present', wait_ms: 0, poll_ms: 100,
    allow_system_keys: false, allow_user_desktop: false
  });
  assert.equal(response.isError, undefined);
  const result = fixture.decode(response);
  assert.equal(result.condition_met, false);
  assert.equal(result.succeeded, false);
  assert.equal(result.check_completed, true);
  assert.equal(result.outcome_status, 'timeout_inconclusive');
  assert.equal(fixture.getActCalls(), 0);
});

test('UI diff baseline remains readable after its one-time action token is consumed', async () => {
  const fixture = setup();
  fixture.setSnapshotElements([{ selector: 'Root', type: 'Edit', value: 'old' }]);
  const before = await fixture.snapshot();
  const windowId = (before.window as Record<string, unknown>).window_id;
  const action = await fixture.tool('desktop_ui_action')({
    window_id: windowId, computer_observation_id: before.computer_observation_id,
    action: 'set_value', selector: 'Root', value: 'new',
    settle_ms: 0, observe_after: 'none', allow_system_keys: false, allow_user_desktop: false
  });
  assert.equal(action.isError, undefined);
  assert.equal(fixture.getActCalls(), 1);
  fixture.setSnapshotElements([{ selector: 'Root', type: 'Edit', value: 'new' }]);
  const diffResult = await fixture.tool('desktop_ui_snapshot')({
    window_id: windowId, include_tree: true, include_screenshot: false,
    interactive_only: true, max_elements: 3,
    diff_from_observation_id: before.computer_observation_id, diff_only: true
  });
  assert.equal(diffResult.isError, undefined);
  assert.equal(((fixture.decode(diffResult).ui_diff as Record<string, unknown>).changed as unknown[]).length, 1);
  const replay = await fixture.tool('desktop_ui_action')({
    window_id: windowId, computer_observation_id: before.computer_observation_id,
    action: 'set_value', selector: 'Root', value: 'again',
    settle_ms: 0, observe_after: 'none', allow_system_keys: false, allow_user_desktop: false
  });
  assert.equal(replay.isError, true);
  assert.equal(fixture.getActCalls(), 1);
});
