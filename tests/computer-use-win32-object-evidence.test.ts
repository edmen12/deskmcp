import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {PROJECT_ROOT} from '../src/paths.js';
import {assessIsolatedWinverReadEvidence} from '../src/computer-use-win32-object-evidence.js';

const accepted = {
  stage:'WIN32_ISOLATED_DESKTOP_OBJECT_PRELAUNCH_WINVER',
  pass:true,owner_desktop_before:1,owner_desktop_after:1,
  hud_lease_verified:true,strict_observer_ready:true,
  preassigned_desktop_object:true,owned_system_winver_window_found:true,
  system_app_window_count:1,isolated_ui_inspection_status:'elements_visible',
  isolated_ui_elements:12,app_business_effect_verified:false,
  windows_virtual_desktop2_visibility_verified:false,
  observer_quiet:true,owned_job_terminated:true,watcher_terminated:true,
  lease_held_through_teardown:true,production_action_authorized:false,errors:[]
};
test('real isolated Win32 third-party launch/UIA proof does not claim Windows virtual D2 or action success',()=>{
  const result=assessIsolatedWinverReadEvidence(accepted);
  assert.equal(result.verified_isolated_win32_object_launch,true);
  assert.equal(result.verified_read_only_winapp_uia,true);
  assert.equal(result.observed_ui_element_count,12);
  assert.equal(result.windows_virtual_desktop2_visibility_proven,false);
  assert.equal(result.generic_mcp_computer_use_action_proven,false);
  assert.equal(result.production_release_approved,false);
});
test('monitor, startup isolation, lease, cleanup or output mismatch invalidate evidence',()=>{
  const mutations=[
    ['owner_desktop_before',2],['owner_desktop_after',2],
    ['hud_lease_verified',false],['strict_observer_ready',false],
    ['preassigned_desktop_object',false],['owned_system_winver_window_found',false],
    ['system_app_window_count',0],['isolated_ui_inspection_status','provider_empty'],
    ['isolated_ui_elements',0],['observer_quiet',false],['owned_job_terminated',false],
    ['watcher_terminated',false],['lease_held_through_teardown',false],
    ['production_action_authorized',true],['errors',['FOCUS_CHANGE']]
  ] as const;
  for(const [key,value] of mutations)
    assert.throws(()=>assessIsolatedWinverReadEvidence({...accepted,[key]:value}),
      /ISOLATED_WIN32_UIA_EVIDENCE_NOT_ACCEPTED/,key);
});
test('isolated Win32 object source assigns process desktop before suspended process resumes',()=>{
  const file=readFileSync(path.join(PROJECT_ROOT,'process-host','Program.cs'),'utf8');
  const desktop=file.indexOf('startup.lpDesktop = "winsta0\\\\" + desktopObject');
  const launch=file.indexOf('if (!CreateProcessW(');
  const job=file.indexOf('if (!AssignProcessToJobObject(');
  const resume=file.indexOf('if (ResumeThread(');
  assert.ok(desktop>0 && launch>desktop && job>launch && resume>job,
    'lpDesktop assignment, CreateProcessW, Job object, then ResumeThread in that order');
  assert.match(file,/CREATE_SUSPENDED/);
  assert.match(file,/JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
});
test('fixture runner arms strict independent observer before launching Windows Winver',()=>{
  const source=readFileSync(path.join(PROJECT_ROOT,'test-area',
    'isolated-thirdparty-prelaunch','probe-owned-winver.mjs'),'utf8');
  assert.ok(source.indexOf('watching=await observer.start(lease)')>
    source.indexOf('const watcher'));
  assert.ok(source.indexOf('await backend.start(')>
    source.indexOf('watching=await observer.start(lease)'));
  assert.ok(source.indexOf('await backend.terminate(hostPid)')>
    source.indexOf('await backend.start('));
  assert.match(source,/result\.windows_virtual_desktop2_visibility_verified=virtualD2\.windows\.some/);
  assert.match(source,/const inspection=await uiBackend\.inspect\(winverHwnd,false,100,desktopObject\)/);
  for(const forbidden of ['SetForegroundWindow(', 'SwitchDesktop(', 'SendInput(', 'LB_SETCURSEL']) {
    assert.equal(source.includes(forbidden),false);
  }
});
test('real D2 Computer Use scope remains distinct from private Win32 object scope',()=>{
  const tools=readFileSync(path.join(PROJECT_ROOT,'src','computer-use-tools.ts'),'utf8');
  assert.match(tools,/A Windows virtual desktop is NOT an isolated Win32 Desktop object/);
  assert.match(tools,/filterWindowsForLease\(windows, agent_desktop_lease_id\)/);
  const native=readFileSync(path.join(PROJECT_ROOT,'src','computer-use-backend.ts'),'utf8');
  assert.match(native,/listWindows\(app\?: string, desktopObjectName\?: string\)/);
  assert.match(native,/inspect\(hwnd: number, interactiveOnly = true, maxElements = 80, desktopObjectName\?: string\)/);
});
