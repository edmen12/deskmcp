import test from 'node:test';
import assert from 'node:assert/strict';
import type {ComputerWindow} from '../src/computer-use-backend.js';
import type {Desktop2ComputerUseSession} from '../src/desktop2-computer-use-session.js';
import {RealDesktop2OwnedControl} from '../src/desktop2-real-owned-control.js';

const lease='4d7c87d2-bcba-4a3e-b031-92d2e8a4a111';
const otherLease='0b583c9c-56c6-4e4a-9a9b-a54db5482222';
const wid='cde27cf9-2ebd-4e0b-bef8-1f14dfa56012';
const token='3db528d2-cd77-4e10-af0d-832975a24012';
const window:ComputerWindow={hwnd:6010,processId:8871,processName:'owned-fixture.exe',
 title:'Own disposable test app',className:'WindowsForms10.Window',width:800,height:600,isForeground:false};
function fixture() {
 const state={starts:0,stops:0,arm:0,perform:0,nativeSnapshot:0,allowed:true,
  failStart:false,swapped:false,badKind:false, result:{textReadbackConfirmed:true} as Record<string,unknown>};
 const session={
  async start(){state.starts++;if(state.failStart)throw Error('observer unavailable');},
  async stop(){state.stops++;},
  async discoverWindows(){return [{
   windowId:wid,computerObservationId:token,
   window:state.swapped?{...window,processId:8872}:window
  }];},
  async snapshotNativeWindow(){state.nativeSnapshot++;return {
   computerObservationId:token,controls:[{automationId:'native-edit:9900',
    controlType:state.badKind?'Edit':'NativeWin32.Edit',className:'WindowsForms10.Edit',
    canSetValue:false,canScrollTopBottom:false,canSetNativeValue:true}]
  };},
  async snapshotNativeButtons(){return {computerObservationId:token,controls:[{
   automationId:'native-button:9901',controlType:'NativeWin32.Button',
   className:'WindowsForms10.Button',canSetValue:false,canScrollTopBottom:false,
   canSetNativeValue:false,canClickNative:true}]
  };},
  async snapshotNativeLists(){return {computerObservationId:token,controls:[{
   automationId:'native-list:9902',controlType:'NativeWin32.ListBox',
   className:'WindowsForms10.ListBox',canSetValue:false,canScrollTopBottom:false,
   canSetNativeValue:false,canClickNative:false,canScrollNativeList:true}]
  };},
  async dispatch(req:{phase:string}) {
   if(req.phase==='arm'){state.arm++;return {armed:true};}
   state.perform++;return state.result;
  }
 } as unknown as Desktop2ComputerUseSession;
 const bridge=new RealDesktop2OwnedControl(()=>session,async w=>state.allowed &&
  w.processId===window.processId && w.hwnd===window.hwnd);
 return {bridge,state};
}
const editAction={type:'set_native_edit',automationId:'native-edit:9900',
 value:'ALLOWED',expectedPreviousValue:''} as const;

