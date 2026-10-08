import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerObservationRegistry } from '../src/computer-use-observation.js';
import { ComputerUseCoordinator, ComputerWindowRegistry } from '../src/computer-use-registry.js';
import { Desktop2ComputerUseCandidate } from '../src/desktop2-computer-use-candidate.js';
import type { ComputerWindow } from '../src/computer-use-backend.js';
import type { Desktop2DirectUiaLeaseCoordinator } from '../src/desktop2-direct-uia-lease.js';

const lease = 'a2519d05-1219-4c25-9a10-d1b35cef2812';
const otherLease = 'e8d9ca2b-1f73-4fcd-993c-682cb11a0d72';
const window: ComputerWindow = {
  hwnd: 140206, processId: 8842, processName: 'WpfDemo.exe',
  className: 'HwndWrapper[WpfDemo;;foo]', title: 'WPF Test',
  width: 500, height: 400, isForeground: false
};
function fixture() {
  const windows = new ComputerWindowRegistry();
  const observations = new ComputerObservationRegistry();
  const coordinator = new ComputerUseCoordinator();
  const windowId = windows.issue(window);
  let live: readonly ComputerWindow[] = [window];
  let performed = 0, armed = 0;
  const seen: unknown[] = [];
  const native: Pick<Desktop2DirectUiaLeaseCoordinator, 'arm' | 'perform'> = {
    async arm(scope) { armed++; seen.push(scope); return {armed:true,desktopId:'d81244e4-e0c5-456f-a707-2b685a00662c'}; },
    async perform(scope,action) { performed++; seen.push({scope,action}); return {uiaReadbackConfirmed:true,appEventConfirmed:false}; }
  };
  const adapter=new Desktop2ComputerUseCandidate(
    {windows,observations,coordinator}, native, async()=>live
  );
  const input=(phase:'arm'|'perform',action?:{type:'set_value';automationId:string;value:string})=>{
    const computerObservationId=observations.issue(windowId,Date.now(),lease);
    return {phase, windowId, computerObservationId, agentDesktopLeaseId:lease,
      observerReadyFile:'C:\\tmp\\observer.ready.json', ...(action?{action}:{})};
  };
  return { windows,observations,coordinator,windowId,adapter,input,
    get invoked(){return {performed,armed};},seen,
    setLive(value:readonly ComputerWindow[]) {live=value;} };
}

test('real Computer Use one-time lease-bound observation is consumed before native arm',async()=>{
  const t=fixture();
  const request=t.input('arm');
  await t.adapter.dispatch(request);
  assert.deepEqual(t.invoked,{armed:1,performed:0});
  assert.deepEqual(t.seen[0],{
    leaseId:lease,window:{hwnd:window.hwnd,processId:window.processId},
    observerReadyFile:'C:\\tmp\\observer.ready.json'
  });
  await assert.rejects(t.adapter.dispatch(request),/observation/);
  assert.deepEqual(t.invoked,{armed:1,performed:0});
});

test('mutating action requires a NEW lease observation, not the observer arm token',async()=>{
  const t=fixture();
  const armed=t.input('arm');
  await t.adapter.dispatch(armed);
  const request=t.input('perform',{type:'set_value',automationId:'WpfEdit',value:'Hello'});
  const result=await t.adapter.dispatch(request);
  assert.deepEqual(result,{uiaReadbackConfirmed:true,appEventConfirmed:false});
  assert.equal(t.invoked.performed,1);
  assert.deepEqual((t.seen[1] as {action:unknown}).action,
    {type:'set_value',automationId:'WpfEdit',value:'Hello'});
});

test('observation without a lease cannot be upgraded to target Desktop2',async()=>{
  const t=fixture();
  const stale=t.observations.issue(t.windowId);
  await assert.rejects(t.adapter.dispatch({
    phase:'arm',windowId:t.windowId,computerObservationId:stale,
    agentDesktopLeaseId:lease,observerReadyFile:'C:\\tmp\\observer.ready.json'
  }),/matching lease-bound observation/);
  assert.deepEqual(t.invoked,{armed:0,performed:0});
});

test('observation from another lease cannot be replayed with a different lease parameter',async()=>{
  const t=fixture();
  const request=t.input('arm');
  await assert.rejects(t.adapter.dispatch({...request,agentDesktopLeaseId:otherLease}),/matching lease/);
  assert.deepEqual(t.invoked,{armed:0,performed:0});
});

test('window HWND reuse under another PID or process invalidates capability',async()=>{
  for(const changed of [
    {...window,processId:window.processId+1},
    {...window,processName:'Malicious.exe'},
    {...window,className:'UnexpectedWindow'}
  ]) {
    const t=fixture();
    t.setLive([changed]);
    await assert.rejects(t.adapter.dispatch(t.input('arm')),/changed or closed/);
    assert.deepEqual(t.invoked,{armed:0,performed:0});
  }
});

test('missing action or arm with action cannot touch native provider',async()=>{
  const t=fixture();
  await assert.rejects(t.adapter.dispatch(t.input('perform')),/explicit bounded semantic action/);
  const invalid=t.input('arm',{type:'set_value',automationId:'Edit',value:'x'});
  await assert.rejects(t.adapter.dispatch(invalid),/cannot execute a UI action/);
  assert.deepEqual(t.invoked,{armed:0,performed:0});
});

test('Agent HUD cannot be a Desktop2 Computer Use target even when observation issued',async()=>{
  const t=fixture();
  t.setLive([{...window,title:'DeskMCP Agent Desktop Safety HUD'}]);
  await assert.rejects(t.adapter.dispatch(t.input('arm')),/safety HUD/);
  assert.deepEqual(t.invoked,{armed:0,performed:0});
});

test('two observations of same window cannot both mutate after first consume and advance',async()=>{
  const t=fixture();
  const first=t.input('perform',{type:'set_value',automationId:'Edit',value:'A'});
  const second=t.input('perform',{type:'set_value',automationId:'Edit',value:'B'});
  await t.adapter.dispatch(first);
  await assert.rejects(t.adapter.dispatch(second),/stale/);
  assert.equal(t.invoked.performed,1);
});

test('global input generation invalidates stale Desktop2 observation',async()=>{
  const t=fixture();
  const request=t.input('arm');
  t.observations.advance('some-other-window',true);
  await assert.rejects(t.adapter.dispatch(request),/stale/);
  assert.deepEqual(t.invoked,{armed:0,performed:0});
});

test('native operation failure consumes capability and does not retry unsafe input',async()=>{
  const windows = new ComputerWindowRegistry();
  const observations = new ComputerObservationRegistry();
  const coordinator = new ComputerUseCoordinator();
  const windowId=windows.issue(window);
  const observation=observations.issue(windowId,Date.now(),lease);
  let tries=0;
  const adapter=new Desktop2ComputerUseCandidate(
    {windows,observations,coordinator},
    {async arm(){tries++;throw new Error('Native denied');},
      async perform(){tries++;throw new Error('Native denied');}},
    async()=>[window]
  );
  const req={phase:'arm' as const,windowId,computerObservationId:observation,
    agentDesktopLeaseId:lease,observerReadyFile:'C:\\tmp\\observer.ready.json'};
  await assert.rejects(adapter.dispatch(req),/Native denied/);
  await assert.rejects(adapter.dispatch(req),/observation/);
  assert.equal(tries,1);
});
