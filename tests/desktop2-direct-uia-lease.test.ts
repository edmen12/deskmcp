import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Desktop2DirectUiaLeaseCoordinator, type Desktop2UiaInvoker } from '../src/desktop2-direct-uia-lease.js';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';
import type { AgentDesktopNativeBridge } from '../src/agent-desktop-native.js';

const desktopId = 'd81244e4-e0c5-456f-a707-2b685a00662c';
const leaseId = 'a2519d05-1219-4c25-9a10-d1b35cef2812';
const hwnd = 72812;
const pid = 1774;
const observerReadyFile = path.resolve('test-area/desktop2-incident-trace/does-not-exist.ready.json');
const scope = { leaseId, window: { hwnd, processId: pid }, observerReadyFile };

interface Controls {
  owner: number;
  onOwner: boolean;
  targetDesktopId: string;
  desktopNumber: number;
  generation: number;
  leaseStopped: boolean;
  hudStale: boolean;
  targetLeaseMismatch: boolean;
  present: boolean;
  bindingHasDesktopNumber: boolean;
}
function fixture() {
  const state: Controls = {
    owner: 1, onOwner: false, targetDesktopId: desktopId, desktopNumber: 2,
    generation: 22, leaseStopped: false, hudStale: false, targetLeaseMismatch: false, present: true,
    bindingHasDesktopNumber: true
  };
  const calls: string[] = [];
  let returnResult: unknown = { armed: true };
  let executeHook: (()=>void) | undefined;
  const leases: Pick<AgentDesktopManager,'assertLease'|'assertWindowOnLease'> = {
    async assertLease(id) {
      calls.push('lease');
      if (state.leaseStopped || state.hudStale) throw new Error('No active lease or HUD heartbeat');
      assert.equal(id, leaseId);
      return {
        binding: { schemaVersion: 1, desktopId, boundAtUtc: new Date().toISOString(),
          ...(state.bindingHasDesktopNumber ? { desktopNumber: 2 } : {}) },
        control: { schemaVersion: 1, generation: state.generation, active: true,
          leaseId, desktopId, desktopNumber: 2, startedAtUtc: new Date().toISOString() }
      };
    },
    async assertWindowOnLease(target, id) {
      calls.push('window-lease');
      assert.equal(target, hwnd);
      assert.equal(id, leaseId);
      if (state.targetLeaseMismatch) throw new Error('Wrong window lease');
    }
  };
  const native: Pick<AgentDesktopNativeBridge,'info'|'desktopById'|'windowInfo'> = {
    async info() {
      calls.push('native-owner');
      return { officialApi: true, virtualDesktopAccessor: true, currentDesktopNumber: state.owner, desktopCount: 2 };
    },
    async desktopById(id) {
      calls.push('native-desktop');
      assert.equal(id, desktopId);
      return { desktopId, present: state.present, desktopNumber: state.desktopNumber, desktopCount: 2, currentDesktopNumber: state.owner };
    },
    async windowInfo(target) {
      calls.push('native-window');
      assert.equal(target, hwnd);
      return { hwnd: String(hwnd), desktopId: state.targetDesktopId,
        desktopNumber: state.desktopNumber, onCurrentDesktop: state.onOwner };
    }
  };
  const requests: Array<{ mode: string; request: object }> = [];
  const invoker: Desktop2UiaInvoker = {
    async execute(mode, request) {
      calls.push('native-uia-executed');
      requests.push({ mode, request });
      executeHook?.();
      return returnResult;
    }
  };
  const coordinator = new Desktop2DirectUiaLeaseCoordinator(leases,native,invoker);
  return { coordinator, state, calls, requests,
    setResult(value:unknown) {returnResult=value;},
    onExecute(hook:()=>void){executeHook=hook;} };
}