test('no lease means no real D2 target, and no trusted launcher means no windows',async()=>{
 const {bridge,state}=fixture();
 await assert.rejects(bridge.list(lease),/SESSION_NOT_ACTIVE/);
 await bridge.start(lease);
 await assert.rejects(bridge.start(lease),/FRESH_LEASE/);
 state.allowed=false;
 assert.deepEqual(await bridge.list(lease),[]);
 await assert.rejects(bridge.snapshot(lease,wid,'edit'),/NOT_ATTESTED/);
 await bridge.stop(lease);
 assert.equal(state.stops,1);
});
test('owned Win+Tab D2 capability requires monitor start, fresh discovery, one-shot snapshot',async()=>{
 const {bridge,state}=fixture();
 await bridge.start(lease);
 const seen=await bridge.list(lease);
 assert.equal(seen.length,1);
 assert.deepEqual(Object.keys(seen[0]!).sort(),['app','class_name','window_id']);
 assert.doesNotMatch(JSON.stringify(seen),/6010|8871|Own disposable test app/);
 const snap=await bridge.snapshot(lease,wid,'edit');
 assert.equal(snap.one_shot_native_permit,true);
 assert.equal(snap.computer_observation_id,token);
 assert.equal(state.arm,1);
 const result=await bridge.perform(lease,wid,token,editAction);
 assert.deepEqual(result,{dispatched:true,app_event_verified:false,business_outcome_verified:false});
 assert.equal(state.perform,1);
 await assert.rejects(bridge.perform(lease,wid,token,editAction),/ONESHOT/);
 assert.equal(state.perform,1);
 await bridge.stop(lease);
 assert.equal(state.starts,1);assert.equal(state.stops,1);
});
test('wrong lease, replaced window identity and revoked app ownership all fail closed',async()=>{
 const {bridge,state}=fixture();
 await bridge.start(lease);
 await assert.rejects(bridge.list(otherLease),/LEASE_CHANGED/);
 await bridge.list(lease);
 state.swapped=true;
 await assert.rejects(bridge.snapshot(lease,wid,'edit'),/WINDOW_IDENTITY_CHANGED/);
 state.swapped=false;
 state.allowed=true;
 await bridge.snapshot(lease,wid,'edit');
 state.allowed=false;
 await assert.rejects(bridge.perform(lease,wid,token,editAction),/OWNERSHIP_REVOKED/);
 assert.equal(state.perform,0);
 await bridge.stop(lease);
});
test('native Edit permit cannot invoke UIA ValuePattern or a different control class',async()=>{
 const {bridge,state}=fixture();
 await bridge.start(lease);await bridge.list(lease);await bridge.snapshot(lease,wid,'edit');
 await assert.rejects(bridge.perform(lease,wid,token,
  {type:'set_value',automationId:'native-edit:9900',value:'bad'}),/UNSAFE_NATIVE_ACTION_KIND/);
 assert.equal(state.perform,0);
 await assert.rejects(bridge.perform(lease,wid,token,editAction),/ONESHOT/);
 state.badKind=true;
 await assert.rejects(bridge.snapshot(lease,wid,'edit'),/PROVENANCE_REJECTED/);
 await bridge.stop(lease);
});
test('native button/list actions are distinct, and a provider acknowledgment never proves app event',async()=>{
 const {bridge,state}=fixture();
 await bridge.start(lease);await bridge.list(lease);
 await bridge.snapshot(lease,wid,'button');
 state.result={messageDispatched:true};
 const button=await bridge.perform(lease,wid,token,{type:'click_native_button',automationId:'native-button:9901'});
 assert.equal(button.dispatched,true);
 assert.equal(button.app_event_verified,false);
 await bridge.snapshot(lease,wid,'list');
 state.result={topIndexReadbackConfirmed:true};
 const list=await bridge.perform(lease,wid,token,{type:'scroll_native_list',automationId:'native-list:9902',topIndex:20,expectedPreviousTopIndex:0});
 assert.equal(list.business_outcome_verified,false);
 assert.equal(state.perform,2);
 await bridge.stop(lease);
});
test('a missing watcher fails start; a failed message cannot be replayed and the caller retains lease ownership',async()=>{
 const {bridge,state}=fixture();state.failStart=true;
 await assert.rejects(bridge.start(lease),/observer unavailable/);
 assert.equal(state.stops,1);
 state.failStart=false;
 await bridge.start(lease);await bridge.list(lease);await bridge.snapshot(lease,wid,'edit');
 state.result={textReadbackConfirmed:false};
 await assert.rejects(bridge.perform(lease,wid,token,editAction),/DISPATCH_UNCONFIRMED/);
 await assert.rejects(bridge.perform(lease,wid,token,editAction),/ONESHOT/);
 await bridge.stop(lease);
 assert.equal(state.perform,1);
});
