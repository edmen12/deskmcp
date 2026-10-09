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
  const native: Pick<Desktop2DirectUiaLeaseCoordinator, 'arm' | 'perform' | 'inspectControls' | 'inspectNativeControls' | 'inspectNativeButtons'> = {
    async arm(scope) { armed++; seen.push(scope); return {armed:true,desktopId:'d81244e4-e0c5-456f-a707-2b685a00662c'}; },
    async inspectControls() { return [
      {automationId:'WpfEdit',controlType:'ControlType.Edit',className:'TextBox',canSetValue:true,canScrollTopBottom:false},
      {automationId:'Edit',controlType:'ControlType.Edit',className:'TextBox',canSetValue:true,canScrollTopBottom:false},
      {automationId:'Scroller',controlType:'ControlType.Pane',className:'ScrollViewer',canSetValue:false,canScrollTopBottom:true}
    ]; },
    async inspectNativeControls(){ return [
      {automationId:'native-edit:884020',controlType:'NativeWin32.Edit',
        className:'Edit',canSetValue:false,canScrollTopBottom:false,canSetNativeValue:true}
    ]; },
    async inspectNativeButtons(){return [{
      automationId:'native-button:194857',controlType:'NativeWin32.Button',
      className:'WindowsForms10.Button.app.0.23_r3_ad1',canSetValue:false,
      canScrollTopBottom:false,canSetNativeValue:false,canClickNative:true
    }];},
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
  const snapshot=await t.adapter.snapshotWindow({
    windowId:t.windowId,agentDesktopLeaseId:lease,observerReadyFile:'C:\\tmp\\observer.ready.json'
  });
  assert.equal(snapshot.controls.length,3);
  const request={...t.input('perform',{type:'set_value',automationId:'WpfEdit',value:'Hello'}),
    computerObservationId:snapshot.computerObservationId};
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
  const inspect={windowId:t.windowId,agentDesktopLeaseId:lease,
    observerReadyFile:'C:\\tmp\\observer.ready.json'};
  const a=await t.adapter.snapshotWindow(inspect);
  const b=await t.adapter.snapshotWindow(inspect);
  const first={...t.input('perform',{type:'set_value',automationId:'Edit',value:'A'}),
    computerObservationId:a.computerObservationId};
  const second={...t.input('perform',{type:'set_value',automationId:'Edit',value:'B'}),
    computerObservationId:b.computerObservationId};
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

test('raw lease-bound observation cannot bypass guarded semantic snapshot',async()=>{
 const t=fixture();
 await assert.rejects(t.adapter.dispatch(t.input('perform',{
  type:'set_value',automationId:'WpfEdit',value:'blind write'
 })),/fresh protected semantic control snapshot/);
 assert.equal(t.invoked.performed,0);
});

test('snapshot binds exact allowed action semantics and burns mismatched permit',async()=>{
 const t=fixture();
 const parameters={windowId:t.windowId,agentDesktopLeaseId:lease,
  observerReadyFile:'C:\\tmp\\observer.ready.json'};
 const snap=await t.adapter.snapshotWindow(parameters);
 const req={...t.input('perform',{type:'set_value',automationId:'Scroller',value:'invalid'}),
  computerObservationId:snap.computerObservationId};
 await assert.rejects(t.adapter.dispatch(req),/fresh protected semantic control snapshot/);
 await assert.rejects(t.adapter.dispatch({...req,action:{
   type:'set_value' as const,automationId:'WpfEdit',value:'now allowed?'
 }}),/fresh protected semantic control snapshot/);
 assert.equal(t.invoked.performed,0);
});

test('bounded guarded snapshot cannot mint authority for forged window or user desktop HUD',async()=>{
 const t=fixture();
 t.setLive([{...window,processId:window.processId+111}]);
 await assert.rejects(t.adapter.snapshotWindow({windowId:t.windowId,
  agentDesktopLeaseId:lease,observerReadyFile:'C:\\tmp\\ready.json'}),/changed or closed/);
 assert.equal(t.invoked.performed,0);
});

test('passive discovery issues separate arm tokens bound to window capability and lease',async()=>{
 const t=fixture();
 const found=await t.adapter.discoverWindows(lease);
 assert.equal(found.length,1);
 assert.equal(found[0]?.windowId,t.windowId);
 const input={phase:'arm' as const,windowId:found[0]!.windowId,
  computerObservationId:found[0]!.computerObservationId,
  agentDesktopLeaseId:lease,observerReadyFile:'C:\\tmp\\ready.json'};
 await t.adapter.dispatch(input);
 await assert.rejects(t.adapter.dispatch(input),/observation/);
});

test('protected element observation cannot be replayed with another observer ready file',async()=>{
 const t=fixture();
 const snap=await t.adapter.snapshotWindow({windowId:t.windowId,
  agentDesktopLeaseId:lease,observerReadyFile:'C:\\observer-A\\ready.json'});
 const request={...t.input('perform',{type:'set_value',automationId:'WpfEdit',value:'cannot-cross'}),
  computerObservationId:snap.computerObservationId,observerReadyFile:'C:\\observer-B\\ready.json'};
 await assert.rejects(t.adapter.dispatch(request),/fresh protected semantic control snapshot/);
 assert.equal(t.invoked.performed,0);
});

test('native Edit action only accepts a protected native-only capability, not UIA observations',async()=>{
 const t=fixture();
 const observed={windowId:t.windowId,agentDesktopLeaseId:lease,
   observerReadyFile:'C:\\tmp\\observer.ready.json'};
 const ordinary=await t.adapter.snapshotWindow(observed);
 await assert.rejects(t.adapter.dispatch({
   ...t.input('arm'),phase:'perform',computerObservationId:ordinary.computerObservationId,
   action:{type:'set_native_edit',automationId:'native-edit:884020',
     expectedPreviousValue:'',value:'hello'}
 }),/fresh protected semantic control snapshot/);
 const native=await t.adapter.snapshotNativeWindow(observed);
 assert.equal(native.controls.length,1);
 assert.equal(native.controls[0]?.canSetNativeValue,true);
 const passed=await t.adapter.dispatch({
   ...t.input('arm'),phase:'perform',computerObservationId:native.computerObservationId,
   action:{type:'set_native_edit',automationId:'native-edit:884020',
     expectedPreviousValue:'',value:'hello'}
 });
 assert.deepEqual(passed,{uiaReadbackConfirmed:true,appEventConfirmed:false});
 assert.equal(t.invoked.performed,1);
});

test('native Edit controls cannot be forged with raw window capabilities or replayed',async()=>{
 const t=fixture();
 const observed={windowId:t.windowId,agentDesktopLeaseId:lease,
   observerReadyFile:'C:\\tmp\\observer.ready.json'};
 const input={...t.input('arm'),phase:'perform' as const,
   action:{type:'set_native_edit' as const,automationId:'native-edit:884020',
     expectedPreviousValue:'',value:'hello'}};
 await assert.rejects(t.adapter.dispatch(input),/fresh protected semantic control snapshot/);
 const snapshot=await t.adapter.snapshotNativeWindow(observed);
 const forged={...input,computerObservationId:snapshot.computerObservationId,
   action:{...input.action,automationId:'native-edit:999999'}};
 await assert.rejects(t.adapter.dispatch(forged),/fresh protected semantic control snapshot/);
 await assert.rejects(t.adapter.dispatch({...input,computerObservationId:snapshot.computerObservationId}),
   /fresh protected semantic control snapshot/);
 assert.equal(t.invoked.performed,0);
});

test('native Button click must carry distinct live button snapshot, not ordinary UIA or native Edit',async()=>{
 const t=fixture();
 const context={windowId:t.windowId,agentDesktopLeaseId:lease,
   observerReadyFile:'C:\\tmp\\observer.ready.json'};
 const raw=t.input('perform') as any;
 raw.action={type:'click_native_button',automationId:'native-button:194857'};
 await assert.rejects(t.adapter.dispatch(raw),/fresh protected semantic control snapshot/);
 const ordinary=await t.adapter.snapshotNativeWindow(context);
 await assert.rejects(t.adapter.dispatch({
   ...raw,computerObservationId:ordinary.computerObservationId
 }),/fresh protected semantic control snapshot/);
 const verified=await t.adapter.snapshotNativeButtons(context);
 assert.equal(verified.controls.length,1);
 assert.equal(verified.controls[0]?.canClickNative,true);
 const op={...raw,computerObservationId:verified.computerObservationId};
 await t.adapter.dispatch(op);
 assert.equal(t.invoked.performed,1);
 await assert.rejects(t.adapter.dispatch(op),/observation/);
});

test('forged native Button HWND burns one-use observation before any input',async()=>{
 const t=fixture();
 const context={windowId:t.windowId,agentDesktopLeaseId:lease,
  observerReadyFile:'C:\\tmp\\observer.ready.json'};
 const token=await t.adapter.snapshotNativeButtons(context);
 const attempt={...t.input('perform'),computerObservationId:token.computerObservationId,
  action:{type:'click_native_button' as const,automationId:'native-button:1234'}};
 await assert.rejects(t.adapter.dispatch(attempt),/fresh protected semantic control snapshot/);
 await assert.rejects(t.adapter.dispatch({...attempt,action:{
  type:'click_native_button' as const,automationId:'native-button:194857'
 }}),/fresh protected semantic control snapshot/);
 assert.equal(t.invoked.performed,0);
});
