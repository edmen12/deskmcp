import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync(path.join(process.cwd(), 'control-panel', 'wpf', 'AgentDesktopControl.cs'), 'utf8');
const start = source.indexOf('public async Task ShowOnDesktopAsync(');
const end = source.indexOf('private Window CreateEdge(', start);
const placement = source.slice(start, end);

test('HUD top-level WPF opacity stays stable while only child visuals are hidden before moving Desktop 2', () => {
  assert.ok(start > 0 && end > start, 'Safety overlay source was found');
  assert.match(placement, /hudWindow\.BeginAnimation\(UIElement\.OpacityProperty, null\)/);
  assert.match(placement, /hudWindow\.Opacity = 1/);
  assert.match(placement, /hudVisual\.Opacity = 0/);
  assert.match(placement, /MoveOwnWindow\(edgeWindow, desktopId\)/);
  assert.match(placement, /MoveOwnWindow\(hudWindow, desktopId\)/);
  assert.match(placement, /hudVisual\.Opacity = 1/);
  assert.doesNotMatch(placement, /hudWindow\.Opacity = 0/);
  const afterMove = placement.split('MoveOwnWindow(hudWindow, desktopId)')[1] ?? '';
  assert.doesNotMatch(afterMove, /hudWindow\.Opacity\s*=/, 'Changing top-level opacity after moving can invalidate its Desktop ID');
});

test('HUD location loss still revokes rather than pretending a lease is safe', () => {
  assert.match(source, /if \(!safetyOverlay\.IsOnDesktop\(desktopId\)\)/);
  assert.match(source, /safetyOverlay\.PlacementDiagnostics/);
  assert.match(source, /DescribeOwnWindowDesktop\(edgeWindow\)/);
  assert.match(source, /DescribeOwnWindowDesktop\(hudWindow\)/);
  assert.match(source, /TryRevokeAfterSafetyFailure\(checkedLeaseId, error\.Message\)/);
  assert.match(source, /if \(!String\.IsNullOrWhiteSpace\(leaseId\)\) RevokeControl\(leaseId\)/);
  assert.doesNotMatch(placement, /GoToDesktopNumber\s*\(/, 'No automatic foreground desktop switch');
});
