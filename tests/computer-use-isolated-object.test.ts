import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerObservationRegistry } from '../src/computer-use-observation.js';
import { ComputerUseCoordinator, ComputerWindowRegistry } from '../src/computer-use-registry.js';
import { registerComputerUseTools } from '../src/computer-use-tools.js';
import type { ComputerUseRuntime } from '../src/computer-use-runtime.js';
import type { ComputerWindow } from '../src/computer-use-backend.js';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';
import type { DesktopPolicy } from '../src/desktop-policy.js';
import type { AuditLogger } from '../src/audit.js';


const LEASE='11111111-1111-4111-8111-111111111111';
const OTHER_LEASE='22222222-2222-4222-8222-222222222222';
const OBJECT='DeskMCP-Agent-'+LEASE.replaceAll('-','');
function win(hwnd:number,title:string):ComputerWindow{
 return {hwnd,processId:hwnd+500,processName:'testapp',title,className:'WindowsForms10.Window.8.app',
   width:450,height:320,isForeground:false};
}
interface Invocation { readonly content:{type:string;text:string}[]; isError?:boolean; }
type Handler=(request:Record<string,unknown>)=>Promise<Invocation>;
function setup() {
 const d1=win(101,'Desktop 1 user window');
 const d2=win(102,'Desktop 2 virtual browser');
 const privateWin=win(201,'Desktop 2 private WinForms');
 const seen:{op:string;scope:string|undefined;hwnd?:number}[]=[];
 const backend={
   async listWindows(_app?:string,scope?:string) {
     seen.push({op:'list',scope});
     return scope===OBJECT?[privateWin]:[d1,d2];
   },
   async inspect(hwnd:number,_interactive:boolean,_max:number,scope?:string) {
     seen.push({op:'inspect',hwnd,scope});
     return {hwnd,elements:[{type:'Edit',name:'AgentInput',selector:'AgentInput',value:''}]};
   },
   async act(hwnd:number,action:{type:string},scope?:string) {
     seen.push({op:'act:'+action.type,hwnd,scope});
     return {success:true};
   }
 } as unknown as ComputerUseRuntime['backend'];
 const runtime:ComputerUseRuntime={
   backend, windows:new ComputerWindowRegistry(),
   observations:new ComputerObservationRegistry(),
   coordinator:new ComputerUseCoordinator()
 };
 const fakeDesktop={
   async desktopObjectNameForLease(id:string) {
     if(id!==LEASE)throw new Error('Wrong or revoked lease.');
     return OBJECT;
   },
   async assertLease(id:string){assert.equal(id,LEASE);return{};},
   async filterWindowsForLease(windows:readonly ComputerWindow[],id:string){
     assert.equal(id,LEASE);return windows.filter(w=>w.hwnd===d2.hwnd);
   },
   async assertWindowOnLease(hwnd:number,id:string){
     assert.equal(id,LEASE);
     assert.equal(hwnd,d2.hwnd,'private HWNDs must not be checked as virtual Desktop GUIDs');
   },
   async activeLeaseForWindow(hwnd:number){return hwnd===d2.hwnd?LEASE:undefined;}
 } as unknown as AgentDesktopManager;
 const handlers=new Map<string,Handler>();
 const server={registerTool(name:string,_description:unknown,handler:Handler){handlers.set(name,handler);}} as unknown as Parameters<typeof registerComputerUseTools>[0];
 const policy={profile:'Full Control',assertCanUseComputer(){},isFullyUnlocked(){return false;}} as unknown as DesktopPolicy;
 const audit={async begin(){return{};},async finish(){}} as unknown as AuditLogger;
 registerComputerUseTools(server,policy,audit,runtime,fakeDesktop);
 const invoke=async(name:string,request:Record<string,unknown>):Promise<Invocation>=>{
   const handler=handlers.get(name);
   assert.ok(handler,'handler was registered');
   const r=await handler(request);
   return r;
 };
 return {invoke,seen,runtime,d1,d2,privateWin};
}
test('Desktop 2 inventory merges virtual windows and private Desktop Object windows without leaking Desktop 1',async()=>{
 const t=setup();
 const result=await t.invoke('desktop_ui_windows',{agent_desktop_lease_id:LEASE,include_untitled:false});
 assert.equal(result.isError,undefined);
 const windows=JSON.parse(result.content[0]!.text) as {window_id:string;title:string}[];
 assert.deepEqual(windows.map(w=>w.title).sort(),['Desktop 2 private WinForms','Desktop 2 virtual browser']);
 assert.ok(!windows.some(w=>w.title.includes('Desktop 1')));
 assert.equal(t.runtime.windows.scope(windows.find(w=>w.title.includes('private'))!.window_id),OBJECT);
 assert.equal(t.runtime.windows.scope(windows.find(w=>w.title.includes('virtual'))!.window_id),undefined);
});
test('private Desktop 2 snapshot and set_value are routed only through the isolated desktop object',async()=>{
 const t=setup();
 const listed=await t.invoke('desktop_ui_windows',{agent_desktop_lease_id:LEASE});
 const windows=JSON.parse(listed.content[0]!.text) as {window_id:string;title:string}[];
 const id=windows.find(w=>w.title==='Desktop 2 private WinForms')!.window_id;
 const snap=await t.invoke('desktop_ui_snapshot',{
   window_id:id,agent_desktop_lease_id:LEASE,include_screenshot:false,include_tree:true
 });
 assert.equal(snap.isError,undefined);
 const data=JSON.parse(snap.content[0]!.text) as {computer_observation_id:string};
 assert.ok(t.seen.some(s=>s.op==='inspect'&&s.hwnd===t.privateWin.hwnd&&s.scope===OBJECT));
 const action=await t.invoke('desktop_ui_action',{
   window_id:id,computer_observation_id:data.computer_observation_id,
   agent_desktop_lease_id:LEASE,action:'set_value',selector:'AgentInput',
   value:'Private D2 input',settle_ms:0,observe_after:'tree'
 });
 assert.equal(action.isError,undefined,JSON.stringify(action));
 assert.ok(t.seen.some(s=>s.op==='act:set_value'&&s.scope===OBJECT&&s.hwnd===t.privateWin.hwnd));
 assert.ok(!t.seen.some(s=>s.op==='act:set_value'&&s.hwnd===t.d1.hwnd));
 assert.ok(t.seen.some(s=>s.op==='inspect'&&s.scope===OBJECT));
});
test('virtual Desktop 2 window uses default native path and remains GUID checked',async()=>{
 const t=setup();
 const listed=await t.invoke('desktop_ui_windows',{agent_desktop_lease_id:LEASE});
 const windows=JSON.parse(listed.content[0]!.text) as {window_id:string;title:string}[];
 const id=windows.find(w=>w.title==='Desktop 2 virtual browser')!.window_id;
 const snap=await t.invoke('desktop_ui_snapshot',{window_id:id,agent_desktop_lease_id:LEASE,include_tree:true});
 assert.equal(snap.isError,undefined);
 assert.ok(t.seen.some(s=>s.op==='inspect'&&s.hwnd===t.d2.hwnd&&s.scope===undefined));
});
test('a private-object window capability cannot be used against a different lease or unscoped Desktop 1',async()=>{
 const t=setup();
 const listed=await t.invoke('desktop_ui_windows',{agent_desktop_lease_id:LEASE});
 const windows=JSON.parse(listed.content[0]!.text) as {window_id:string;title:string}[];
 const id=windows.find(w=>w.title==='Desktop 2 private WinForms')!.window_id;
 const wrongLease=await t.invoke('desktop_ui_snapshot',{window_id:id,agent_desktop_lease_id:OTHER_LEASE});
 assert.equal(wrongLease.isError,true);
 const noLease=await t.invoke('desktop_ui_snapshot',{window_id:id});
 assert.equal(noLease.isError,true);
 assert.ok(!t.seen.some(s=>s.op==='inspect'&&s.hwnd===t.privateWin.hwnd));
});
test('registry never aliases the same HWND/PID between user desktop and private Win32 desktop object',()=>{
 const registry=new ComputerWindowRegistry();
 const window=win(555,'fake');
 const regular=registry.issue(window);
 const privateId=registry.issue(window,OBJECT);
 assert.notEqual(regular,privateId);
 assert.equal(registry.scope(privateId),OBJECT);
 assert.throws(()=>registry.resolve(privateId,[window]),/another Win32 Desktop Object/i);
 assert.throws(()=>registry.resolve(regular,[window],OBJECT),/another Win32 Desktop Object/i);
 assert.equal(registry.resolve(privateId,[window],OBJECT).hwnd,window.hwnd);
});
