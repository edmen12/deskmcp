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
  assert.doesNotMatch(perform,/\bpattern\.SetValue\s*\(/);
  assert.match(perform,/Guard\(\);\s*pattern\.SetScrollPercent\(ScrollPattern\.NoScroll, percent\);\s*Guard\(\)/);
  assert.match(source,/ready\.ProcessId <= 0/);
  assert.match(source,/PASSIVE_OBSERVER_WRONG_PROCESS/);
  assert.match(source,/PASSIVE_OBSERVER_PID_REUSED/);
  assert.match(source,/DESKTOP_SWITCH_TRIPWIRE_LATCHED/);
});

test('real-Desktop2 direct UIA ValuePattern mutation is quarantined, read-only metadata and scroll are separate',()=>{
  for(const required of [
    'ValuePattern.Pattern','ScrollPattern.Pattern',
    'pattern.SetScrollPercent(ScrollPattern.NoScroll, percent)',
    'pattern.Current.VerticalScrollPercent',
    'DIRECT_UIA_VALUEPATTERN_QUARANTINED_AFTER_FOREGROUND_THEFT',
    'INVOKE_DISABLED_UNTIL_DESKTOP2_POPUP_ACTIVATION_ACCEPTANCE'
  ]) assert.ok(source.includes(required),required);
  assert.doesNotMatch(source,/\bValuePattern\s+pattern[\s\S]*?\.SetValue\s*\(/);
  assert.doesNotMatch(source,/\bpattern\.SetValue\s*\(/);
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

test('mutating Desktop2 UIA is guarded by verified WS_EX_NOACTIVATE before UIA tree access',()=>{
  assert.match(source,/GetWindowLongPtrW\(hwnd, GwlExstyle\)/);
  assert.match(source,/HasNoActivateStyle\(extendedStyle\)/);
  assert.match(source,/DESKTOP2_TARGET_NOT_PROTECTED_WS_EX_NOACTIVATE/);
  assert.match(source,/ctx\.VerifyNonActivatingTarget\(hwnd\)/);
  assert.match(source,/element\.Current\.ProcessId != request\.ProcessId/);
  const perform=source.slice(source.indexOf('private static object Perform('));
  const provider=perform.indexOf('FindExactElement(hwnd, request.AutomationId)');
  const preflight=perform.indexOf('Guard();');
  assert.ok(preflight>=0 && provider>preflight);
  // Do NOT change arbitrary third-party window styles.
  assert.doesNotMatch(source,/\bSetWindowLongPtrW?\s*\(/);
  assert.doesNotMatch(source,/\bSetWindowLongW?\s*\(/);
});

test('mutating UIA requires observer early-foreground watch for matching HWND/PID',()=>{
  assert.match(source,/EARLY_FOREGROUND_WATCH_NOT_ARMED/);
  assert.match(source,/EARLY_FOREGROUND_WATCH_TARGET_MISMATCH/);
  assert.match(source,/watched\.Hwnd != hwnd \|\| watched\.ProcessId != processId/);
  assert.match(source,/ObserverGuard\.AssertWatchedTarget\(request\.ObserverReady,/);
  assert.match(source,/request\.Hwnd, request\.ProcessId\)/);
});

test('two-phase arm performs native identity/style/observer verification before atomic manifest publication',()=>{
  assert.match(source,/--arm-target/);
  assert.match(source,/ARM_TARGET_REQUIRES_READONLY_IDENTITY_REQUEST/);
  const arm=source.match(/private static object ArmTarget\(Request request, Native.Context ctx\)([\s\S]*?)\n    private static object Perform/)?.[1];
  assert.ok(arm);
  const owner=arm.indexOf('ctx.VerifyTarget(hwnd, request.ProcessId, targetId)');
  const style=arm.indexOf('ctx.VerifyNonActivatingTarget(hwnd)');
  const slot=arm.indexOf('ObserverGuard.GetUnarmedTargetSlot(request.ObserverReady)');
  const publish=arm.indexOf('File.Move(temporary, slot, overwrite: false)');
  const verify=arm.indexOf('ObserverGuard.AssertWatchedTarget(request.ObserverReady');
  assert.ok(owner>=0 && style>owner && slot>style && publish>slot && verify>publish);
  assert.match(source,/EARLY_FOREGROUND_WATCH_SLOT_INVALID_OR_USED/);
  assert.match(arm,/if \(File.Exists\(temporary\)\) File.Delete\(temporary\)/);
  assert.doesNotMatch(arm,/SetForegroundWindow|SetWindowLong|SendInput|MoveWindowToDesktop/);
});

test('readonly UIA inspect and bounded tree are guarded before any provider call',()=>{
  const perform=source.slice(source.indexOf('private static object Perform('));
  const firstGuard=perform.indexOf('Guard();');
  const inspectTree=perform.indexOf('InspectTree(hwnd, request.ProcessId, Guard)');
  const findExact=perform.indexOf('FindExactElement(hwnd, request.AutomationId)');
  assert.ok(firstGuard>=0 && inspectTree>firstGuard && findExact>inspectTree);
  assert.match(perform,/ctx\.VerifyNonActivatingTarget\(hwnd\)/);
  assert.match(perform,/ObserverGuard\.AssertWatchedTarget\(request\.ObserverReady,/);
  assert.doesNotMatch(perform,/if \(request.Action != "inspect"\)/);
  assert.match(source,/TREE_SNAPSHOT_SENTINEL_REQUIRED/);
  const tree=readFileSync(path.join(dir,'DirectUia.SemanticSnapshot.cs'),'utf8');
  assert.match(tree,/MaxVisitedControls = 128/);
  assert.match(tree,/MaxReturnedControls = 32/);
  assert.match(tree,/UIA_SNAPSHOT_DUPLICATE_AUTOMATION_ID/);
  assert.match(tree,/UIA_SNAPSHOT_NODE_BUDGET_EXCEEDED/);
  assert.match(tree,/UIA_SNAPSHOT_DEPTH_BUDGET_EXCEEDED/);
  assert.match(tree,/TreeWalker\.ControlViewWalker/);
  assert.doesNotMatch(tree,/\.Current\.Value\b/);
  assert.doesNotMatch(tree,/\b(SetForegroundWindow|SetFocus|SendInput|SetCursorPos|SwitchDesktop)\s*\(/);
});

test('real live Desktop2 focus-theft reproducer is hard-quarantined before any child/GUI execution',()=>{
 const harness=readFileSync(path.join(dir,'..','desktop2-real-acceptance','run-protected-once.mjs'),'utf8');
 const quarantine=harness.indexOf("throw new Error('DIRECT_UIA_GUI_QUARANTINED_AFTER_CONFIRMED_FOREGROUND_THEFT')");
 const guiLaunch=harness.indexOf('child=spawn(');
 assert.ok(quarantine>0 && guiLaunch>quarantine);
 const firstImport=harness.indexOf("import fs ");
 assert.ok(quarantine<firstImport);
 assert.match(source,/if \(action == "set-value"\)[\s\S]*?DIRECT_UIA_VALUEPATTERN_QUARANTINED_AFTER_FOREGROUND_THEFT/);
 const perform=source.slice(source.indexOf('private static object Perform('));
 assert.ok(perform.indexOf('if (request.Action == "set-value")') <
   perform.indexOf('AutomationElement element = FindExactElement('));
});
