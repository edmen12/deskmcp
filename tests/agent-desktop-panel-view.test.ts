import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const panelSource = readFileSync(
  path.join(process.cwd(), 'control-panel', 'wpf', 'AgentDesktopControl.cs'),
  'utf8'
);

const coordinatorTick = panelSource.split('private async void Tick()')[1]
  ?.split('private async Task EnsureSafetyOverlayAsync(')[0];
const ensureOverlay = panelSource.split('private async Task EnsureSafetyOverlayAsync(')[1]
  ?.split('private AgentDesktopControlPoolDocument UpdateControlDesktopNumbers(')[0];

test('Agent Desktop heartbeat never forces the user back to Desktop 1', () => {
  assert.ok(coordinatorTick, 'control coordinator must have an async Tick()');
  assert.doesNotMatch(coordinatorTick, /\bGoToDesktopNumber\s*\(/u);
  assert.match(coordinatorTick, /FindControlByDesktopId\(controls, currentDesktopId\)/u);
  assert.match(coordinatorTick, /WriteHudHeartbeats\(controls, currentControl\?\.LeaseId\)/u);
});

test('each controlled desktop has a verified safety HUD before heartbeat', () => {
  assert.ok(coordinatorTick && ensureOverlay);
  assert.match(coordinatorTick, /foreach\s*\(AgentDesktopControlDocument control in controls\)\s*\{\s*checkedLeaseId = control\.LeaseId;\s*await EnsureSafetyOverlayAsync\(control\);/u);
  assert.match(ensureOverlay, /safetyOverlay\.ShowOnDesktopAsync\(desktopId/u);
  assert.match(ensureOverlay, /safetyOverlay\.IsOnDesktop\(desktopId\)/u);
  assert.match(ensureOverlay, /HideOverlay\(leaseId\);\s*throw;/u);
  assert.match(panelSource, /new AgentDesktopOverlay\(control\.TaskLabel, \(\) => ExitControl\(leaseId\)\)/u);
});

test('safety overlay does not activate the agent desktop during creation', () => {
  const createEdge = panelSource.split('private Window CreateEdge(')[1]?.split('private static void StartEdgePulse(')[0];
  const createHud = panelSource.split('private Window CreateHud(')[1]?.split('private static void ApplyEdgeExtendedStyle(')[0];
  assert.ok(createEdge && createHud);
  assert.match(createEdge, /ShowActivated = false/u);
  assert.match(createHud, /ShowActivated = false/u);
  assert.match(createHud, /Exit Agent Control/u);
  assert.match(panelSource, /AgentDesktopWindowMover\.MoveOwnWindow\(hudWindow, desktopId\)/u);
});
