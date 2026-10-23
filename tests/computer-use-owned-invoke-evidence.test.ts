import assert from 'node:assert/strict';
import test from 'node:test';
import {checkOwnedWinFormsInvokeEvidence} from '../src/computer-use-owned-invoke-evidence.js';

const base={
  mode:'invoke',pass:true,run_stamp:'mvlc141h',
  owner_before:1,owner_after:1,fixture_verified:true,
  fixture_hash_verified:true,observer_armed:true,provider_controls:96,
  matched_owned_button:1,invoke_dispatched:true,app_callback_attested:true,
  app_click_callbacks:1,unexpected_focus_events:0,observer_quiet:true,
  owned_job_terminated:true,watcher_terminated:true,
  lease_held_to_cleanup:true,production_action_authorized:false,errors:[]
};
const log=[
  '2026-10-23T18:57:41.202Z APP_SHOWN_FOREGROUND=0',
  '2026-10-23T18:57:42.293Z UNCLOAK_SUCCESS',
  '2026-10-23T18:57:44.829Z APP_BUTTON_CLICK=1'
].join('\n');

test('real callback log and protected lifecycle support only owned fixture success',()=>{
  const result=checkOwnedWinFormsInvokeEvidence(base,log,'mvlc141h');
  assert.equal(result.app_click_callback_count,1);
  assert.equal(result.log_run_binding,'explicit');
  assert.equal(result.generic_third_party_approved,false);
  assert.equal(result.raw_observer_trace_reverified,false);
});
test('summary contradiction, missing cleanup or unsafe focus is rejected',()=>{
  const alters=[
    {pass:false},{invoke_dispatched:false},{app_click_callbacks:0},
    {app_callback_attested:false},{observer_quiet:false},
    {owned_job_terminated:false},{watcher_terminated:false},
    {lease_held_to_cleanup:false},{owner_after:2},
    {production_action_authorized:true},{errors:['fault']},
    {matched_owned_button:2},{provider_controls:0},
    {fixture_hash_verified:false},{run_stamp:'another'}
  ];
  for(const altered of alters){
    assert.throws(()=>checkOwnedWinFormsInvokeEvidence({...base,...altered},log,'mvlc141h'),
      /OWNED_INVOKE_/);
  }
});
test('callback count, ordering, foreground and unexpected second events are corroborated',()=>{
  for(const broken of [
    log.replace('APP_BUTTON_CLICK=1','APP_BUTTON_CLICK=2'),
    log+'\nAPP_BUTTON_CLICK=2',
    log+'\nROOT_WM_7',
    log.replace('UNCLOAK_SUCCESS','UNCLOAK_FAILED'),
    log.split('\n').reverse().join('\n'),
    log.replace('APP_SHOWN_FOREGROUND=0','APP_SHOWN_FOREGROUND=123')
  ]) {
    assert.throws(()=>checkOwnedWinFormsInvokeEvidence(base,broken,'mvlc141h'),
      /OWNED_INVOKE_APP_LOG_DID_NOT_CORROBORATE/);
  }
});
test('old saved result without explicit run stamp is never called strongly bound',()=>{
  const {run_stamp: unused, ...legacy}=base;
  void unused;
  assert.equal(checkOwnedWinFormsInvokeEvidence(legacy,log,'mvlc141h').log_run_binding,
    'legacy_unbound');
});