test('arm binds verified real Desktop2 HWND/PID to valid live Agent lease, not a Win32 Desktop Object',async()=>{
  const t=fixture();
  const result=await t.coordinator.arm(scope);
  assert.deepEqual(result,{armed:true,desktopId});
  assert.equal(t.requests.length,1);
  const call=t.requests[0]!;
  assert.equal(call.mode,'arm-target');
  assert.deepEqual(call.request,{
    action:'inspect',hwnd,processId:pid,desktopId,
    automationId:'__lease_arm_only__',observerReady:observerReadyFile
  });
  assert.ok(t.calls.indexOf('native-uia-executed')>t.calls.indexOf('window-lease'));
  assert.ok(t.calls.filter(x=>x==='lease').length>=4,'lease/HUD must be checked before and after arm');
});

test('confirmed real Desktop2 ValuePattern foreground theft is quarantined BEFORE any native call',async()=>{
  const t=fixture();
  t.setResult({uiaReadbackConfirmed:true,appEventConfirmed:false});
  await assert.rejects(
    t.coordinator.perform(scope,{type:'set_value',automationId:'WpfEdit',value:'Hello'}),
    /DIRECT_UIA_VALUEPATTERN_QUARANTINED_AFTER_FOREGROUND_THEFT/
  );
  assert.deepEqual(t.calls,[]);
  assert.equal(t.requests.length,0);
});

test('scroll top and bottom use only direct UIA ScrollPattern semantics',async()=>{
  const t=fixture();
  t.setResult({uiaReadbackConfirmed:true,appEventConfirmed:false});
  await t.coordinator.perform(scope,{type:'scroll',automationId:'WpfScroller',to:'top'});
  await t.coordinator.perform(scope,{type:'scroll',automationId:'WpfScroller',to:'bottom'});
  assert.deepEqual(t.requests.map(x=>(x.request as {action:string}).action),['scroll-top','scroll-bottom']);
});

test('dangerous actions and malformed input reject before ANY native or lease action',async()=>{
  const actions=[
    {type:'click',automationId:'Button'},
    {type:'send_keys',automationId:'Edit',value:'x'},
    {type:'set_value',automationId:'Edit',value:'a'.repeat(2049)},
    {type:'set_value',automationId:'Edit',value:'bad\nnewline'},
    {type:'set_value',automationId:'',value:'x'},
    {type:'scroll',automationId:'X',to:'middle'}
  ];
  for(const action of actions) {
    const t=fixture();
    await assert.rejects(t.coordinator.perform(scope,action as Parameters<typeof t.coordinator.perform>[1]));
    assert.deepEqual(t.calls,[]);
    assert.equal(t.requests.length,0);
  }
});

test('fail closed for owner Desktop2, pinned target, wrong desktop and revoked lease',async()=>{
  for(const bad of [
    {owner:2},{onOwner:true},{desktopNumber:1},
    {targetDesktopId:'113d513c-1111-4e21-9a2e-000000000000'},
    {present:false},{leaseStopped:true},{hudStale:true},{targetLeaseMismatch:true}
  ]) {
    const t=fixture();
    Object.assign(t.state,bad);
    await assert.rejects(t.coordinator.arm(scope));
    assert.equal(t.requests.length,0,JSON.stringify(bad));
  }
});

test('fake/stale requester lease cannot arm another window or bypass active Desktop2 binding',async()=>{
  const t=fixture();
  for(const invalid of [
    {...scope,leaseId:'broken'},
    {...scope,window:{hwnd:0,processId:pid}},
    {...scope,window:{hwnd,processId:0}},
    {...scope,observerReadyFile:'relative.ready.json'}
  ]) {
    await assert.rejects(t.coordinator.arm(invalid));
  }
  assert.equal(t.requests.length,0);
});

test('lease generation change after UIA action rejects even if UIA readback was successful',async()=>{
  const t=fixture();
  t.setResult({uiaReadbackConfirmed:true,appEventConfirmed:false});
  t.onExecute(()=>{t.state.generation=23;});
  await assert.rejects(t.coordinator.perform(scope,{type:'scroll',automationId:'WpfScroller',to:'bottom'}),
    /generation/);
  assert.equal(t.requests.length,1,'native provider side effect cannot be rolled back');
});

