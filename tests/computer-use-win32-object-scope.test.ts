import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AuditLogger } from '../src/audit.js';
import type { DesktopPolicy } from '../src/desktop-policy.js';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';
import type { ComputerUseRuntime } from '../src/computer-use-runtime.js';
import { ComputerWindowRegistry, ComputerUseCoordinator } from '../src/computer-use-registry.js';
import { ComputerObservationRegistry } from '../src/computer-use-observation.js';
import { ComputerSnapshotRegistry } from '../src/computer-use-read-model.js';
import { registerComputerUseTools } from '../src/computer-use-tools.js';

type Result = {content: Array<{type:string;text:string}>;isError?:boolean};
type Handler = (input: Record<string,unknown>) => Promise<Result>;
const firstLease='11111111-1111-4111-8111-111111111111';
const secondLease='22222222-2222-4222-8222-222222222222';

function fixture() {
  const handlers = new Map<string,Handler>();
  const server={registerTool(name:string, _schema:unknown, handler:Handler) {
    handlers.set(name,handler);
  }} as unknown as McpServer;
  const policy={assertCanUseComputer() {}} as unknown as DesktopPolicy;
  const audit={async begin(){return {};},async finish(){}} as unknown as AuditLogger;
  const target={hwnd:321,processId:456,processName:'winver',title:'About Windows',
    className:'#32770',width:640,height:480,isForeground:false};
  let appScope='',inspectScope='',scanCount=0,actCount=0;
  let active=true,ownerIsD1=true,rotate=false;
  let onInspect: (()=>void)|undefined;
  let objectWindows=[target];
  const agent={
    async assertWin32ObjectReadLease(leaseId:string) {
      if(!active||!ownerIsD1)throw Error('Owner desktop or lease unavailable');
      if(leaseId!==firstLease&&leaseId!==secondLease)throw Error('Wrong lease');
      return 'DeskMCP-Agent-'+(rotate?'OTHER':leaseId.replaceAll('-',''));
    },
    async assertLease(){ if(!active)throw Error('Lease expired'); },
    async hasActiveControls(){return active;},
    async activeLeaseForWindow(){return undefined;}
  } as unknown as AgentDesktopManager;
  const backend={
    async listWindows(_app?:string, scope?:string) {
      appScope=scope??'';
      return scope?objectWindows: [];
    },
    async inspect(hwnd:number,_interactiveOnly=true,_maxElements=80,scope?:string) {
      scanCount++;inspectScope=scope??'';onInspect?.();
      if(hwnd!==target.hwnd)throw Error('Wrong HWND');
      return {hwnd,elements:[{selector:'Version',type:'Text',value:'Winver'}],
        elementsTruncated:false};
    },
    async act(){actCount++;return {};},
    async screenshot(){throw Error('Screenshot not permitted');}
  };
  const runtime={
    backend,windows:new ComputerWindowRegistry(),
    observations:new ComputerObservationRegistry(),
    snapshots:new ComputerSnapshotRegistry(),
    coordinator:new ComputerUseCoordinator()
  } as unknown as ComputerUseRuntime;
  registerComputerUseTools(server,policy,audit,runtime,agent);
  const tool=(name:string)=>{const value=handlers.get(name);assert.ok(value);return value;};
  const decode=(r:Result)=>JSON.parse(r.content[0]!.text) as Record<string,unknown>;
  return {
    tool,decode,runtime,firstLease,secondLease,
    getScope:()=>appScope,getInspectScope:()=>inspectScope,
    getScanCount:()=>scanCount,getActCount:()=>actCount,
    setOwnerD1:(value:boolean)=>{ownerIsD1=value;},
    setLease:(value:boolean)=>{active=value;},
    setRotate:(value:boolean)=>{rotate=value;},
    setInspectHook:(value:(()=>void)|undefined)=>{onInspect=value;},
    clearWindows:()=>{objectWindows=[];}
  };
}

