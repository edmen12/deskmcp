import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const observer=readFileSync(path.join(here,'Program.cs'),'utf8');
const wpf=readFileSync(path.join(here,'..','d2-wpf-matrix.ps1'),'utf8');
test('no native GUI launch before observer fail-closed preflight',()=>{
 const gate=wpf.indexOf('try{Assert-ForegroundIsolation}catch');
 const launch=wpf.indexOf('$owned=Start-Process');
 assert.ok(gate>0 && launch>gate);
 assert.match(wpf,/PASSIVE_DESKTOP_SWITCH_OBSERVER_REQUIRED_BEFORE_ANY_GUI_ACTION/);
 assert.match(wpf,/DESKTOP_SWITCH_TRIPWIRE_LATCHED_ABORT_ALL_GUI_ACTIONS/);
});
test('native calls and UIA actions are guarded before and after',()=>{
 const native=wpf.match(/function N\(\[string\[\]\]\$params\) \{([\s\S]*?)\n\}/)?.[1];
 const uia=wpf.match(/function W\(\[string\[\]\]\$params\) \{([\s\S]*?)\n\}/)?.[1];
 assert.ok(native && uia);
 for(const body of [native,uia]){
  const first=body.indexOf('Assert-ForegroundIsolation');
  assert.ok(first>=0);
  const invocation=body.includes('$winapp ui')?body.indexOf('$winapp ui'):body.indexOf('$native @params');
  assert.ok(invocation>first);
  assert.ok(body.indexOf('Assert-ForegroundIsolation',invocation)>invocation);
 }
});
test('monitor uses only message-only notification and passive foreground hooks',()=>{
 for(const s of ['new IntPtr(-3)','RegisterPostMessageHook','SetWinEventHook','GetCurrentDesktopNumber','NO_AUTO_RETURN','attribution = "UNKNOWN_UNTIL_OWNER_CORRELATION"'])
   assert.ok(observer.includes(s),s);
 for(const prohibited of [/\bGoToDesktopNumber\s*\(/,/\bSetForegroundWindow\s*\(/,/\bSendInput\s*\(/,/\bSetCursorPos\s*\(/,/\bGetClipboardData\s*\(/])
   assert.doesNotMatch(observer,prohibited);
});
test('record action stamps without user text or target values',()=>{
 assert.match(wpf,/gui-action-timeline\.jsonl/);
 assert.match(wpf,/Trace-Action 'START' 'winapp-uia' \$params\[0\]/);
 assert.doesNotMatch(wpf,/Trace-Action[^\n]*\$params\[2\]/);
});

test('native HWND message bridge refuses background input while owner is not on Desktop1',()=>{
 const bridge=readFileSync(path.join(here,'..','..','agent-desktop-host','BackgroundWindowInput.cs'),'utf8');
 assert.match(bridge,/if \(current\.Value != 0\)/);
 assert.match(bridge,/Owner left Desktop 1; autonomous Agent background input is paused/);
 assert.match(bridge,/if \(currentDesktopNumber\(\) != 0\)/);
 assert.match(bridge,/Owner desktop changed during background input/);
 assert.match(bridge,/IsWindowOnCurrentVirtualDesktop\(root\)/);
});

test('WPF root and owned popup opt out of activation before DWM uncloak',()=>{
 const fixture=readFileSync(path.join(here,'..','desktop2-wpf-probe','Program.cs'),'utf8');
 assert.match(fixture,/WsExNoactivate=0x08000000L/);
 assert.match(fixture,/Native\.MakeNonActivating\(rootHwnd\)/);
 assert.match(fixture,/Native\.MakeNonActivating\(hwnd\)/);
 assert.match(fixture,/window\.Owner=this/);
 assert.match(fixture,/ROOT_WM_/);
 assert.match(fixture,/POPUP_WM_/);
 assert.ok(fixture.indexOf('Native.MakeNonActivating(rootHwnd)') < fixture.indexOf('DwmSetWindowAttribute(rootHwnd'));
 assert.ok(fixture.lastIndexOf('Native.MakeNonActivating(hwnd)') < fixture.indexOf('DwmSetWindowAttribute(hwnd'));
});

test('target-PID foreground theft causes early latched abort while Desktop1 is still current',()=>{
  assert.match(observer,/TARGET_FOREGROUND_EARLY_ABORT/);
  assert.match(observer,/GetAncestor\(hwnd, 2\)/);
  assert.match(observer,/watched\.Hwnd, watched\.ProcessId, watched\.DesktopIndex/);
  assert.match(observer,/current == 0 && watchedDesktopIndex >= 1/);
  assert.match(observer,/forceAbort: true/);
  assert.match(observer,/policy\.Observe\(forceAbort \? -1 : desktopIndex, kind\)/);
  assert.match(observer,/CheckWatchedForeground\(hwnd, pid, current\)/);
  assert.match(observer,/CheckWatchedForeground\(front, frontPid, current\)/);
  assert.match(observer,/FOREGROUND_MONITOR_FAILED/);
});

test('observer target watch is opt-in, own-file-only and cannot switch owner desktop',()=>{
  assert.match(observer,/--observe-target/);
  assert.match(observer,/watchedTargetFile = watchFile/);
  assert.match(observer,/Path\.IsPathFullyQualified\(watchFile\)/);
  assert.match(observer,/--self-test-foreground/);
  assert.doesNotMatch(observer,/\bSetForegroundWindow\s*\(/);
  assert.doesNotMatch(observer,/\bGoToDesktopNumber\s*\(/);
  assert.doesNotMatch(observer,/\bSendInput\s*\(/);
});
