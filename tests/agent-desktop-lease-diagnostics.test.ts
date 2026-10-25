import assert from 'node:assert/strict';
import test from 'node:test';
import {classifyAgentDesktopLeaseFailure,assessObservedLeaseLoss}
  from '../src/agent-desktop-lease-diagnostics.js';

test('revoked lease is not confused with heartbeat stale, desktop switch, or binding loss',()=>{
  assert.equal(classifyAgentDesktopLeaseFailure('Agent Desktop control was revoked or replaced.'),
    'lease_revoked_or_replaced');
  assert.equal(classifyAgentDesktopLeaseFailure(
    'Agent Desktop safety HUD heartbeat is missing or stale. Control is fail-closed.'),
    'hud_heartbeat_missing_or_stale');
  assert.equal(classifyAgentDesktopLeaseFailure(
    'Agent Desktop binding is missing for the active lease.'),'binding_missing');
  assert.equal(classifyAgentDesktopLeaseFailure('STABILITY_OWNER_DESKTOP_CHANGED'),
    'owner_desktop_mismatch');
  assert.equal(classifyAgentDesktopLeaseFailure('unexpected provider data'),
    'backend_or_unclassified_failure');
});
test('raw control document observations do not identify an actor without a committed reason',()=>{
  assert.deepEqual(assessObservedLeaseLoss({
    initialGeneration:558,finalGeneration:559,stillActive:false,
    currentDesktopNumber:1
  }),{
    generation_delta:1,control_still_active:false,observed_owner_desktop:1,
    last_committed_reason:'legacy_or_unavailable',
    revoking_actor_verified:false,safely_reusable_without_new_lease:false
  });
  const known=assessObservedLeaseLoss({
    initialGeneration:6,finalGeneration:7,stillActive:false,
    currentDesktopNumber:1,mutationReason:'explicit_stop'
  });
  assert.equal(known.last_committed_reason,'explicit_stop');
  assert.equal(known.revoking_actor_verified,false);
});
test('missing fields are returned as unknown not guessed from stale prior observation',()=>{
  const x=assessObservedLeaseLoss({
    initialGeneration:null,finalGeneration:55,stillActive:null,
    currentDesktopNumber:null
  });
  assert.equal(x.generation_delta,null);
  assert.equal(x.control_still_active,null);
  assert.equal(x.observed_owner_desktop,null);
  assert.equal(x.safely_reusable_without_new_lease,false);
});
