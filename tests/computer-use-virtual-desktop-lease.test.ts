import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const src = readFileSync(path.join(process.cwd(), 'src', 'computer-use-tools.ts'), 'utf8').replaceAll('\r\n', '\n');

function block(start: string, end: string) {
  const part = src.split(start)[1]?.split(end)[0];
  assert.ok(part, 'expected Computer Use block: ' + start);
  return part;
}

test('Desktop 2 window enumeration filters by verified virtual desktop GUID', () => {
  const list = block("server.registerTool(\n    'desktop_ui_windows'", "server.registerTool(\n    'desktop_ui_snapshot'");
  assert.match(list, /runtime\.backend\.listWindows\(app\)/u);
  assert.match(list, /filterWindowsForLease\(windows, agent_desktop_lease_id\)/u);
  assert.doesNotMatch(list, /desktopObjectNameForLease/u);
  assert.doesNotMatch(list, /object-windows/u);
});

test('leased snapshots never mistake Windows virtual desktops for Win32 desktop objects', () => {
  const snap = block("server.registerTool(\n    'desktop_ui_snapshot'", "server.registerTool(\n    'desktop_ui_action'");
  assert.match(snap, /filterWindowsForLease\(all, agent_desktop_lease_id\)/u);
  assert.match(snap, /assertWindowOnLease\(target\.hwnd, effectiveAgentDesktopLeaseId\)/u);
  assert.doesNotMatch(snap, /desktopObjectNameForLease/u);
});

test('leased UI actions revalidate target virtual desktop identity before and after execution', () => {
  const action = block("server.registerTool(\n    'desktop_ui_action'", "server.registerTool(");
  assert.match(action, /filterWindowsForLease\(liveWindows, scopedLeaseId\)/u);
  assert.match(action, /assertWindowOnLease\(target\.hwnd, effectiveAgentDesktopLeaseId\)/u);
  assert.match(action, /runtime\.backend\.act\(target\.hwnd, action\)/u);
  assert.match(action, /assertWindowOnLease\(refreshed\.hwnd, effectiveAgentDesktopLeaseId\)/u);
  assert.match(action, /prepareAgentDesktopAction\(parsedAction\)/u);
  assert.doesNotMatch(action, /desktopObjectNameForLease/u);
  assert.doesNotMatch(action, /listWindows\(undefined, desktopObjectName\)/u);
});
