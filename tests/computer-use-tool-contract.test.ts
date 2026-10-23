import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AuditLogger } from '../src/audit.js';
import type { DesktopPolicy } from '../src/desktop-policy.js';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';
import type { ComputerUseRuntime } from '../src/computer-use-runtime.js';
import type { ComputerWindow, UiElementSummary } from '../src/computer-use-backend.js';
import { ComputerObservationRegistry } from '../src/computer-use-observation.js';
import { ComputerUseCoordinator, ComputerWindowRegistry } from '../src/computer-use-registry.js';
import { registerComputerUseTools } from '../src/computer-use-tools.js';
import { ComputerSnapshotRegistry } from '../src/computer-use-read-model.js';

type Response = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (input: Record<string, unknown>) => Promise<Response>;

function setup(agentDesktop?: AgentDesktopManager, targetClassName = 'FixtureWindow') {
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
    className: targetClassName, width: 800, height: 600, isForeground: true
  };
  let inspectFails = false;
  let elementsTruncated = true;
  let onInspect: (() => void) | undefined;
  let currentProcessId = target.processId;
  let snapshotElements: UiElementSummary[] = [{ type: 'Window', selector: 'Root', value: '' }];
  let fullScanElements: UiElementSummary[] | undefined;
  const inspectModes: boolean[] = [];
  let listFailureOnCall = Number.POSITIVE_INFINITY;
  let listCalls = 0;
  let actCalls = 0;
  const backend = {
    async listWindows() {
      listCalls += 1;
      if (listCalls >= listFailureOnCall) throw new Error('postaction enumeration lost');
      return [{ ...target, processId: currentProcessId }];
    },
    async inspect(_hwnd: number, interactiveOnly = true) {
      inspectModes.push(interactiveOnly);
      onInspect?.();
      if (inspectFails) throw new Error('screenshot or UIA unavailable');
      return { hwnd: target.hwnd, elements: interactiveOnly ? snapshotElements : (fullScanElements ?? snapshotElements), elementsTruncated };
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
  registerComputerUseTools(server, policy, audit, runtime, agentDesktop);
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
    setElementsTruncated(value: boolean) { elementsTruncated = value; },
    setInspectHook(callback: (() => void) | undefined) { onInspect = callback; },
    changeProcessIdentity(value: number) { currentProcessId = value; },
    setSnapshotElements(value: typeof snapshotElements) { snapshotElements = value; },
    setFullScanElements(value: UiElementSummary[]) { fullScanElements = value; },
    inspectModes() { return [...inspectModes]; },
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
  fixture.setElementsTruncated(false);
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

test('cooperative wait_for releases GUI coordinator between polls for a separate agent', async () => {
  const fixture = setup();
  fixture.setElementsTruncated(false);
  fixture.setSnapshotElements([{ type: 'Edit', selector: 'Root', value: 'pending' }]);
  const before = await fixture.snapshot();
  let completed = false;
  let notifyPoll!: () => void;
  const firstPoll = new Promise<void>(resolve => { notifyPoll = resolve; });
  fixture.setInspectHook(() => notifyPoll());
  const waiting = fixture.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'wait_for', selector: 'Root', wait_condition: 'value_equals',
    expected_value: 'ready', wait_ms: 1400, poll_ms: 250,
    allow_user_desktop: false, allow_system_keys: false
  }).then(response => { completed = true; return response; });

  // Wait for the initial scan; avoid timing-dependent sleeps in CI.
  await firstPoll;
  const snap = await fixture.snapshot();
  assert.equal(completed, false, 'a read-only snapshot must not queue behind an entire wait');
  const second = await fixture.tool('desktop_ui_action')({
    window_id: (snap.window as Record<string, unknown>).window_id,
    computer_observation_id: snap.computer_observation_id,
    action: 'set_value', selector: 'Root', value: 'ready',
    settle_ms: 0, observe_after: 'none',
    allow_user_desktop: false, allow_system_keys: false
  });
  assert.equal(second.isError, undefined);
  fixture.setSnapshotElements([{ type: 'Edit', selector: 'Root', value: 'ready' }]);
  const result = fixture.decode(await waiting);
  assert.equal(result.condition_met, true);
  assert.equal(result.action_dispatched, false);
  assert.equal(fixture.getActCalls(), 1, 'wait must not dispatch input');
});

