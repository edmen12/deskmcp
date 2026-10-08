import assert from 'node:assert/strict';
import test from 'node:test';
import { Desktop2ComputerUseSession } from '../src/desktop2-computer-use-session.js';
import type { Desktop2ObserverLifecycle, Desktop2ObserverSession } from '../src/desktop2-observer-lifecycle.js';
import type { Desktop2WindowInventory } from '../src/desktop2-window-inventory.js';
import type { Desktop2ComputerUseCandidate } from '../src/desktop2-computer-use-candidate.js';

const lease='a2519d05-1219-4c25-9a10-d1b35cef2812';
const observerSession:Desktop2ObserverSession={
 readyFile:'C:\\internal\\ready.json',targetFile:'C:\\internal\\target.json',
 tripwireFile:'C:\\internal\\tripwire.json',eventLog:'C:\\internal\\events.jsonl',
 directory:'C:\\internal'
};
function fixture(){
 const state={healthy:true,stopped:false,changed:false,lookups:0,
  inputs:[] as unknown[],outcome:true};
 const passive:Pick<Desktop2WindowInventory,'list'>={
  async list(){state.lookups++;return [{
    hwnd:55211,processId:123,processName:'WPF',
    className:'HwndWrapper[WPF]',title:'Owned',
    width:400,height:250,isForeground:false
  }];}
 };
 const observer:Pick<Desktop2ObserverLifecycle,'start'|'assertHealthy'|'stop'>={
  async start(id){assert.equal(id,lease);return observerSession;},
  async assertHealthy(id){
   assert.equal(id,lease);
   if(!state.healthy)throw new Error('latched tripwire');
   return state.changed?{...observerSession,readyFile:'C:\\attacker\\ready.json'}:observerSession;
  },
  async stop(){state.stopped=true;return {stopped:true};}
 };
 const actions:Pick<Desktop2ComputerUseCandidate,'dispatch'>={
  async dispatch(input){
   state.inputs.push(input);
   if(!state.outcome) state.healthy=false;
   return {uiaReadbackConfirmed:true,appEventConfirmed:false};
  }
 };
 return {state,session:new Desktop2ComputerUseSession(lease,passive,observer,actions)};
}

test('per-lease Computer Use session holds observer paths internally for read-only inventory',async()=>{
 const t=fixture();
 await assert.rejects(t.session.listWindows(),/not active/);
 await t.session.start();
 const result=await t.session.listWindows();
 assert.equal(result.length,1);
 assert.equal(result[0]?.hwnd,55211);
 assert.equal(t.state.lookups,1);
 await t.session.stop();
 assert.equal(t.state.stopped,true);
});

test('session refuses caller-supplied observer path and lease ID; injects its own',async()=>{
 const t=fixture();await t.session.start();
 const user={phase:'arm' as const,windowId:'window-id',
  computerObservationId:'observation-id',
  agentDesktopLeaseId:'user-forged-lease',
  observerReadyFile:'C:\\attacker\\ready.json'};
 await t.session.dispatch(user);
 assert.deepEqual(t.state.inputs,[{
  phase:'arm',windowId:'window-id',computerObservationId:'observation-id',
  agentDesktopLeaseId:lease,observerReadyFile:observerSession.readyFile
 }]);
 await t.session.stop();
});

test('tripwire, revoked HUD and observer PID/path mismatch deny further operations',async()=>{
 const a=fixture();await a.session.start();
 a.state.healthy=false;
 await assert.rejects(a.session.dispatch({phase:'arm',windowId:'1',computerObservationId:'2'}),/latched tripwire/);
 assert.equal(a.state.inputs.length,0);
 await a.session.stop();
 const b=fixture();await b.session.start();
 b.state.changed=true;
 await assert.rejects(b.session.listWindows(),/observer identity changed/);
 assert.equal(b.state.lookups,0);
 await b.session.stop();
});

test('tripwire during actual UIA provider operation rejects success after action',async()=>{
 const t=fixture();await t.session.start();
 t.state.outcome=false;
 await assert.rejects(t.session.dispatch({phase:'perform',windowId:'1',computerObservationId:'2'}),/latched tripwire/);
 assert.equal(t.state.inputs.length,1,'cannot undo provider side effects');
 await t.session.stop();
});

