import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  flattenUiElementsForMcp,
  resolveWinAppPath,
  sanitizeUiElementForMcp,
  type ComputerWindow,
  type UiElementSummary
} from '../src/computer-use-backend.js';
import { ComputerObservationRegistry } from '../src/computer-use-observation.js';
import { ComputerUseCoordinator, ComputerWindowRegistry } from '../src/computer-use-registry.js';
import { prepareAgentDesktopAction } from '../src/computer-use-tools.js';
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


test('Agent Desktop background mode permits only non-injecting UI actions', () => {
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
    prepareAgentDesktopAction({ type: 'send_keys', keys: 'enter', transport: 'post-message' }),
    { type: 'send_keys', keys: 'enter', transport: 'post-message', allowSystemKeys: false }
  );
});

test('Agent Desktop background mode rejects physical input instead of stealing the user desktop', () => {
  const blocked = [
    { type: 'click', selector: 'ApplyButton' },
    { type: 'hover', selector: 'ApplyButton' },
    { type: 'drag', from: 'A', to: 'B' },
    { type: 'scroll', wheel: 3 },
    { type: 'send_keys', keys: 'hello', transport: 'send-input' },
    { type: 'send_keys', keys: 'win+r', transport: 'post-message', allowSystemKeys: true }
  ] as const;

  for (const action of blocked) {
    assert.throws(() => prepareAgentDesktopAction(action), /requires_foreground_input/i);
  }
});
