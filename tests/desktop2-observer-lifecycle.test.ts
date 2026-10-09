import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Desktop2ObserverLifecycle } from '../src/desktop2-observer-lifecycle.js';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';
import type { AgentDesktopNativeBridge } from '../src/agent-desktop-native.js';

const leaseId='a2519d05-1219-4c25-9a10-d1b35cef2812';
const desktopId='d81244e4-e0c5-456f-a707-2b685a00662c';
const observerExe='C:\\fake\\DeskMCP.Desktop2SwitchObserver.exe';
const vdaDll='C:\\fake\\VirtualDesktopAccessor.dll';

function fixture(options:{ready?:boolean;startupTimeoutMs?:number;strict?:boolean;forgedReady?:boolean;forgedPump?:boolean}={}) {
  const state={desktop:1,generation:7,active:true,hudReady:true,killed:false,
    pid:7171,readyPidMismatch:false,guardPresent:true,
    produceReady:options.ready!==false};
  const launches: string[][]=[];
  const leases:Pick<AgentDesktopManager,'assertLease'>={
    async assertLease(id) {
      if(!state.hudReady) throw new Error('HUD stale');
      if(id!==leaseId) throw new Error('Wrong lease');
      return {binding:{schemaVersion:1 as const,desktopId,boundAtUtc:new Date().toISOString()},
        control:{schemaVersion:1 as const,active:state.active,generation:state.generation,
          leaseId,desktopId,desktopNumber:2,startedAtUtc:new Date().toISOString()}};
    }
  };
  const native:Pick<AgentDesktopNativeBridge,'info'>={
    async info(){return {officialApi:true,virtualDesktopAccessor:true,currentDesktopNumber:state.desktop,desktopCount:2};}
  };
  const child={pid:state.pid,exitCode:null as number|null,
    kill(){state.killed=true;child.exitCode=1;return true;}};
  const launch=(_exe:string,args:readonly string[])=>{
    launches.push([...args]);
    const [, ,events,ready,tripwire,watch]=args;
    assert.ok(events && ready && tripwire && watch);
    if(state.produceReady){
      writeFileSync(events,'');
      writeFileSync(ready,JSON.stringify({
        processId:state.readyPidMismatch?999:state.pid,
        expectedDesktopIndex:0,firstStartUtc:new Date().toISOString(),
        tripwireFile:tripwire,watchedTargetFile:watch,
        hasVirtualDesktopNotifications:true,hasForegroundHook:true,
        strictForegroundArmed:options.strict===true && options.forgedReady!==true,
        messagePumpRunning:options.forgedPump!==true
      }));
    }
    return child;
  };
  const supervisor=new Desktop2ObserverLifecycle(leases,native,observerExe,vdaDll,launch,
    options.startupTimeoutMs??15000,options.strict??false);
  return {state,supervisor,launches,child};
}
async function withSession(run:(t:ReturnType<typeof fixture>,s:Awaited<ReturnType<Desktop2ObserverLifecycle['start']>>)=>Promise<void>) {
  const t=fixture();
  const session=await t.supervisor.start(leaseId);
  try{await run(t,session);}
  finally{await t.supervisor.stop();await rm(session.directory,{recursive:true,force:true});}
}

test('starts only a private message-only observer for live Desktop2 lease and verifies exact ready PID',async()=>{
 await withSession(async(t,s)=>{
   assert.equal(t.launches.length,1);
   assert.deepEqual(t.launches[0],['--observe-target',vdaDll,s.eventLog,s.readyFile,s.tripwireFile,s.targetFile]);
   assert.ok(existsSync(s.readyFile));
   await t.supervisor.assertHealthy(leaseId);
   await assert.rejects(t.supervisor.start(leaseId),/already active/);
 });
});

test('owner Desktop2 or missing HUD cannot start observer subprocess',async()=>{
 for(const scenario of [(t:ReturnType<typeof fixture>)=>{t.state.desktop=2;},
  (t:ReturnType<typeof fixture>)=>{t.state.hudReady=false;},
  (t:ReturnType<typeof fixture>)=>{t.state.active=false;}]) {
   const t=fixture();scenario(t);
   await assert.rejects(t.supervisor.start(leaseId));
   assert.equal(t.launches.length,0);
 }
});

test('wrong ready PID fails closed and kills owned observer',async()=>{
 const t=fixture();t.state.readyPidMismatch=true;
 await assert.rejects(t.supervisor.start(leaseId),/ready identity/);
 assert.equal(t.state.killed,true);
});

