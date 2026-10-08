import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  flattenUiElementsForMcp,
  parseComputerWindows,
  resolveWinAppPath,
  sanitizeUiElementForMcp,
  type ComputerWindow,
  type UiElementSummary
} from '../src/computer-use-backend.js';
import { ComputerObservationRegistry } from '../src/computer-use-observation.js';
import { ComputerUseCoordinator, ComputerWindowRegistry } from '../src/computer-use-registry.js';
import {
  agentDesktopSemanticTreeWarning,
  assertUnscopedUserDesktopActionAllowed,
  isolatedDesktopTextTarget,
  isolatedSemanticClickTarget,
  prepareAgentDesktopAction,
  resolveAgentDesktopWindowLease,
  verifiedLiteralInsertion
} from '../src/computer-use-tools.js';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';
import { DesktopPolicy } from '../src/desktop-policy.js';
import { TEST_AREA } from '../src/paths.js';

function windowFixture(overrides: Partial<ComputerWindow> = {}): ComputerWindow {
  return {
    hwnd: 100,
    processId: 200,
    processName: 'fixture',
    title: 'Fixture',
    className: 'FixtureWindow',
    width: 800,
    height: 600,
    isForeground: true,
    ...overrides
  };
}

test('computer backend accepts zero-sized shell windows without failing the whole list', () => {
  const windows = parseComputerWindows([
    windowFixture(),
    windowFixture({
      hwnd: 101,
      processId: 201,
      processName: 'ShellExperienceHost',
      title: 'New notification',
      width: 396,
      height: 0,
      isForeground: false
    })
  ]);
  assert.equal(windows.length, 2);
  assert.equal(windows[1]?.height, 0);
  assert.throws(() => parseComputerWindows([
    windowFixture({ height: -1 })
  ]), /fields are invalid/i);
});

test('computer observations are one-time and window-bound', () => {
  const observations = new ComputerObservationRegistry(16, 30_000);
  const first = observations.issue('window-a', 1_000);
  observations.consume(first, 'window-a', 2_000);
  assert.throws(
    () => observations.consume(first, 'window-a', 2_001),
    /missing, expired, or already used/i
  );

  const wrongWindow = observations.issue('window-a', 3_000);
  assert.throws(
    () => observations.consume(wrongWindow, 'window-b', 3_001),
    /does not belong/i
  );
});

test('Agent Desktop observations retain lease safety even when the caller omits the lease later', () => {
  const observations = new ComputerObservationRegistry(16, 30_000);
  const leaseA = '11111111-1111-4111-8111-111111111111';
  const leaseB = '22222222-2222-4222-8222-222222222222';

  const inherited = observations.issue('window-a', 1_000, leaseA);
  assert.equal(observations.consume(inherited, 'window-a', 2_000), leaseA);

  const wrongLease = observations.issue('window-a', 3_000, leaseA);
  assert.throws(
    () => observations.consume(wrongLease, 'window-a', 3_001, leaseB),
    /different Agent Desktop lease/i
  );

  const normalDesktop = observations.issue('window-a', 4_000);
  assert.throws(
    () => observations.consume(normalDesktop, 'window-a', 4_001, leaseA),
    /was not captured from an Agent Desktop lease/i
  );
});

test('one UI action invalidates sibling observations from the same state', () => {
  const observations = new ComputerObservationRegistry(16, 30_000);
  const agentA = observations.issue('window-a', 1_000);
  const agentB = observations.issue('window-a', 1_001);

  observations.consume(agentA, 'window-a', 2_000);
  observations.advance('window-a');

  assert.throws(
    () => observations.consume(agentB, 'window-a', 2_001),
    /stale because another UI action/i
  );
  const refreshed = observations.issue('window-a', 2_002);
  assert.doesNotThrow(() => observations.consume(refreshed, 'window-a', 2_003));
});

test('global physical input invalidates observations for other windows', () => {
  const observations = new ComputerObservationRegistry(16, 30_000);
  const windowA = observations.issue('window-a', 1_000);
  const windowB = observations.issue('window-b', 1_001);

  observations.consume(windowA, 'window-a', 2_000);
  observations.advance('window-a', true);

  assert.throws(
    () => observations.consume(windowB, 'window-b', 2_001),
    /global mouse or keyboard input/i
  );
  const refreshed = observations.issue('window-b', 2_002);
  assert.doesNotThrow(() => observations.consume(refreshed, 'window-b', 2_003));
});