test('HUD loss or owner desktop switch during native call is detected on post-check',async()=>{
  for(const change of [(x:Controls)=>{x.hudStale=true;},(x:Controls)=>{x.owner=2;}]) {
    const t=fixture();
    t.setResult({uiaReadbackConfirmed:true,appEventConfirmed:false});
    t.onExecute(()=>change(t.state));
    await assert.rejects(t.coordinator.perform(scope,{type:'scroll',automationId:'WpfScroller',to:'bottom'}));
    assert.equal(t.requests.length,1);
  }
});

test('native helper result cannot claim app event confirmation without app-side witness',async()=>{
  const t=fixture();
  t.setResult({uiaReadbackConfirmed:true,appEventConfirmed:true});
  await assert.rejects(t.coordinator.perform(scope,{type:'scroll',automationId:'WpfScroller',to:'top'}),/readback/);
});

test('failed arming or incomplete readback never reports success',async()=>{
  const t=fixture();
  t.setResult({armed:false});
  await assert.rejects(t.coordinator.arm(scope),/not confirmed/);
  t.setResult({uiaReadbackConfirmed:false,appEventConfirmed:false});
  await assert.rejects(t.coordinator.perform(scope,{type:'scroll',automationId:'WpfScroller',to:'bottom'}),/not confirmed/);
});

test('older valid binding without optional desktopNumber still permits live Desktop2 control and VDA verification',async()=>{
  const t=fixture();
  t.state.bindingHasDesktopNumber=false;
  const result=await t.coordinator.arm(scope);
  assert.equal(result.armed,true);
  assert.equal(t.requests.length,1);
});

test('guarded inspect-tree uses sentinel and returns bounded metadata only, never a text value',async()=>{
 const t=fixture();
 t.setResult({operation:'inspect-tree',hwnd,processId:pid,scannedNodes:17,
  uiaReadbackConfirmed:false,appEventConfirmed:false,
  controls:[
    {automationId:'WpfEdit',controlType:'ControlType.Edit',className:'TextBox',
     canSetValue:true,canScrollTopBottom:false},
    {automationId:'WpfScroller',controlType:'ControlType.Pane',className:'ScrollViewer',
     canSetValue:false,canScrollTopBottom:true}
  ]});
 const result=await t.coordinator.inspectControls(scope);
 assert.equal(result.length,2);
 assert.equal(JSON.stringify(result).includes('password'),false);
 assert.deepEqual(t.requests[0],{mode:'request',request:{
  action:'inspect-tree',hwnd,processId:pid,desktopId,
  automationId:'__tree_snapshot__',observerReady:observerReadyFile
 }});
});

test('guarded inspect-tree rejects wrong HWND/PID, duplicates and forged mutable controls',async()=>{
 const base={operation:'inspect-tree',hwnd,processId:pid,scannedNodes:4,
  uiaReadbackConfirmed:false,appEventConfirmed:false};
 const ok={automationId:'Edit',controlType:'ControlType.Edit',className:'TextBox',
  canSetValue:true,canScrollTopBottom:false};
 for(const patch of [
  {hwnd:hwnd+1,controls:[ok]},
  {processId:pid+1,controls:[ok]},
  {controls:[ok,ok]},
  {controls:[{...ok,className:'Button'}]},
  {controls:[{...ok,canSetValue:false,canScrollTopBottom:false}]},
  {scannedNodes:129,controls:[ok]},
  {controls:Array.from({length:33},(_,i)=>({...ok,automationId:'Edit'+i}))}
 ]){
  const t=fixture();t.setResult({...base,...patch});
  await assert.rejects(t.coordinator.inspectControls(scope));
 }
});

