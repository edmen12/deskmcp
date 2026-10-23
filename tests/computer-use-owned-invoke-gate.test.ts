import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/paths.js';
import {OwnedWinFormsInvokeTrial, OWNED_WINFORMS_FIXTURE_DLL_SHA256,
  type OwnedWinFormsInvokeProof} from '../src/computer-use-owned-invoke-gate.js';

const base:OwnedWinFormsInvokeProof={
  ownerDesktopNumber:1,leaseActive:true,independentObserverReady:true,
  rootHwnd:123,childRootHwnd:123,processId:456,childProcessId:456,
  rootClass:'WindowsForms10.Window.8.app.0.2004eee',appAssemblySha256:OWNED_WINFORMS_FIXTURE_DLL_SHA256,
  rootNoActivate:true,appInitialized:true,
  currentSelectionGeneration:1,expectedSelectionGeneration:1
};
const tree={
  hwnd:123,elementsTruncated:false,elements:[
    {type:'Button',name:'Test action',automationId:'OwnedNativePushButton',
      selector:'button-exact',isInvokable:true,isEnabled:true}
  ]
};
const admitted=()=>new OwnedWinFormsInvokeTrial();

test('owned fixture exact button can be selected but does not authorize production',()=>{
  const gate=admitted();
  assert.equal(gate.authorizedForProduction,false);
  assert.equal(gate.admit(base,tree),'button-exact');
});
test('stale identity and lease changes fail closed before any UIA Invoke',()=>{
  for(const [field,value] of [
    ['leaseActive',false],['independentObserverReady',false],
    ['rootNoActivate',false],['appInitialized',false],
    ['ownerDesktopNumber',2],['childRootHwnd',999],
    ['childProcessId',999],['rootClass','Chrome_WidgetWin_1'],
    ['appAssemblySha256','mismatch'],['currentSelectionGeneration',2]
  ] as const) {
    assert.throws(()=>admitted().claimOnce({...base,[field]:value},tree),
      /OWNED_INVOKE_(DESKTOP_OR_MONITOR_NOT_READY|APPLICATION_IDENTITY_CHANGED)/,field);
  }
});
test('UIA missing, truncated, duplicated or uninvokable button is refused',()=>{
  const changes=[
    {...tree,elementsTruncated:true},
    {...tree,hwnd:555},
    {...tree,elements:[]},
    {...tree,elements:[...tree.elements,...tree.elements]},
    {...tree,elements:[{...tree.elements[0],isInvokable:false}]},
    {...tree,elements:[{...tree.elements[0],isEnabled:false}]},
    {...tree,elements:[{...tree.elements[0],type:'Text'}]},
    {...tree,elements:[{...tree.elements[0],selector:''}]}
  ];
  for(const altered of changes)
    assert.throws(()=>admitted().claimOnce(base,altered),/OWNED_INVOKE_/);
});
test('transport is one-shot even after unknown response; no automatic retries',()=>{
  const trial=admitted();
  assert.equal(trial.claimOnce(base,tree),'button-exact');
  assert.throws(()=>trial.claimOnce(base,tree),/OWNED_INVOKE_ALREADY_USED/);
});
test('app callback must be exactly once and does not prove generic actions',()=>{
  const trial=admitted();trial.claimOnce(base,tree);
  const expected=['2026-10-24 APP_BUTTON_CLICK=1'];
  const verdict=trial.attestAppEffect(expected,1,true,true,true,true);
  assert.equal(verdict.callback_count,1);
  assert.equal(verdict.production_action_authorized,false);
});
test('missing, double callbacks and any focus or observer warning deny acceptance',()=>{
  const conditions=[
    [[],1,true,true,true,true],
    [['APP_BUTTON_CLICK=1','APP_BUTTON_CLICK=2'],1,true,true,true,true],
    [['APP_BUTTON_CLICK=1','ROOT_WM_7'],1,true,true,true,true],
    [['APP_BUTTON_CLICK=1'],2,true,true,true,true],
    [['APP_BUTTON_CLICK=1'],1,false,true,true,true],
    [['APP_BUTTON_CLICK=1'],1,true,false,true,true],
    [['APP_BUTTON_CLICK=1'],1,true,true,false,true],
    [['APP_BUTTON_CLICK=1'],1,true,true,true,false]
  ] as const;
  for(const args of conditions) {
    const trial=admitted();trial.claimOnce(base,tree);
    assert.throws(()=>trial.attestAppEffect(args[0],args[1],args[2],args[3],args[4],args[5]),/OWNED_INVOKE_APP_EFFECT_OR_SAFETY_UNVERIFIED/);
  }
});
test('no action means no successful callback proof even if log claims success',()=>{
  assert.throws(()=>admitted().attestAppEffect(['APP_BUTTON_CLICK=1'],1,true,true,true,true),
    /OWNED_INVOKE_NEVER_DISPATCHED/);
});

test('isolated Invoke fixture runner is not a production MCP action and has distinct invoke opt-in',()=>{
  const runner=readFileSync(path.join(PROJECT_ROOT,'test-area',
    'isolated-thirdparty-prelaunch','probe-owned-winforms-ui.mjs'),'utf8');
  assert.match(runner,/OWNED_WINFORMS_OBJECT_UIA_READ_ONCE/);
  assert.match(runner,/OWNED_WINFORMS_OBJECT_UIA_INVOKE_ONCE/);
  assert.match(runner,/if\(mode==='invoke'\)/);
  assert.match(runner,/if\(digest!==OWNED_WINFORMS_FIXTURE_DLL_SHA256/);
  assert.match(runner,/executableDigest!==/);
  assert.match(runner,/watch=await watcher\.start\(lease\)/);
  assert.ok(runner.indexOf('watch=await watcher.start(lease)')<
    runner.indexOf('await backend.start(command'));
  assert.match(runner,/invokeGate\.claimOnce/);
  assert.match(runner,/invokeGate\.attestAppEffect/);
  for(const forbidden of ['SetForegroundWindow(', 'SwitchDesktop(', 'SendInput(',
    'WM_COMMAND','LBN_SELCHANGE','runtime.backend.act(']) {
    assert.ok(!runner.includes(forbidden),forbidden);
  }
});
test('experimental Invoke gate is not a registered public Computer Use tool',()=>{
  const tools=readFileSync(path.join(PROJECT_ROOT,'src','computer-use-tools.ts'),'utf8');
  assert.equal(tools.includes('computer-use-owned-invoke-gate'),false);
  assert.equal(tools.includes('desktop_ui_object_invoke'),false);
});