test('computer observations expire quickly', () => {
  const observations = new ComputerObservationRegistry(16, 1_000);
  const id = observations.issue('window-a', 10_000);
  assert.throws(
    () => observations.consume(id, 'window-a', 11_001),
    /missing, expired, or already used/i
  );
});

test('window capabilities reject HWND reuse by another process', () => {
  const registry = new ComputerWindowRegistry();
  const original = windowFixture();
  const id = registry.issue(original);

  assert.equal(registry.resolve(id, [original]).processId, original.processId);
  assert.throws(
    () => registry.resolve(id, [windowFixture({ processId: original.processId + 1 })]),
    /changed or closed/i
  );
});

test('window capability remains stable while the same window identity is live', () => {
  const registry = new ComputerWindowRegistry();
  const original = windowFixture();
  assert.equal(registry.issue(original), registry.issue({ ...original, title: 'Renamed Fixture' }));
});

test('computer-use coordinator serializes concurrent GUI operations and recovers after failure', async () => {
  const coordinator = new ComputerUseCoordinator();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

  const first = coordinator.exclusive(async () => {
    order.push('first:start');
    await firstGate;
    order.push('first:end');
  });
  const second = coordinator.exclusive(async () => {
    order.push('second:start');
    order.push('second:end');
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);

  await assert.rejects(
    coordinator.exclusive(async () => { throw new Error('expected'); }),
    /expected/
  );
  await assert.doesNotReject(coordinator.exclusive(async () => undefined));
});

test('computer use is session-only Full Control / Fully Unlocked capability', async () => {
  const read = await DesktopPolicy.create({ profile: 'read-only', allowedRoots: [TEST_AREA] });
  const write = await DesktopPolicy.create({ profile: 'workspace-write', allowedRoots: [TEST_AREA] });
  const full = await DesktopPolicy.create({ profile: 'full-control', allowedRoots: [TEST_AREA] });
  const unlock = await DesktopPolicy.create({ profile: 'fully-unlocked', allowedRoots: [TEST_AREA] });

  assert.equal(read.info().computerUseEnabled, false);
  assert.equal(write.info().computerUseEnabled, false);
  assert.equal(full.info().computerUseEnabled, true);
  assert.equal(unlock.info().computerUseEnabled, true);
  assert.throws(() => read.assertCanUseComputer(), /Full Control or Fully Unlocked/i);
  assert.throws(() => write.assertCanUseComputer(), /Full Control or Fully Unlocked/i);
  assert.doesNotThrow(() => full.assertCanUseComputer());
  assert.doesNotThrow(() => unlock.assertCanUseComputer());
});

test('computer backend availability requires the companion native runtime', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-winapp-path-'));
  const exe = path.join(temp, 'winapp.exe');
  const skia = path.join(temp, 'libSkiaSharp.dll');
  const previous = process.env.DESKTOP_MCP_WINAPP_PATH;
  try {
    await writeFile(exe, 'placeholder');
    process.env.DESKTOP_MCP_WINAPP_PATH = exe;
    assert.throws(() => resolveWinAppPath(), /libSkiaSharp\.dll is missing/i);
    await writeFile(skia, 'placeholder');
    assert.equal(resolveWinAppPath(), path.resolve(exe));
  } finally {
    if (previous === undefined) delete process.env.DESKTOP_MCP_WINAPP_PATH;
    else process.env.DESKTOP_MCP_WINAPP_PATH = previous;
    await rm(temp, { recursive: true, force: true });
  }
});

