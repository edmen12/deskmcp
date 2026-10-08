import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const source=readFileSync(path.join(dir,'Program.cs'),'utf8');

test('no WinApp CLI or global foreground/input desktop APIs in direct UIA bridge',()=>{
  for(const forbidden of [
    /\bSendInput\s*\(/,/\bSetForegroundWindow\s*\(/,/\bSwitchDesktop\s*\(/,
    /\bSetCursorPos\s*\(/,/\bClipCursor\s*\(/,/\bGetClipboardData\s*\(/,
    /\bGoToDesktopNumber\s*\(/,/\bFocus\s*\(/,/\bSetFocus\s*\(/,
    /\bWindowPattern\.SetWindowVisualState\s*\(/
  ]) assert.doesNotMatch(source,forbidden);
  assert.doesNotMatch(source,/winapp\.exe|Process\.Start\(["']winapp|PostMessageW\(/i);
});

test('explicit HWND/PID and true Windows Desktop2 GUID plus active Desktop1 guard',()=>{
  for(const required of [
    'GetWindowThreadProcessId(root, out uint pid)',
    'pid != checked((uint)processId)',
    'desktopManager.GetWindowDesktopId(root) != desktopId',
    'desktopManager.IsWindowOnCurrentVirtualDesktop(root)',
    'GetAncestor(hwnd, GaRoot)',
    'SemanticPolicy.DemandOwnerDesktop(Current())'
  ]) assert.ok(source.includes(required),required);
});

test('live observer is mandatory before and after each UIA action',()=>{
  const perform=source.match(/private static object Perform\(Request request, Native.Context ctx\)([\s\S]*?)\n    \/\/ Offline self-test/)?.[1];
  assert.ok(perform);
  assert.match(perform,/ObserverGuard\.AssertLive\(request\.ObserverReady\)/);
  assert.match(perform,/ctx\.VerifyTarget\(hwnd, request\.ProcessId, targetId\)/);
  assert.match(perform,/Guard\(\);\s*pattern\.SetValue\(request\.Value!\);\s*Guard\(\)/);
  assert.match(perform,/Guard\(\);\s*pattern\.SetScrollPercent\(ScrollPattern\.NoScroll, percent\);\s*Guard\(\)/);
  assert.match(source,/ready\.ProcessId <= 0/);
  assert.match(source,/PASSIVE_OBSERVER_WRONG_PROCESS/);
  assert.match(source,/PASSIVE_OBSERVER_PID_REUSED/);
  assert.match(source,/DESKTOP_SWITCH_TRIPWIRE_LATCHED/);
});

test('direct UIA supports only bounded ValuePattern and ScrollPattern; invocation stays closed',()=>{
  for(const required of [
    'ValuePattern.Pattern','pattern.SetValue(request.Value!)','pattern.Current.Value',
    'ScrollPattern.Pattern','pattern.SetScrollPercent(ScrollPattern.NoScroll, percent)',
    'pattern.Current.VerticalScrollPercent',
    'ONLY_WPF_OR_WINFORMS_TEXTBOX_VALUEPATTERN',
    'INVOKE_DISABLED_UNTIL_DESKTOP2_POPUP_ACTIVATION_ACCEPTANCE'
  ]) assert.ok(source.includes(required),required);
  assert.doesNotMatch(source,/\bInvokePattern\.Invoke\s*\(/);
  assert.doesNotMatch(source,/\bSetKeyboardFocus\s*\(/);
  assert.doesNotMatch(source,/\bLegacyIAccessiblePattern\s*\(/);
});

test('no request value in successful output or event logging',()=>{
  assert.match(source,/uiaReadbackConfirmed = true/);
  assert.match(source,/appEventConfirmed = false/);
  assert.doesNotMatch(source,/appStateConfirmed = true/);
  assert.doesNotMatch(source,/Console\.WriteLine\([^)]*request\.Value/);
  assert.doesNotMatch(source,/Console\.Error\.WriteLine\([^)]*request\.Value/);
  assert.match(source,/req\.Value\.Length > 2048/);
});

test('legacy WPF+WinApp GUI matrix is quarantined before any GUI process launch',()=>{
  const old=readFileSync(path.join(dir,'..','d2-wpf-matrix.ps1'),'utf8');
  const block=old.indexOf('GUI_MATRIX_QUARANTINED_4_USER_CONFIRMED_DESKTOP_SWITCHES');
  const launch=old.indexOf('$owned=Start-Process');
  assert.ok(block>0 && launch>block);
  assert.match(old.slice(0,launch),/exit 4/);
});