test('cooperative wait_for fails closed when window identity changes between polls', async () => {
  const fixture = setup();
  const before = await fixture.snapshot();
  const windowId = (before.window as Record<string, unknown>).window_id;
  let notifyPoll!: () => void;
  const firstPoll = new Promise<void>(resolve => { notifyPoll = resolve; });
  fixture.setInspectHook(() => notifyPoll());
  // Under the same coordinator, a revoked window capability is detected on the next scan.
  const waiting = fixture.tool('desktop_ui_action')({
    window_id: windowId, computer_observation_id: before.computer_observation_id,
    action: 'wait_for', selector: 'unavailable', wait_ms: 1200, poll_ms: 200,
    allow_user_desktop: false, allow_system_keys: false
  });
  await firstPoll;
  fixture.changeProcessIdentity(303);
  // A reused HWND with a new PID must fail rather than match the old capability.
  const response = await waiting;
  assert.equal(response.isError, true);
  assert.match(response.content[0]?.text ?? '', /stale|unknown|changed/i);
});

test('cooperative wait_for rechecks Agent Desktop lease and fails closed after revocation', async () => {
  const leaseId = '11111111-1111-4111-8111-111111111111';
  let valid = true;
  let guardChecks = 0;
  const agentDesktop = {
    async activeLeaseForWindow() { return leaseId; },
    async assertLease(id: string) {
      assert.equal(id, leaseId);
      guardChecks += 1;
      if (!valid) throw new Error('Agent Desktop lease revoked');
    },
    async assertWindowOnLease(_hwnd: number, id: string) {
      assert.equal(id, leaseId);
      guardChecks += 1;
      if (!valid) throw new Error('Agent Desktop lease revoked');
    },
    async filterWindowsForLease<T>(windows: T[], id: string) {
      assert.equal(id, leaseId);
      if (!valid) throw new Error('Agent Desktop lease revoked');
      return windows;
    },
    async hasActiveControls() { return true; }
  } as unknown as AgentDesktopManager;
  const fixture = setup(agentDesktop);
  const before = await fixture.snapshot();
  let notifyPoll!: () => void;
  const firstPoll = new Promise<void>(resolve => { notifyPoll = resolve; });
  fixture.setInspectHook(() => notifyPoll());
  const waiting = fixture.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'wait_for', selector: 'NotPresent', wait_ms: 700, poll_ms: 100,
    allow_user_desktop: false, allow_system_keys: false
  });
  await firstPoll;
  valid = false;
  const result = await waiting;
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /lease revoked/i);
  assert.ok(guardChecks >= 3);
  assert.equal(fixture.getActCalls(), 0);
});

test('snapshot reports selector coverage and warns when UIA exposes zero elements', async () => {
  const f = setup();
  f.setSnapshotElements([]);
  const r = await f.snapshot();
  assert.equal((r.selector_coverage as Record<string, unknown>).scanned_elements, 0);
  assert.equal((r.selector_coverage as Record<string, unknown>).semantic_tree_empty, true);
  assert.equal(r.semantic_tree_status, 'limited');
  assert.match(String(r.semantic_tree_warning), /Do not infer that the app has no controls/i);
});

test('target_guard dispatches exactly once for one matching live UIA control', async () => {
  const f = setup();
  f.setElementsTruncated(false);
  f.setSnapshotElements([{ type: 'Button', selector: 'Root', name: 'Save', isEnabled: true }]);
  const before = await f.snapshot();
  const response = await f.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'invoke', selector: 'Root',
    target_guard: { type: 'Button', name: 'Save', require_enabled: true },
    settle_ms: 0, observe_after: 'none',
    allow_system_keys: false, allow_user_desktop: false
  });
  assert.equal(response.isError, undefined);
  assert.equal(f.getActCalls(), 1);
});

