import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {PROJECT_ROOT} from '../src/paths.js';
import {classifyOwnedLaunchFailure,describeLeaseLoss} from '../src/computer-use-owned-launch-diagnostics.js';

test('classify bounded process host evidence without dumping private command lines',()=>{
  assert.deepEqual(classifyOwnedLaunchFailure('Initial output:\nProcess completed with exit code 1'),
    {kind:'process_exited_before_ready',process_host_exit_code:1,safe_to_retry_automatically:false});
  assert.equal(classifyOwnedLaunchFailure('The term C:\\x\\app.exe is not recognized\nProcess completed with exit code 1').kind,
    'shell_invocation_failure');
  assert.equal(classifyOwnedLaunchFailure('You must install .NET to run this application').kind,
    'dotnet_runtime_failure');
  assert.equal(classifyOwnedLaunchFailure('DeskMCP process host failed: Could not start the owned DeskMCP process').kind,
    'process_host_failure');
  assert.equal(classifyOwnedLaunchFailure('FIXTURE_ERROR').kind,'fixture_initialization_failure');
  assert.equal(classifyOwnedLaunchFailure('unknown message').kind,'no_exit_observed');
});
test('generator distinguishes changed control generation from verified root cause',()=>{
  assert.deepEqual(describeLeaseLoss(10,11),{
    status:'lease_no_longer_valid',generation_before:10,generation_after:11,
    generation_changed:true,reset_cause_verified:false,retry_automatically:false
  });
  assert.equal(describeLeaseLoss(10,10).generation_changed,false);
  assert.equal(describeLeaseLoss(10,null).generation_changed,null);
  assert.throws(()=>describeLeaseLoss(-1,10),/INVALID_BASE_GENERATION/);
});
test('owned test reports diagnostics only after early exit and never bypasses watcher',()=>{
  const script=readFileSync(path.join(PROJECT_ROOT,'test-area',
    'isolated-thirdparty-prelaunch','probe-owned-winforms-ui.mjs'),'utf8');
  assert.match(script,/describeLeaseLoss\(initialGeneration,after\)/);
  assert.match(script,/classifyOwnedLaunchFailure\(report\.text\)/);
  assert.match(script,/OWNED_PROCESS_HOST_EARLY_EXIT/);
  assert.match(script,/watch=await watcher\.start\(lease\)/);
  assert.match(script,/await watcher\.assertHealthy\(lease\)/);
  assert.match(script,/invokeGate\.claimOnce/);
  assert.match(script,/OWNED_WINFORMS_OBJECT_UIA_READ_ONCE/);
  assert.match(script,/OWNED_WINFORMS_OBJECT_UIA_INVOKE_ONCE/);
  for(const bad of ['SetForegroundWindow(', 'SendInput(', 'SwitchDesktop('])
    assert.ok(!script.includes(bad),bad);
});

test('real WinForms button class casing matches Windows and rejects fabricated uppercase provider class',()=>{
  const runner=readFileSync(path.join(PROJECT_ROOT,'test-area',
    'isolated-thirdparty-prelaunch','probe-owned-winforms-ui.mjs'),'utf8');
  assert.match(runner,/app\.buttonClass\?\.startsWith\('WindowsForms10\.Button\.'\)/);
  assert.doesNotMatch(runner,/WindowsForms10\.BUTTON\./);
});
