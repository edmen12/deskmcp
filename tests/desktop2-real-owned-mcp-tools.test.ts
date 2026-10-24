import test from 'node:test';
import assert from 'node:assert/strict';
import type {McpServer} from '@modelcontextprotocol/server';
import type {AuditLogger} from '../src/audit.js';
import type {DesktopPolicy} from '../src/desktop-policy.js';
import type {RealDesktop2OwnedControl} from '../src/desktop2-real-owned-control.js';
import {registerRealDesktop2OwnedControlTools} from '../src/desktop2-real-owned-mcp-tools.js';

const lease='4d7c87d2-bcba-4a3e-b031-92d2e8a4a111';
const wid='cde27cf9-2ebd-4e0b-bef8-1f14dfa56012';
const observation='3db528d2-cd77-4e10-af0d-832975a24012';
function setup(){
 const handlers=new Map<string,(input:Record<string,unknown>)=>Promise<{
  isError?:boolean;content:{type:string;text:string}[]}>>();
 const registrations=new Map<string,{annotations?:Record<string,unknown>}>();
 const server={registerTool(name:string,opts:{annotations?:Record<string,unknown>},fn:(input:Record<string,unknown>)=>Promise<unknown>){
  registrations.set(name,opts);handlers.set(name,fn as never);
 }} as unknown as McpServer;
 const state={policyAllowed:true,opened:false,actions:[] as unknown[],stops:0};
 const policy={profile:'full-control',assertCanUseComputer(){
  if(!state.policyAllowed)throw Error('policy denied');
 }} as unknown as DesktopPolicy;
 const audit={async begin(){return {id:'audit'};},async finish(){}} as unknown as AuditLogger;
 const bridge={
  async start(){state.opened=true;},
  async list(){return [{window_id:wid,app:'dotnet.exe',class_name:'WindowsForms10.Window'}];},
  async snapshot(){return {computer_observation_id:observation,one_shot_native_permit:true,
   controls:[{automationId:'native-edit:18233',controlType:'NativeWin32.Edit',
    className:'WindowsForms10.Edit',canSetNativeValue:true}]} ;},
  async perform(_lease:string,_wid:string,_obs:string,action:unknown){
   state.actions.push(action);return {dispatched:true,app_event_verified:false,business_outcome_verified:false};
  },
  async stop(){state.stops++;state.opened=false;}
 } as unknown as RealDesktop2OwnedControl;
 registerRealDesktop2OwnedControlTools(server,policy,audit,bridge);
 const invoke=async(name:string,input:Record<string,unknown>)=>{
  const h=handlers.get(name);assert.ok(h,'missing tool '+name);
  const result=await h(input);return {isError:result.isError===true,
   body:JSON.parse(result.content[0]!.text.slice(result.content[0]!.text.indexOf('{')>=0?result.content[0]!.text.indexOf('{'):0)) as Record<string,unknown>};
 };
 return {state,handlers,registrations,invoke};
}
test('owned real-D2 MCP registration contains only scoped tools with explicit read/write annotations',()=>{
 const {handlers,registrations}=setup();
 assert.deepEqual([...handlers.keys()].sort(),[
 'desktop2_real_owned_action','desktop2_real_owned_snapshot',
 'desktop2_real_owned_start','desktop2_real_owned_stop','desktop2_real_owned_windows'
 ]);
 assert.equal(registrations.get('desktop2_real_owned_action')?.annotations?.readOnlyHint,false);
 assert.equal(registrations.get('desktop2_real_owned_windows')?.annotations?.readOnlyHint,true);
});
test('MCP native control ids are opaque, single-use and do not disclose original HWND',async()=>{
 const {handlers,state}=setup();
 async function call(name:string,input:Record<string,unknown>){
  const v=await handlers.get(name)!(input);
  return {error:v.isError===true,text:v.content[0]!.text};
 }
 await call('desktop2_real_owned_start',{agent_desktop_lease_id:lease});
 await call('desktop2_real_owned_windows',{agent_desktop_lease_id:lease});
 const snap=await call('desktop2_real_owned_snapshot',{
  agent_desktop_lease_id:lease,window_id:wid,kind:'edit'
 });
 assert.equal(snap.error,false);
 assert.doesNotMatch(snap.text,/18233|native-edit:|hwnd|processId/);
 const parsed=JSON.parse(snap.text);
 assert.match(parsed.controls[0].control_id,/^[0-9a-f]{8}-/);
 const action={
  agent_desktop_lease_id:lease,window_id:wid,computer_observation_id:observation,
  control_id:parsed.controls[0].control_id,
  action:{type:'set_native_edit',value:'ALLOWED',expected_previous_value:''}
 };
 const first=await call('desktop2_real_owned_action',action);
 assert.equal(first.error,false);
 assert.equal(JSON.parse(first.text).app_event_verified,false);
 assert.equal(state.actions.length,1);
 assert.deepEqual(state.actions[0],{type:'set_native_edit',automationId:'native-edit:18233',
  value:'ALLOWED',expectedPreviousValue:''});
 const replay=await call('desktop2_real_owned_action',action);
 assert.equal(replay.error,true);assert.match(replay.text,/ONESHOT/);
 assert.equal(state.actions.length,1);
 await call('desktop2_real_owned_stop',{agent_desktop_lease_id:lease});
 assert.equal(state.stops,1);
});
test('wrong control action and wrong lease burn permit rather than dispatching',async()=>{
 const {handlers,state}=setup();
 const call=async(name:string,input:Record<string,unknown>)=>handlers.get(name)!(input);
 await call('desktop2_real_owned_start',{agent_desktop_lease_id:lease});
 const snap=await call('desktop2_real_owned_snapshot',{
  agent_desktop_lease_id:lease,window_id:wid,kind:'edit'
 });
 const ctrl=JSON.parse(snap.content[0]!.text).controls[0].control_id;
 const bad=await call('desktop2_real_owned_action',{
  agent_desktop_lease_id:lease,window_id:wid,computer_observation_id:observation,
  control_id:ctrl,action:{type:'click_native_button'}
 });
 assert.equal(bad.isError,true);assert.equal(state.actions.length,0);
 const retry=await call('desktop2_real_owned_action',{
  agent_desktop_lease_id:lease,window_id:wid,computer_observation_id:observation,
  control_id:ctrl,action:{type:'set_native_edit',value:'x',expected_previous_value:''}
 });
 assert.equal(retry.isError,true);
});
test('policy denied before operation even when registration was explicitly injected',async()=>{
 const {handlers,state}=setup();
 state.policyAllowed=false;
 const r=await handlers.get('desktop2_real_owned_start')!({agent_desktop_lease_id:lease});
 assert.equal(r.isError,true);
 assert.equal(state.opened,false);
});

test('policy revocation invalidates a previously issued opaque mutation permit',async()=>{
 const {handlers,state}=setup();
 const call=async(name:string,input:Record<string,unknown>)=>handlers.get(name)!(input);
 await call('desktop2_real_owned_start',{agent_desktop_lease_id:lease});
 const snap=await call('desktop2_real_owned_snapshot',{
  agent_desktop_lease_id:lease,window_id:wid,kind:'edit'
 });
 const controlId=JSON.parse(snap.content[0]!.text).controls[0].control_id;
 state.policyAllowed=false;
 const blocked=await call('desktop2_real_owned_windows',{agent_desktop_lease_id:lease});
 assert.equal(blocked.isError,true);
 state.policyAllowed=true;
 const stale=await call('desktop2_real_owned_action',{
  agent_desktop_lease_id:lease,window_id:wid,computer_observation_id:observation,
  control_id:controlId,action:{type:'set_native_edit',value:'x',expected_previous_value:''}
 });
 assert.equal(stale.isError,true);
 assert.equal(state.actions.length,0);
});
