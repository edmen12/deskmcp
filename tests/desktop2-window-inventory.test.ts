import assert from 'node:assert/strict';
import test from 'node:test';
import { Desktop2WindowInventory } from '../src/desktop2-window-inventory.js';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';
import type { AgentDesktopNativeBridge, AgentDesktopPassiveInventory } from '../src/agent-desktop-native.js';

const lease = 'a2519d05-1219-4c25-9a10-d1b35cef2812';
const desktopId = 'd81244e4-e0c5-456f-a707-2b685a00662c';
const fixtureWindow = {
  hwnd: 504840, processId: 2121, processName: 'TestApp',
  title: 'Safe WPF', className: 'HwndWrapper[WPF]',
  width: 520,height:360,isForeground:false as const,
  desktopId,desktopNumber:2 as const,onCurrentDesktop:false as const
};

function fixture() {
  const state={current:1,generation:44,active:true,processName:fixtureWindow.processName,
    windows:[fixtureWindow] as unknown[],retargetAfter:false,revokeAfter:false};
  let calls=0;
  const leases:Pick<AgentDesktopManager,'assertLease'>={
    async assertLease(){
      calls++;
      return {binding:{schemaVersion:1 as const,desktopId,boundAtUtc:new Date().toISOString()},
        control:{schemaVersion:1 as const,generation:state.generation,active:state.active,
          leaseId:lease,desktopId,desktopNumber:2,startedAtUtc:new Date().toISOString()}};
    }
  };
  const native:Pick<AgentDesktopNativeBridge,'info'|'listVirtualWindows'>={
    async info(){return {officialApi:true,virtualDesktopAccessor:true,currentDesktopNumber:state.current,desktopCount:2};},
    async listVirtualWindows(){
      if(state.retargetAfter) state.current=2;
      if(state.revokeAfter) state.generation++;
      return {desktopId,desktopNumber:2,currentDesktopNumber:1,windows:state.windows} as AgentDesktopPassiveInventory;
    }
  };
  const inventory=new Desktop2WindowInventory(leases,native,lease);
  return {state,inventory,get calls(){return calls;}};
}

test('passive inventory returns only exact nonshared Desktop2 HWND/PID/process/window class',async()=>{
 const t=fixture();
 const windows=await t.inventory.list();
 assert.deepEqual(windows,[{
  hwnd:fixtureWindow.hwnd,processId:fixtureWindow.processId,processName:fixtureWindow.processName,
  title:fixtureWindow.title,className:fixtureWindow.className,
  width:fixtureWindow.width,height:fixtureWindow.height,isForeground:false
 }]);
 assert.ok(t.calls>=2);
});

test('valid legacy binding without desktopNumber is accepted when control and native identity agree',async()=>{
 const t=fixture();assert.equal((await t.inventory.list()).length,1);
});

test('pinned windows, Desktop1 windows, wrong desktop identity, duplicate and forged PID fail the WHOLE inventory',async()=>{
 const bad=[
  {...fixtureWindow,onCurrentDesktop:true},
  {...fixtureWindow,desktopNumber:1},
  {...fixtureWindow,desktopId:'1d54438c-30ab-4b35-9a15-eeeeeeeeeeee'},
  {...fixtureWindow,processId:0},
  {...fixtureWindow,hwnd:0},
  {...fixtureWindow,isForeground:true},
  {...fixtureWindow,className:''},
  {...fixtureWindow,width:0},
  {...fixtureWindow,height:0}
 ];
 for(const item of bad){
  const t=fixture();t.state.windows=[item];
  await assert.rejects(t.inventory.list(),/invalid, pinned or untrusted/);
 }
 const t=fixture();t.state.windows=[fixtureWindow,fixtureWindow];
 await assert.rejects(t.inventory.list(),/invalid, pinned or untrusted/);
});

test('owner Desktop2 at start or owner switch during enumeration fails closed',async()=>{
 const a=fixture();a.state.current=2;
 await assert.rejects(a.inventory.list(),/owner still on Desktop1/);
 const b=fixture();b.state.retargetAfter=true;
 await assert.rejects(b.inventory.list(),/invalidated by owner switch/);
});

test('lease revocation and generation change during enumeration abort publication',async()=>{
 const a=fixture();a.state.active=false;
 await assert.rejects(a.inventory.list(),/active matching/);
 const b=fixture();b.state.revokeAfter=true;
 await assert.rejects(b.inventory.list(),/invalidated by owner switch or lease replacement/);
});

test('empty Desktop2 inventory returns empty instead of using Desktop1 as fallback',async()=>{
 const t=fixture();t.state.windows=[];
 assert.deepEqual(await t.inventory.list(),[]);
});