test('native HWND Edit snapshot is separately issued without querying ValuePattern',async()=>{
 const t=fixture();
 t.setResult({operation:'inspect-native-edits',hwnd,processId:pid,scannedNodes:1,
  uiaReadbackConfirmed:false,appEventConfirmed:false,controls:[
   {automationId:'native-edit:884020',controlType:'NativeWin32.Edit',
    className:'WindowsForms10.Edit.app.0.2360855_r3_ad1',canSetValue:false,
    canScrollTopBottom:false,canSetNativeValue:true}
  ]});
 const result=await t.coordinator.inspectNativeControls(scope);
 assert.equal(result.length,1);
 assert.equal(result[0]?.canSetNativeValue,true);
 assert.deepEqual(t.requests[0],{mode:'request',request:{
  action:'inspect-native-edits',hwnd,processId:pid,desktopId,
  automationId:'__native_edit_snapshot__',observerReady:observerReadyFile
 }});
});

test('native Edit mutation carries verified child ID and exact previous text, without UIA ValuePattern',async()=>{
 const t=fixture();
 t.setResult({operation:'set-native-edit',textReadbackConfirmed:true,
  appEventConfirmed:false,foregroundSafetyUnproven:true});
 const result=await t.coordinator.perform(scope,{
  type:'set_native_edit',automationId:'native-edit:884020',value:'alpha',
  expectedPreviousValue:'old'
 });
 assert.deepEqual(result,{textReadbackConfirmed:true,
  appEventConfirmed:false,foregroundSafetyUnproven:true});
 assert.deepEqual(t.requests[0],{mode:'request',request:{
  action:'set-native-edit',hwnd,processId:pid,desktopId,
  automationId:'native-edit:884020',value:'alpha',expectedPreviousValue:'old',
  observerReady:observerReadyFile
 }});
});

test('native Edit entrypoint denies guessed IDs, control characters, excess text and false app success before lease/native',async()=>{
 const cases=[
  {automationId:'WpfEdit',value:'x',expectedPreviousValue:''},
  {automationId:'native-edit:0',value:'x',expectedPreviousValue:''},
  {automationId:'native-edit:9999999999999999999',value:'x',expectedPreviousValue:''},
  {automationId:'native-edit:123',value:'x'.repeat(513),expectedPreviousValue:''},
  {automationId:'native-edit:123',value:'x',expectedPreviousValue:'\n'},
  {automationId:'native-edit:123',value:'\t',expectedPreviousValue:''}
 ];
 for(const bad of cases){
  const t=fixture();
  await assert.rejects(t.coordinator.perform(scope,{type:'set_native_edit',...bad}));
  assert.equal(t.requests.length,0);
  assert.deepEqual(t.calls,[]);
 }
 const t=fixture();
 t.setResult({operation:'set-native-edit',textReadbackConfirmed:true,
  appEventConfirmed:true,foregroundSafetyUnproven:true});
 await assert.rejects(t.coordinator.perform(scope,{
  type:'set_native_edit',automationId:'native-edit:123',value:'x',expectedPreviousValue:''
 }),/readback/);
});

test('native HWND Edit enumeration rejects forged PID, wrong classes, duplicate and unbounded controls',async()=>{
 const good={automationId:'native-edit:123',controlType:'NativeWin32.Edit',
  className:'Edit',canSetValue:false,canScrollTopBottom:false,canSetNativeValue:true};
 const base={operation:'inspect-native-edits',hwnd,processId:pid,scannedNodes:1,
  uiaReadbackConfirmed:false,appEventConfirmed:false};
 for(const bad of [
  {hwnd:hwnd+1,controls:[good]},
  {processId:pid+1,controls:[good]},
  {controls:[good,good],scannedNodes:2},
  {controls:[{...good,canSetValue:true}]},
  {controls:[{...good,className:'Chrome_RenderWidgetHostHWND'}]},
  {controls:[{...good,automationId:'native-edit:abc'}]},
  {controls:[{...good,canSetNativeValue:false}]},
  {controls:[good],scannedNodes:129}
 ]){
  const t=fixture();t.setResult({...base,...bad});
  await assert.rejects(t.coordinator.inspectNativeControls(scope));
 }
});