test('UI element projection drops backend-internal fields', () => {
  const raw = {
    type: 'Edit',
    name: 'Input',
    automationId: 'InputBox',
    selector: 'InputBox',
    value: 'hello',
    x: 10,
    y: 20,
    width: 100,
    height: 24,
    isInvokable: false,
    ancestorPath: ['Window'],
    processId: 999,
    hwnd: 12345,
    internalProvider: 'must-not-leak'
  } as UiElementSummary & Record<string, unknown>;

  const projected = sanitizeUiElementForMcp(raw);
  assert.deepEqual(projected, {
    type: 'Edit',
    name: 'Input',
    automationId: 'InputBox',
    x: 10,
    y: 20,
    width: 100,
    height: 24,
    selector: 'InputBox',
    value: 'hello',
    ancestorPath: ['Window'],
    isInvokable: false
  });
  assert.equal('processId' in projected, false);
  assert.equal('hwnd' in projected, false);
  assert.equal('internalProvider' in projected, false);
});
test('tree-form WinApp inspect output is flattened into the stable MCP schema', () => {
  const projected = flattenUiElementsForMcp([
    {
      type: 'Window',
      name: 'Fixture',
      children: [
        {
          type: 'Edit',
          automationId: 'InputBox',
          selector: 'InputBox',
          value: 'hello',
          processId: 999
        },
        {
          type: 'TitleBar',
          children: [
            { type: 'Button', automationId: 'Close', selector: 'Close' }
          ]
        }
      ],
      hwnd: 12345
    }
  ], 10);

  assert.deepEqual(projected.map(element => element.type), ['Window', 'Edit', 'TitleBar', 'Button']);
  assert.deepEqual(projected[1]?.ancestorPath, ['Window']);
  assert.deepEqual(projected[3]?.ancestorPath, ['Window', 'TitleBar']);
  assert.equal(projected[1]?.value, 'hello');
  assert.equal('processId' in (projected[1] ?? {}), false);
  assert.equal('hwnd' in (projected[0] ?? {}), false);
});

test('Agent Desktop warns when Windows Forms semantic UIA collapses to window chrome only', () => {
  const winforms = windowFixture({ className: 'WindowsForms10.Window.8.app.0.1234' });
  const warning = agentDesktopSemanticTreeWarning(winforms, [
    { type: 'Window', className: 'WindowsForms10.Window.8.app.0.1234' },
    { type: 'TitleBar', automationId: 'TitleBar' },
    { type: 'Button', automationId: 'Close', name: 'Close' }
  ]);
  assert.match(warning ?? '', /semantic_tree_limited/i);

  assert.equal(agentDesktopSemanticTreeWarning(winforms, [
    { type: 'Window', className: 'WindowsForms10.Window.8.app.0.1234' },
    { type: 'Edit', className: 'WindowsForms10.EDIT.app.0.1234', automationId: 'InputBox' }
  ]), undefined);

  assert.equal(agentDesktopSemanticTreeWarning(
    windowFixture({ className: 'HwndWrapper[DefaultDomain;;1234]' }),
    [{ type: 'Window', className: 'Window' }]
  ), undefined);
});


test('Agent Desktop isolated desktop permits semantic UIA actions and wait', () => {
  assert.deepEqual(
    prepareAgentDesktopAction({ type: 'invoke', selector: 'ApplyButton' }),
    { type: 'invoke', selector: 'ApplyButton' }
  );
  assert.deepEqual(
    prepareAgentDesktopAction({ type: 'set_value', selector: 'AgentInput', value: 'ok' }),
    { type: 'set_value', selector: 'AgentInput', value: 'ok' }
  );
  assert.deepEqual(
    prepareAgentDesktopAction({ type: 'scroll', selector: 'List', direction: 'down' }),
    { type: 'scroll', selector: 'List', direction: 'down' }
  );
  assert.deepEqual(
    prepareAgentDesktopAction({ type: 'scroll', selector: 'List', to: 'bottom' }),
    { type: 'scroll', selector: 'List', to: 'bottom' }
  );
  assert.deepEqual(
    prepareAgentDesktopAction({ type: 'wait', milliseconds: 50 }),
    { type: 'wait', milliseconds: 50 }
  );
});