test('sticky switch tripwire revokes native UIA authorization',async()=>{
 await withSession(async(t,s)=>{
  writeFileSync(s.tripwireFile,'{"firstReason":"TARGET_FOREGROUND_EARLY_ABORT"}');
  await assert.rejects(t.supervisor.assertHealthy(leaseId),/stopped, missing or latched/);
  assert.ok(existsSync(s.tripwireFile));
 });
});

test('lost HUD, lease generation and owner switch independently fail health check',async()=>{
 for(const apply of [
  (t:ReturnType<typeof fixture>)=>{t.state.hudReady=false;},
  (t:ReturnType<typeof fixture>)=>{t.state.generation=8;},
  (t:ReturnType<typeof fixture>)=>{t.state.desktop=2;}
 ]) {
  await withSession(async(t)=>{
   apply(t);
   await assert.rejects(t.supervisor.assertHealthy(leaseId));
  });
 }
});

test('stop terminates owned observer, removes authorization files but preserves event log',async()=>{
 const t=fixture();const s=await t.supervisor.start(leaseId);
 const result=await t.supervisor.stop();
 assert.equal(result.stopped,true);
 assert.equal(result.preservedLog,s.eventLog);
 assert.equal(t.state.killed,true);
 assert.equal(existsSync(s.readyFile),false);
 assert.ok(existsSync(s.eventLog));
 await rm(s.directory,{recursive:true,force:true});
 await assert.rejects(t.supervisor.assertHealthy(leaseId),/stopped, missing or latched/);
});

test('observer missing ready marker immediately refuses later input',async()=>{
 await withSession(async(t,s)=>{
  await rm(s.readyFile);
  await assert.rejects(t.supervisor.assertHealthy(leaseId),/stopped, missing or latched/);
 });
});

test('native passive window inventory and observer sources never call activation or global input APIs',async()=>{
 const source=await readFile(path.join(process.cwd(),'agent-desktop-host','Program.Inventory.cs'),'utf8');
 for(const api of ['SetForegroundWindow(','ShowWindow(','GoToDesktopNumber(','SwitchDesktop(','SendInput(','SetCursorPos(']){
   assert.ok(!source.includes(api),api);
 }
 assert.match(source,/EnumWindows\(\(hwnd/);
 assert.match(source,/manager\.IsWindowOnCurrentVirtualDesktop\(hwnd\)/);
 assert.match(source,/vda\.CurrentDesktopNumber\(\) != 0/);
});

test('slow observer readiness is a distinct fail-closed timeout, not a forged PID; child is killed',async()=>{
 const t=fixture({ready:false,startupTimeoutMs:150});
 await assert.rejects(t.supervisor.start(leaseId),/PASSIVE_OBSERVER_READY_TIMEOUT_NO_GUI_STARTED/);
 assert.equal(t.launches.length,1);
 assert.equal(t.state.killed,true);
 await assert.rejects(t.supervisor.assertHealthy(leaseId),/stopped, missing or latched/);
});

test('observer startup budget rejects unbounded or unsupported timeout values',()=>{
 for(const timeout of [0,99,20001,Number.NaN,1.5]){
   assert.throws(()=>fixture({startupTimeoutMs:timeout}),/startup timeout/);
 }
});

test('strict watcher requires explicit mode and verifies ready flag',async()=>{
 const t=fixture({strict:true});
 const s=await t.supervisor.start(leaseId);
 try{
   assert.deepEqual(t.launches[0],['--observe-strict-launch',
     vdaDll,s.eventLog,s.readyFile,s.tripwireFile,s.targetFile]);
   await t.supervisor.assertHealthy(leaseId);
 }finally{await t.supervisor.stop();await rm(s.directory,{recursive:true,force:true});}
});

test('strict watcher refuses absent strict readiness flag',async()=>{
 const t=fixture({strict:true,forgedReady:true});
 await assert.rejects(t.supervisor.start(leaseId),/ready identity/);
 assert.equal(t.state.killed,true);
});

test('ready marker issued before native message pump fails closed for both modes',async()=>{
 for(const strict of [false,true]) {
   const t=fixture({strict,forgedPump:true});
   await assert.rejects(t.supervisor.start(leaseId),/ready identity/);
   assert.equal(t.state.killed,true);
 }
});