test('stop revokes session and prevents further inventory or action',async()=>{
 const t=fixture();await t.session.start();await t.session.stop();
 await assert.rejects(t.session.listWindows(),/not active/);
 await assert.rejects(t.session.dispatch({phase:'arm',windowId:'1',computerObservationId:'2'}),/not active/);
});

test('multiple starts fail instead of leaking another observer process',async()=>{
 const t=fixture();await t.session.start();
 await assert.rejects(t.session.start(),/already started/);
 await t.session.stop();
});

test('concurrent starts are denied and stop racing startup cannot rearm a revoked session',async()=>{
 let releaseStart:(()=>void)|undefined;
 let launches=0,stops=0;
 const ready=new Promise<void>(resolve=>{releaseStart=resolve;});
 const observer:Pick<Desktop2ObserverLifecycle,'start'|'assertHealthy'|'stop'>={
  async start(){launches++;await ready;return observerSession;},
  async assertHealthy(){return observerSession;},
  async stop(){stops++;return {stopped:true};}
 };
 const session=new Desktop2ComputerUseSession(lease,
  {async list(){return [];}},
  observer,
  {async dispatch(){return {uiaReadbackConfirmed:true,appEventConfirmed:false};}}
 );
 const opening=session.start();
 await assert.rejects(session.start(),/already started/);
 const stopping=session.stop();
 releaseStart!();
 await assert.rejects(opening,/stopped during startup/);
 await stopping;
 assert.equal(launches,1);
 assert.ok(stops>=1);
 await assert.rejects(session.listWindows(),/not active/);
});

test('session issues no caller-controlled lease or observer path for protected element snapshots',async()=>{
 const captured:unknown[]=[];
 const observer:Pick<Desktop2ObserverLifecycle,'start'|'assertHealthy'|'stop'>={
  async start(){return observerSession;},
  async assertHealthy(){return observerSession;},
  async stop(){return {stopped:true};}
 };
 const session=new Desktop2ComputerUseSession(lease,
  {async list(){return [];}},
  observer,
  {
   async discoverWindows(id){captured.push({discoverLease:id});return [];},
   async snapshotWindow(input){
    captured.push(input);
    return {computerObservationId:'internal-new-observation-id',controls:[]};
   },
   async dispatch(){return {uiaReadbackConfirmed:true,appEventConfirmed:false};}
  }
 );
 await session.start();
 assert.deepEqual(await session.discoverWindows(),[]);
 const snapshot=await session.snapshotWindow('only-current-window-capability');
 assert.equal(snapshot.computerObservationId,'internal-new-observation-id');
 assert.deepEqual(captured,[
  {discoverLease:lease},
  {windowId:'only-current-window-capability',
   agentDesktopLeaseId:lease,observerReadyFile:observerSession.readyFile}
 ]);
 await session.stop();
});

test('stop revokes new UIA immediately but keeps observer alive until in-flight native provider exits',async()=>{
 let started!:()=>void,release!:()=>void,stops=0;
 const began=new Promise<void>(resolve=>{started=resolve;});
 const unblock=new Promise<void>(resolve=>{release=resolve;});
 const observer:Pick<Desktop2ObserverLifecycle,'start'|'assertHealthy'|'stop'>={
  async start(){return observerSession;},
  async assertHealthy(){return observerSession;},
  async stop(){stops++;return {stopped:true};}
 };
 const session=new Desktop2ComputerUseSession(lease,{async list(){return [];}},
  observer,{async dispatch(){started();await unblock;return {uiaReadbackConfirmed:true,appEventConfirmed:false};}});
 await session.start();
 const inFlight=session.dispatch({phase:'arm',windowId:'window',computerObservationId:'obs'});
 await began;
 const stopping=session.stop();
 await Promise.resolve();
 assert.equal(stops,0,'observer must keep watching while provider is still running');
 release();
 await assert.rejects(inFlight,/revoked|not active/);
 await stopping;
 assert.equal(stops,1);
 await assert.rejects(session.dispatch({phase:'arm',windowId:'window',computerObservationId:'obs'}),/not active/);
});
