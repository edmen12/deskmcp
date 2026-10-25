import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/paths.js';
import { verifySelectionEvidence, type SelectionStage } from '../src/computer-use-selection-evidence-gate.js';

function fixture(stage: SelectionStage) {
  const external=stage==='list-select-probe';
  const prior = [
    'HOST_MEMORY_PREFLIGHT_PASS','OBSERVER_READY','OWNED_FIXTURE_CLOAKED',
    'TARGET_FOREGROUND_HOOK_ARMED','NATIVE_CHILD_CAPABILITY_PASS'
  ];
  const extra=external?['FIXTURE_NATIVE_SELECTION_READBACK_CONFIRMED']:
    stage==='list-select-stale'?['FIXTURE_NATIVE_SELECTION_STALE_REJECTED']:[];
  const log='2026-10-23 APP_SHOWN_FOREGROUND=10\n'
    +(external?'':'2026-10-23 APP_LIST_SELECTION_CHANGED=7\n')
    +'2026-10-23 APP_LIST_SELECTED_STATE=7\n';
  return {
    stage,
    result: {stage,pass:true,claimedForegroundSafety:true,desktopBefore:1,desktopAfter:1,
      tripwire:false,ownedGuiExitConfirmed:true,observerExitConfirmed:true,
      leaseHeldThroughTeardown:true,appFocusEvents:[],appListTopChanges:[],
      appCallbackCount:0,appButtonCallbackCount:0,
      observed:[{controlType:'NativeWin32.ListBox',canScrollNativeList:true,canSetNativeValue:false}],
      selectedStateWitnesses:['APP_LIST_SELECTED_STATE=7'],
      selectedChangedCallbacks:external?[]:['APP_LIST_SELECTION_CHANGED=7']
    },
    timeline:[...prior,...extra].map(event=>({event} as Record<string,unknown>)).concat([{
      event:'FINAL_RESULT',pass:true,desktopAfter:1,tripwire:false,
      ownedGuiExitConfirmed:true,observerExitConfirmed:true,leaseHeldThroughTeardown:true
    }]),
    observer:[{kind:'START',latchedAbort:false,notifications:0,heartbeatChanges:0},
      {kind:'READY_AFTER_MESSAGE_PUMP',latchedAbort:false,notifications:0,heartbeatChanges:0}],
    log
  };
}
function check(data:ReturnType<typeof fixture>) {
  return verifySelectionEvidence(data.stage,data.result,data.timeline,data.observer,data.log);
}
test('controlled comparison distinguishes index readback from managed selection event',()=>{
  assert.equal(check(fixture('list-select-probe')).managed_selection_events,0);
  assert.equal(check(fixture('list-managed-event-control')).managed_selection_events,1);
  assert.equal(check(fixture('list-select-stale')).managed_selection_events,1);
});
test('missing app callback or fabricated log changes cause evidence rejection',()=>{
  const d=fixture('list-managed-event-control');
  d.log=d.log.replace('APP_LIST_SELECTION_CHANGED=7','APP_LIST_SELECTION_CHANGED=6');
  assert.throws(()=>check(d),/CALLBACK_TRACE_MISMATCH|CALLBACK_EXPECTATION_MISMATCH/);
  const e=fixture('list-select-probe');
  e.log+='2026-10-23 APP_LIST_SELECTION_CHANGED=7\n';
  assert.throws(()=>check(e),/CALLBACK_TRACE_MISMATCH/);
});
test('lease release, desktop switch and observer alarm fail evidence',()=>{
  for(const key of ['leaseHeldThroughTeardown','ownedGuiExitConfirmed','observerExitConfirmed'] as const){
    const d=fixture('list-select-probe');d.result[key]=false;
    assert.throws(()=>check(d),/DESKTOP_OR_LIFECYCLE_NOT_PROVEN/);
  }
  const changed=fixture('list-select-probe');changed.result.desktopAfter=2;
  assert.throws(()=>check(changed),/DESKTOP_OR_LIFECYCLE_NOT_PROVEN/);
  const alarm=fixture('list-select-probe');
  alarm.observer[1]!.latchedAbort=true;
  assert.throws(()=>check(alarm),/OBSERVER_NOT_QUIET/);
});
test('missing stale denial and missing external readback independently reject',()=>{
  const stale=fixture('list-select-stale');
  stale.timeline=stale.timeline.filter(e=>e.event!=='FIXTURE_NATIVE_SELECTION_STALE_REJECTED');
  assert.throws(()=>check(stale),/STALE_REQUEST_NOT_REJECTED/);
  const external=fixture('list-select-probe');
  external.timeline=external.timeline.filter(e=>e.event!=='FIXTURE_NATIVE_SELECTION_READBACK_CONFIRMED');
  assert.throws(()=>check(external),/EXTERNAL_SELECTION_READBACK_NOT_ATTESTED/);
});
test('unarmed foreground hook or invalid native child identity invalidates run',()=>{
  const a=fixture('list-select-probe');
  a.timeline=a.timeline.filter(e=>e.event!=='TARGET_FOREGROUND_HOOK_ARMED');
  assert.throws(()=>check(a),/GUARD_ORDER_INCOMPLETE/);
  const b=fixture('list-select-probe');b.result.observed[0]!.controlType='Other';
  assert.throws(()=>check(b),/TARGET_IDENTITY_UNVERIFIED/);
});
test('candidate selection helper cannot dispatch other native or UIA actions',()=>{
  const file=path.join(PROJECT_ROOT,'test-area','desktop2-list-selection','native','Program.cs');
  const source=readFileSync(file,'utf8');
  assert.match(source,/Permitted\(string\? action\) => action == "fixture-select-native-list"/);
  assert.match(source,/ObserverGuard\.AssertWatchedTarget/);
  assert.match(source,/ctx\.VerifyNonActivatingTarget/);
  const list=readFileSync(path.join(PROJECT_ROOT,'test-area','desktop2-list-selection','native','DirectUia.NativeList.cs'),'utf8');
  assert.match(list,/FIXTURE_ONLY_SELECTION_PRIOR_STATE_MISMATCH/);
  assert.match(list,/if\(count!=80 \|\| Message\(child,LbGetCurSel\)!=expectedPrevious\)/);
  assert.match(list,/Deliberately no synthetic WM_COMMAND\/LBN_SELCHANGE/);
  assert.match(list,/foregroundSafetyUnproven=true/);
});