test('target_guard blocks changed, ambiguous and unobservable selectors without acting', async () => {
  for (const live of [
    [{ type: 'Button', selector: 'Root', name: 'Delete' }],
    [{ type: 'Button', selector: 'Root', name: 'Save' }, { type: 'Button', selector: 'Root', name: 'Save' }],
    []
  ]) {
    const f = setup();
    f.setElementsTruncated(false);
    f.setSnapshotElements([{ type: 'Button', selector: 'Root', name: 'Save' }]);
    const before = await f.snapshot();
    f.setSnapshotElements(live);
    const response = await f.tool('desktop_ui_action')({
      window_id: (before.window as Record<string, unknown>).window_id,
      computer_observation_id: before.computer_observation_id,
      action: 'invoke', selector: 'Root',
      target_guard: { type: 'Button', name: 'Save' },
      settle_ms: 0, observe_after: 'none',
      allow_system_keys: false, allow_user_desktop: false
    });
    assert.equal(response.isError, true);
    assert.equal(f.getActCalls(), 0);
  }
});

test('target_guard refuses actions without a selector before input dispatch', async () => {
  const f = setup();
  const before = await f.snapshot();
  const response = await f.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'wait', wait_ms: 0,
    target_guard: { type: 'Button' },
    settle_ms: 0, observe_after: 'none',
    allow_system_keys: false, allow_user_desktop: false
  });
  assert.equal(response.isError, true);
  assert.match(response.content[0]?.text ?? '', /exact selector/i);
  assert.equal(f.getActCalls(), 0);
});

test('target_guard does not dispatch from a known truncated tree', async () => {
  const f = setup();
  f.setSnapshotElements([{ type: 'Button', selector: 'Root', name: 'Save' }]);
  const before = await f.snapshot();
  const response = await f.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'invoke', selector: 'Root',
    target_guard: { type: 'Button', name: 'Save' },
    settle_ms: 0, observe_after: 'none',
    allow_system_keys: false, allow_user_desktop: false
  });
  assert.equal(response.isError, true);
  assert.match(response.content[0]?.text ?? '', /truncated UI tree/i);
  assert.equal(f.getActCalls(), 0);
});

test('target_guard preserves normal-desktop click capability and Agent Desktop click denial', async () => {
  const normal = setup();
  normal.setElementsTruncated(false);
  normal.setSnapshotElements([{ selector: 'Root', type: 'Button', name: 'Confirm' }]);
  const before = await normal.snapshot();
  const argumentsForAction = {
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'click',
    selector: 'Root',
    target_guard: { type: 'Button', name: 'Confirm' },
    settle_ms: 0, observe_after: 'none',
    allow_system_keys: false, allow_user_desktop: false
  };
  const normalResult = await normal.tool('desktop_ui_action')(argumentsForAction);
  assert.equal(normalResult.isError, undefined);
  assert.equal(normal.getActCalls(), 1);

  const leaseId = '11111111-1111-4111-8111-111111111111';
  const agentDesktop = {
    async activeLeaseForWindow() { return leaseId; },
    async assertLease() { return undefined; },
    async assertWindowOnLease() { return undefined; },
    async filterWindowsForLease<T>(windows: T[]) { return windows; },
    async hasActiveControls() { return true; }
  } as unknown as AgentDesktopManager;
  const isolated = setup(agentDesktop);
  isolated.setElementsTruncated(false);
  isolated.setSnapshotElements([{ selector: 'Root', type: 'Button', name: 'Confirm' }]);
  const isolatedBefore = await isolated.snapshot();
  const isolatedResult = await isolated.tool('desktop_ui_action')({
    ...argumentsForAction,
    window_id: (isolatedBefore.window as Record<string, unknown>).window_id,
    computer_observation_id: isolatedBefore.computer_observation_id
  });
  assert.equal(isolatedResult.isError, true);
  assert.match(isolatedResult.content[0]?.text ?? '', /requires_foreground_input/i);
  assert.equal(isolated.getActCalls(), 0);
});

test('wait_for auto mode discovers a WPF control excluded by interactive filtering', async () => {
  const f = setup();
  f.setElementsTruncated(false);
  f.setSnapshotElements([{ selector: 'Root', type: 'Window' }]);
  f.setFullScanElements([
    { selector: 'Root', type: 'Window' },
    { selector: 'WpfScroller', type: 'Pane', isEnabled: true }
  ]);
  const before = await f.snapshot();
  const r = await f.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'wait_for', selector: 'WpfScroller', wait_condition: 'present',
    wait_scan_mode: 'auto', wait_ms: 100, poll_ms: 100,
    allow_user_desktop: false, allow_system_keys: false
  });
  assert.equal(r.isError, undefined);
  const result = f.decode(r);
  assert.equal(result.condition_met, true);
  assert.equal(result.auto_fallback_to_full, true);
  assert.deepEqual(f.inspectModes(), [true, true, false]); // prior snapshot, then interactive, then full
  assert.equal(f.getActCalls(), 0);
});

