import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentDesktopManager} from '../src/agent-desktop-state.js';
import type {AgentDesktopNativeBridge,AgentDesktopPassiveInventory} from '../src/agent-desktop-native.js';
import {readRealVirtualDesktop2Windows} from '../src/desktop2-real-inventory-tools.js';
const lease='9f752c91-fdae-4829-b4ad-a707a1070424';
const desktopId='d81244e4-e0c5-456f-a707-2b685a00662c';
const sample={
 hwnd:4832,processId:9123,processName:'chrome.exe',
 title:'Confidential personal tab',className:'Chrome_WidgetWin_1',
 width:1100,height:720,
 desktopId,desktopNumber:2,onCurrentDesktop:false,isForeground:false
};
function mock(){
 const state={current:1,desktopId,active:true,generation:3,
  windows:[sample] as unknown[],called:0};
 const leases={
  async assertLease(id:string){
   assert.equal(id,lease);
   return {binding:{schemaVersion:1 as const,desktopId:state.desktopId,boundAtUtc:new Date().toISOString()},
    control:{schemaVersion:1 as const,generation:state.generation,active:state.active,
    desktopId:state.desktopId,desktopNumber:2,leaseId:lease,startedAtUtc:new Date().toISOString()}};
  }
 } as Pick<AgentDesktopManager,'assertLease'>;
 const native={
  async info(){return {officialApi:true,virtualDesktopAccessor:true,currentDesktopNumber:state.current,desktopCount:2};},
  async listVirtualWindows(id:string){
   assert.equal(id,state.desktopId);
   state.called++;
   return {desktopId:state.desktopId,desktopNumber:2,currentDesktopNumber:1,
    windows:state.windows} as AgentDesktopPassiveInventory;
  }
 } as Pick<AgentDesktopNativeBridge,'info'|'listVirtualWindows'>;
 return {state,leases,native};
}
test('real virtual D2 read-only inventory uses VDA and omits confidential title and native identity',async()=>{
 const x=mock();
 const value=await readRealVirtualDesktop2Windows(x.leases,x.native,lease);
 assert.equal(value.source,'windows-virtual-desktop-2-vda');
 assert.equal(value.is_private_win32_desktop_object,false);
 assert.equal(value.actionable,false);
 assert.equal(value.desktop_number,2);
 assert.equal(value.count,1);
 assert.equal(x.state.called,1);
 assert.deepEqual(value.windows,[{
  app:'chrome.exe',class_name:'Chrome_WidgetWin_1',width:1100,height:720,foreground:false
 }]);
 assert.doesNotMatch(JSON.stringify(value),/Confidential|4832|9123|window_id|hwnd/);
});
test('explicit title opt-in does not issue an input capability',async()=>{
 const x=mock();
 const v=await readRealVirtualDesktop2Windows(x.leases,x.native,lease,true);
 assert.equal(v.windows[0]?.title,'Confidential personal tab');
 assert.equal(v.actionable,false);
 assert.doesNotMatch(JSON.stringify(v),/window_id|computer_observation_id|hwnd/);
});
test('real Desktop2 tool rejects a private Win32 Desktop Object window or shared/foreground window',async()=>{
 for(const replacement of [
  {...sample,desktopNumber:1},
  {...sample,onCurrentDesktop:true},
  {...sample,isForeground:true}
 ]){
  const x=mock();x.state.windows=[replacement];
  await assert.rejects(readRealVirtualDesktop2Windows(x.leases,x.native,lease),/invalid, pinned or untrusted/);
 }
});
test('real Desktop2 tool fails closed without HUD lease or when owner left Desktop1',async()=>{
 const a=mock();a.state.active=false;
 await assert.rejects(readRealVirtualDesktop2Windows(a.leases,a.native,lease),/active matching/);
 const b=mock();b.state.current=2;
 await assert.rejects(readRealVirtualDesktop2Windows(b.leases,b.native,lease),/owner still on Desktop1/);
});
