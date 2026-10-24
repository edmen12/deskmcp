import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';
import { AuditLogger } from '../src/audit.js';
import { DesktopBackendBridge } from '../src/desktop-backend-bridge.js';
import { DesktopPolicy } from '../src/desktop-policy.js';
import { startHttpServer } from '../src/http-server.js';
import { ObservationStore } from '../src/observation-store.js';
import { ProcessSessionRegistry } from '../src/process-session-registry.js';
import type { RealDesktop2OwnedControl } from '../src/desktop2-real-owned-control.js';

const lease='4d7c87d2-bcba-4a3e-b031-92d2e8a4a111';
const wid='cde27cf9-2ebd-4e0b-bef8-1f14dfa56012';
const observation='3db528d2-cd77-4e10-af0d-832975a24012';
function client() {
 return new Client({name:'desktop2-loopback-transport-test',version:'1.0.0'},
 {versionNegotiation:{mode:'auto'}});
}
function parseTool(result: {content?:unknown;isError?:unknown}) {
 const raw=JSON.stringify(result.content??[]);
 const match=/"text":"((?:\\.|[^"\\])*)"/u.exec(raw);
 assert.ok(match,raw);
 const message=JSON.parse('"'+match[1]+'"') as string;
 return {isError:result.isError===true,raw:message,
  value:message.startsWith('{')?JSON.parse(message) as Record<string,unknown>:null};
}
async function harness(inject:boolean,enabled:boolean) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'d2-mcp-http-'));
 const state={started:0,stopped:0,performed:0};
 const bridge = {
  async start(){state.started++;},
  async list(){return [{window_id:wid,app:'owned-fixture.exe',class_name:'WindowsForms10.Window'}];},
  async snapshot(){return {computer_observation_id:observation,one_shot_native_permit:true,
   controls:[{automationId:'native-edit:7123',controlType:'NativeWin32.Edit',
   className:'WindowsForms10.Edit',canSetNativeValue:true}]} ;},
  async perform(){state.performed++;return {dispatched:true,app_event_verified:false,business_outcome_verified:false};},
  async stop(){state.stopped++;}
 } as unknown as RealDesktop2OwnedControl;
 const agentDesktop={} as AgentDesktopManager;
 const policy=await DesktopPolicy.create({profile:'full-control',allowedRoots:[dir]});
 const audit=new AuditLogger(path.join(dir,'audit.jsonl'));await audit.init();
 const old=process.env.DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT;
 if(enabled)process.env.DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT='1';
 else delete process.env.DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT;
 let running:Awaited<ReturnType<typeof startHttpServer>>|undefined;
 const cli=client();
 try {
  running=await startHttpServer('127.0.0.1',0,
   new DesktopBackendBridge(),policy,audit,new ObservationStore(),
   new ProcessSessionRegistry(),undefined,undefined,undefined,undefined,undefined,
   undefined,agentDesktop,inject?bridge:undefined);
  await cli.connect(new StreamableHTTPClientTransport(new URL(running.url+'/mcp')));
  const listed=(await cli.listTools()).tools.map(x=>x.name);
  return {cli,running,dir,old,state,listed};
 } catch(error){
  await cli.close().catch(()=>undefined);
  await running?.close().catch(()=>undefined);
  if(old===undefined)delete process.env.DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT;
  else process.env.DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT=old;
  await rm(dir,{force:true,recursive:true});
  throw error;
 }
}
async function close(x:Awaited<ReturnType<typeof harness>>) {
 await x.cli.close();await x.running.close();
 if(x.old===undefined)delete process.env.DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT;
 else process.env.DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT=x.old;
 await rm(x.dir,{recursive:true,force:true});
}
test('loopback HTTP MCP hides real Desktop2 mutation tools by default and without internal bridge',async()=>{
 for(const [inject,enabled] of [[false,true],[true,false]] as const){
  const h=await harness(inject,enabled);
  try{assert.equal(h.listed.some(n=>n.startsWith('desktop2_real_owned_')),false);}
  finally{await close(h);}
 }
});
test('real loopback MCP client keeps one opaque native control permit across separate RPC requests',async()=>{
 const h=await harness(true,true);
 try{
  for(const name of ['desktop2_real_owned_start','desktop2_real_owned_windows',
   'desktop2_real_owned_snapshot','desktop2_real_owned_action','desktop2_real_owned_stop'])
   assert.ok(h.listed.includes(name),name);
  const call=async(name:string,args:Record<string,unknown>)=>parseTool(
   await h.cli.callTool({name,arguments:args}));
  const started=await call('desktop2_real_owned_start',{agent_desktop_lease_id:lease});
  assert.equal(started.isError,false,started.raw);
  const windows=await call('desktop2_real_owned_windows',{agent_desktop_lease_id:lease});
  assert.equal(windows.isError,false,windows.raw);
  const snap=await call('desktop2_real_owned_snapshot',{agent_desktop_lease_id:lease,window_id:wid,kind:'edit'});
  assert.equal(snap.isError,false,snap.raw);
  assert.doesNotMatch(snap.raw,/native-edit:|7123/);
  const controls=snap.value?.controls as Array<{control_id:string}>;
  assert.equal(controls.length,1);
  const args={agent_desktop_lease_id:lease,window_id:wid,
   computer_observation_id:observation,control_id:controls[0]!.control_id,
   action:{type:'set_native_edit',value:'HELLO',expected_previous_value:''}};
  const first=await call('desktop2_real_owned_action',args);
  assert.equal(first.isError,false,first.raw);
  assert.equal(first.value?.app_event_verified,false);
  const replay=await call('desktop2_real_owned_action',args);
  assert.equal(replay.isError,true);
  assert.equal(h.state.performed,1);
  const stopped=await call('desktop2_real_owned_stop',{agent_desktop_lease_id:lease});
  assert.equal(stopped.isError,false,stopped.raw);
  assert.equal(h.state.stopped,1);
 }finally{await close(h);}
});