test('isolated Win32 object windows are separate, read-only capabilities',async()=>{
  const f=fixture();
  const listing=await f.tool('desktop_ui_object_windows')({agent_desktop_lease_id:firstLease});
  assert.equal(listing.isError,undefined);
  const doc=f.decode(listing);
  assert.equal(doc.desktop_scope,'isolated_win32_object');
  assert.equal(doc.action_authorized,false);
  const row=(doc.windows as Array<Record<string,unknown>>)[0]!;
  assert.ok(row.window_id);
  assert.match(f.getScope(),/^DeskMCP-Agent/);
  const snapshot=await f.tool('desktop_ui_object_snapshot')({
    agent_desktop_lease_id:firstLease,window_id:row.window_id
  });
  assert.equal(snapshot.isError,undefined);
  const reading=f.decode(snapshot);
  assert.equal(reading.desktop_scope,'isolated_win32_object');
  assert.equal(reading.read_only,true);
  assert.equal(reading.action_authorized,false);
  assert.equal('computer_observation_id' in reading,false);
  assert.equal((reading.elements as unknown[]).length,1);
  assert.equal(f.getInspectScope(),f.getScope());
  assert.equal(f.getActCount(),0);
  const oldAction=await f.tool('desktop_ui_action')({
    window_id:row.window_id,
    computer_observation_id:firstLease,
    action:'invoke',selector:'OK',allow_user_desktop:false
  });
  assert.equal(oldAction.isError,true);
  assert.equal(f.getActCount(),0);
});
test('window capabilities cannot cross Agent Desktop leases',async()=>{
  const f=fixture();
  const doc=f.decode(await f.tool('desktop_ui_object_windows')({agent_desktop_lease_id:firstLease}));
  const id=(doc.windows as Array<Record<string,string>>)[0]!.window_id;
  const denied=await f.tool('desktop_ui_object_snapshot')({
    agent_desktop_lease_id:secondLease,window_id:id
  });
  assert.equal(denied.isError,true);
  assert.equal(f.getScanCount(),0);
});
test('expired lease or changed owner desktop refuses all object reads',async()=>{
  const f=fixture();
  const doc=f.decode(await f.tool('desktop_ui_object_windows')({agent_desktop_lease_id:firstLease}));
  const id=(doc.windows as Array<Record<string,string>>)[0]!.window_id;
  f.setOwnerD1(false);
  const denied=await f.tool('desktop_ui_object_snapshot')({agent_desktop_lease_id:firstLease,window_id:id});
  assert.equal(denied.isError,true);
  assert.equal(f.getScanCount(),0);
  f.setOwnerD1(true);f.setLease(false);
  const list=await f.tool('desktop_ui_object_windows')({agent_desktop_lease_id:firstLease});
  assert.equal(list.isError,true);
});
test('window closure after listing refuses inspection without sending input',async()=>{
  const f=fixture();
  const doc=f.decode(await f.tool('desktop_ui_object_windows')({agent_desktop_lease_id:firstLease}));
  const id=(doc.windows as Array<Record<string,string>>)[0]!.window_id;
  f.clearWindows();
  const denied=await f.tool('desktop_ui_object_snapshot')({agent_desktop_lease_id:firstLease,window_id:id});
  assert.equal(denied.isError,true);
  assert.equal(f.getScanCount(),0);
  assert.equal(f.getActCount(),0);
});

test('owner desktop change inside UIA provider invalidates the whole snapshot',async()=>{
  const f=fixture();
  const doc=f.decode(await f.tool('desktop_ui_object_windows')({agent_desktop_lease_id:firstLease}));
  const id=(doc.windows as Array<Record<string,string>>)[0]!.window_id;
  f.setInspectHook(()=>f.setOwnerD1(false));
  const denied=await f.tool('desktop_ui_object_snapshot')({agent_desktop_lease_id:firstLease,window_id:id});
  assert.equal(denied.isError,true);
  assert.equal(f.getScanCount(),1);
  assert.equal(f.getActCount(),0);
});
test('object scope mutation or token replay under different lease fails closed',async()=>{
  const f=fixture();
  const doc=f.decode(await f.tool('desktop_ui_object_windows')({agent_desktop_lease_id:firstLease}));
  const id=(doc.windows as Array<Record<string,string>>)[0]!.window_id;
  f.setInspectHook(()=>f.setRotate(true));
  const denied=await f.tool('desktop_ui_object_snapshot')({agent_desktop_lease_id:firstLease,window_id:id});
  assert.equal(denied.isError,true);
  assert.equal(f.getActCount(),0);
});

test('identical native HWND and PID reused by a different lease receives a distinct capability',async()=>{
  const f=fixture();
  const first=f.decode(await f.tool('desktop_ui_object_windows')({
    agent_desktop_lease_id:firstLease
  }));
  const second=f.decode(await f.tool('desktop_ui_object_windows')({
    agent_desktop_lease_id:secondLease
  }));
  const id1=(first.windows as Array<Record<string,string>>)[0]!.window_id;
  const id2=(second.windows as Array<Record<string,string>>)[0]!.window_id;
  assert.notEqual(id1,id2);
  const rejected=await f.tool('desktop_ui_object_snapshot')({
    agent_desktop_lease_id:secondLease,window_id:id1
  });
  assert.equal(rejected.isError,true);
  assert.equal(f.getScanCount(),0);
  assert.equal(f.getActCount(),0);
});