test('isolated post-message accepts only explicit bounded literal input', () => {
  assert.deepEqual(prepareAgentDesktopAction({
    type: 'send_keys', keys: 'AQP 123', selector: 'ProbeEdit', verbatim: true
  }), {
    type: 'send_keys', keys: 'AQP 123', selector: 'ProbeEdit', verbatim: true,
    transport: 'post-message', allowSystemKeys: false
  });
  for (const action of [
    { type: 'send_keys', keys: 'abc', selector: 'ProbeEdit' },
    { type: 'send_keys', keys: 'abc', verbatim: true },
    { type: 'send_keys', keys: 'abc', selector: 'ProbeEdit', verbatim: true, transport: 'send-input' },
    { type: 'send_keys', keys: 'abc', selector: 'ProbeEdit', verbatim: true, allowSystemKeys: true },
    { type: 'send_keys', keys: 'a\nb', selector: 'ProbeEdit', verbatim: true },
    { type: 'send_keys', keys: 'x'.repeat(129), selector: 'ProbeEdit', verbatim: true }
  ] as const) {
    assert.throws(() => prepareAgentDesktopAction(action), /requires_foreground_input/i);
  }
});

test('isolated post-message refuses other apps and non-Edit controls', () => {
  const winforms = windowFixture({ className: 'WindowsForms10.Window.8.app.0.test' });
  const input: UiElementSummary = {
    type: 'Edit', selector: 'ProbeEdit', className: 'WindowsForms10.EDIT.app.0.test',
    isEnabled: true, isOffscreen: false, value: 'before'
  };
  assert.deepEqual(isolatedDesktopTextTarget(winforms, [input], 'ProbeEdit'), input);
  for (const item of [
    {window:windowFixture(), elements:[input]},
    {window:winforms, elements:[{...input, type:'Button'}]},
    {window:winforms, elements:[{...input, isEnabled:false}]},
    {window:winforms, elements:[{...input, isOffscreen:true}]},
    {window:winforms, elements:[input,input]},
    {window:winforms, elements:[{...input, className:'HwndWrapper[probe]'}]}
  ]) {
    assert.throws(() => isolatedDesktopTextTarget(item.window, item.elements, 'ProbeEdit'), /requires_foreground_input/i);
  }
});

test('isolated post-message accepts only unique enabled WPF TextBox, not arbitrary controls', () => {
  const wpfWindow = windowFixture({ className: 'HwndWrapper[DefaultDomain;test]' });
  const first: UiElementSummary = {
    type: 'Edit', selector: 'FirstText', className: 'TextBox',
    isEnabled: true, isOffscreen: false, value: 'FIRST_'
  };
  const second = { ...first, selector: 'SecondText', value: 'SECOND_' };
  assert.deepEqual(isolatedDesktopTextTarget(wpfWindow, [first, second], 'SecondText'), second);
  for (const target of [
    { win: windowFixture(), el: second },
    { win: wpfWindow, el: { ...second, className: 'PasswordBox' } },
    { win: wpfWindow, el: { ...second, type: 'Button' } },
    { win: wpfWindow, el: { ...second, isEnabled: false } },
    { win: wpfWindow, el: { ...second, isOffscreen: true } }
  ]) {
    assert.throws(() => isolatedDesktopTextTarget(target.win, [target.el], 'SecondText'), /requires_foreground_input/i);
  }
  assert.throws(() => isolatedDesktopTextTarget(wpfWindow, [second, second], 'SecondText'), /requires_foreground_input/i);
});

test('isolated post-message readback verifies one exact insertion at any caret position', () => {
  assert.equal(verifiedLiteralInsertion(undefined, 'ABC', 'ABC'), true);
  assert.equal(verifiedLiteralInsertion('', 'ABC', 'ABC'), true);
  assert.equal(verifiedLiteralInsertion('BASE_', 'ABCBASE_', 'ABC'), true);
  assert.equal(verifiedLiteralInsertion('BASE_', 'BASE_ABC', 'ABC'), true);
  assert.equal(verifiedLiteralInsertion('LEFT_RIGHT', 'LEFTABC_RIGHT', 'ABC'), true);
  assert.equal(verifiedLiteralInsertion('SECOND_', 'SEABC COND_', 'ABC'), false);
  assert.equal(verifiedLiteralInsertion('SECOND_', 'SEABCCOND_', 'ABC'), true);
  assert.equal(verifiedLiteralInsertion('BASE_', 'ABC', 'ABC'), false);
  assert.equal(verifiedLiteralInsertion('BASE_', 'ABCBASE_X', 'ABC'), false);
  assert.equal(verifiedLiteralInsertion('BASE_', undefined, 'ABC'), false);
  assert.equal(verifiedLiteralInsertion('BASE_', 'BASE_', 'ABC'), false);
  assert.equal(verifiedLiteralInsertion('BASE_', 'BASE_ABCABC', 'ABC'), false);
});