test('wait_for interactive-only does not silently inspect excluded controls', async () => {
  const f = setup();
  f.setElementsTruncated(false);
  f.setSnapshotElements([{ selector: 'Root', type: 'Window' }]);
  f.setFullScanElements([{ selector: 'WpfScroller', type: 'Pane' }]);
  const before = await f.snapshot();
  const r = await f.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'wait_for', selector: 'WpfScroller', wait_scan_mode: 'interactive',
    wait_ms: 0, poll_ms: 100, allow_user_desktop: false, allow_system_keys: false
  });
  assert.equal(f.decode(r).condition_met, false);
  assert.deepEqual(f.inspectModes(), [true, true]);
});

test('target_guard defaults to full scan and can verify a noninteractive WPF control', async () => {
  const f = setup();
  f.setElementsTruncated(false);
  f.setSnapshotElements([{ selector: 'Root', type: 'Window' }]);
  f.setFullScanElements([{ selector: 'WpfScroller', type: 'Pane', automationId: 'WpfScroller', isEnabled: true }]);
  const before = await f.snapshot();
  const r = await f.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'invoke', selector: 'WpfScroller',
    target_guard: { type: 'Pane', automation_id: 'WpfScroller', require_enabled: true },
    settle_ms: 0, observe_after: 'none',
    allow_user_desktop: false, allow_system_keys: false
  });
  assert.equal(r.isError, undefined);
  assert.deepEqual(f.inspectModes(), [true, false]);
  assert.equal(f.getActCalls(), 1);
});

test('target_guard interactive scan mode rejects an invisible WPF selector', async () => {
  const f = setup();
  f.setElementsTruncated(false);
  f.setSnapshotElements([{ selector: 'Root', type: 'Window' }]);
  f.setFullScanElements([{ selector: 'WpfScroller', type: 'Pane' }]);
  const before = await f.snapshot();
  const r = await f.tool('desktop_ui_action')({
    window_id: (before.window as Record<string, unknown>).window_id,
    computer_observation_id: before.computer_observation_id,
    action: 'invoke', selector: 'WpfScroller',
    target_guard: { type: 'Pane', scan_mode: 'interactive' },
    settle_ms: 0, observe_after: 'none',
    allow_user_desktop: false, allow_system_keys: false
  });
  assert.equal(r.isError, true);
  assert.deepEqual(f.inspectModes(), [true, true]);
  assert.equal(f.getActCalls(), 0);
});

test('normal WinForms snapshot warns when WinApp returns only titlebar and system controls', async () => {
  const f = setup(undefined, 'WindowsForms10.Window.8.app.0.1234');
  f.setElementsTruncated(false);
  f.setSnapshotElements([
    { type: 'Window', className: 'WindowsForms10.Window.8.app.0.1234' },
    { type: 'TitleBar', automationId: 'TitleBar' },
    { type: 'Button', automationId: 'Close' }
  ]);
  const result = await f.snapshot();
  assert.equal(result.semantic_tree_truncated, false);
  assert.equal(result.semantic_tree_status, 'limited');
  assert.match(String(result.semantic_tree_warning), /WinForms child classes/i);
  assert.equal((result.selector_coverage as Record<string, unknown>).scope_complete, false);
});

test('normal WinForms snapshot does not warn once a real app control is exposed', async () => {
  const f = setup(undefined, 'WindowsForms10.Window.8.app.0.1234');
  f.setElementsTruncated(false);
  f.setSnapshotElements([
    { type: 'Window', className: 'WindowsForms10.Window.8.app.0.1234' },
    { type: 'Edit', className: 'WindowsForms10.Edit.app.0.1234', selector: 'EditBox' }
  ]);
  const result = await f.snapshot();
  assert.equal(result.semantic_tree_warning, undefined);
});