test('native pushbutton inspect is bounded and separate from UIA Invoke and Edit',async()=>{
 const t=fixture();
 t.setResult({operation:'inspect-native-buttons',hwnd,processId:pid,scannedNodes:2,
  uiaReadbackConfirmed:false,appEventConfirmed:false,controls:[{
   automationId:'native-button:194857',controlType:'NativeWin32.Button',
   className:'WindowsForms10.BUTTON.app.0.123_r3_ad1',canSetValue:false,
   canScrollTopBottom:false,canSetNativeValue:false,canClickNative:true
  }]});
 const seen=await t.coordinator.inspectNativeButtons(scope);
 assert.equal(seen.length,1);
 assert.equal(seen[0]?.canClickNative,true);
 assert.deepEqual(t.requests[0],{mode:'request',request:{
  action:'inspect-native-buttons',hwnd,processId:pid,desktopId,
  automationId:'__native_button_snapshot__',observerReady:observerReadyFile
 }});
});

test('native pushbutton message result never claims application callback or focus safety',async()=>{
 const t=fixture();
 t.setResult({operation:'click-native-button',messageDispatched:true,
  appEventConfirmed:false,foregroundSafetyUnproven:true});
 const clicked=await t.coordinator.perform(scope,{
  type:'click_native_button',automationId:'native-button:194857'
 });
 assert.deepEqual(clicked,{messageDispatched:true,appEventConfirmed:false,
  foregroundSafetyUnproven:true});
 assert.deepEqual(t.requests[0],{mode:'request',request:{
  action:'click-native-button',hwnd,processId:pid,desktopId,
  automationId:'native-button:194857',observerReady:observerReadyFile
 }});
});

test('native pushbutton rejects forged handles and false-positive click confirmations',async()=>{
 for(const bad of ['WpfButton','native-edit:194857','native-button:0',
    'native-button:99999999999999999999','native-button:abc']){
  const t=fixture();
  await assert.rejects(t.coordinator.perform(scope,{
    type:'click_native_button',automationId:bad
  }));
  assert.equal(t.requests.length,0);
 }
 const t=fixture();
 t.setResult({operation:'click-native-button',messageDispatched:true,
  appEventConfirmed:true,foregroundSafetyUnproven:true});
 await assert.rejects(t.coordinator.perform(scope,{
  type:'click_native_button',automationId:'native-button:194857'
 }),/dispatch/);
});

test('native pushbutton snapshot rejects forged PID, class, duplicate capability or unsafe control types',async()=>{
 const good={automationId:'native-button:194857',controlType:'NativeWin32.Button',
  className:'WindowsForms10.Button.app.0.123_r3_ad1',
  canSetValue:false,canScrollTopBottom:false,canSetNativeValue:false,canClickNative:true};
 const base={operation:'inspect-native-buttons',hwnd,processId:pid,
  scannedNodes:1,uiaReadbackConfirmed:false,appEventConfirmed:false};
 for(const patch of [
  {hwnd:hwnd+1,controls:[good]},
  {processId:pid+1,controls:[good]},
  {controls:[good,good],scannedNodes:2},
  {controls:[{...good,automationId:'native-button:abc'}]},
  {controls:[{...good,controlType:'ControlType.Button'}]},
  {controls:[{...good,className:'Chrome_RenderWidgetHostHWND'}]},
  {controls:[{...good,canClickNative:false}]},
  {controls:[{...good,canSetValue:true}]},
  {controls:[good],scannedNodes:129}
 ]) {
   const t=fixture();t.setResult({...base,...patch});
   await assert.rejects(t.coordinator.inspectNativeButtons(scope));
 }
});