test('isolated semantic click only accepts a uniquely observed UIA-invokable button', () => {
  const apply: UiElementSummary = {
    type: 'Button', selector: 'ApplyButton', className: 'Button',
    isEnabled: true, isOffscreen: false, isInvokable: true
  };
  assert.deepEqual(isolatedSemanticClickTarget([apply], 'ApplyButton'), apply);
  for (const elements of [
    [],
    [apply, apply],
    [{ ...apply, type: 'Edit' }],
    [{ ...apply, isEnabled: false }],
    [{ ...apply, isOffscreen: true }],
    [{ type: 'Button', selector: 'ApplyButton', isEnabled: true, isInvokable: true }],
    [{ ...apply, isInvokable: false }],
    [{ ...apply, selector: 'OtherButton' }]
  ]) {
    assert.throws(() => isolatedSemanticClickTarget(elements, 'ApplyButton'), /requires_foreground_input/i);
  }
});

test('Agent Desktop isolated desktop still rejects unverified global input paths', () => {
  const blocked = [
    { type: 'send_keys', keys: 'hello', transport: 'post-message' },
    { type: 'send_keys', keys: 'hello', transport: 'send-input' },
    { type: 'send_keys', keys: 'win+r', transport: 'post-message', allowSystemKeys: true },
    { type: 'click', selector: 'ApplyButton', button: 'right' },
    { type: 'click', selector: 'ApplyButton', double: true },
    { type: 'hover', selector: 'ApplyButton' },
    { type: 'drag', from: 'A', to: 'B' },
    { type: 'scroll', wheel: 3 }
  ] as const;

  for (const action of blocked) {
    assert.throws(() => prepareAgentDesktopAction(action), /requires_foreground_input/i);
  }
});

test('Agent Desktop target windows inherit lease scope even when the caller omits it', async () => {
  const leaseId = '11111111-1111-4111-8111-111111111111';
  let lookupCount = 0;
  const agentDesktop = {
    async activeLeaseForWindow(hwnd: number) {
      lookupCount += 1;
      assert.equal(hwnd, 100);
      return leaseId;
    },
    async hasActiveControls() {
      return true;
    }
  } as unknown as AgentDesktopManager;

  assert.equal(await resolveAgentDesktopWindowLease(agentDesktop, 100), leaseId);
  assert.equal(lookupCount, 1);
  assert.deepEqual(
    prepareAgentDesktopAction({ type: 'click', selector: 'ApplyButton' }),
    { type: 'click', selector: 'ApplyButton' }
  );

  assert.equal(
    await resolveAgentDesktopWindowLease(agentDesktop, 100, leaseId),
    leaseId
  );
  assert.equal(lookupCount, 1);
});

test('Desktop 1 actions require an explicit escape while Agent Desktop control is active', async () => {
  const activeAgentDesktop = {
    async hasActiveControls() {
      return true;
    }
  } as unknown as AgentDesktopManager;

  await assert.rejects(
    assertUnscopedUserDesktopActionAllowed(activeAgentDesktop, undefined, false),
    /allow_user_desktop=true/i
  );
  await assert.doesNotReject(
    assertUnscopedUserDesktopActionAllowed(activeAgentDesktop, undefined, true)
  );
  await assert.doesNotReject(
    assertUnscopedUserDesktopActionAllowed(
      activeAgentDesktop,
      '11111111-1111-4111-8111-111111111111',
      false
    )
  );

  const idleAgentDesktop = {
    async hasActiveControls() {
      return false;
    }
  } as unknown as AgentDesktopManager;
  await assert.doesNotReject(
    assertUnscopedUserDesktopActionAllowed(idleAgentDesktop, undefined, false)
  );
});
