// Strictly owned disposable WinForms fixture only; this is NOT a general GUI MCP endpoint.
// The installed Gateway/HUD supplies the lease. Does not init or revoke that lease.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {AgentDesktopNativeBridge} from '../../dist/src/agent-desktop-native.js';
import {AgentDesktopManager} from '../../dist/src/agent-desktop-state.js';
import {resolveDeskMcpStateRoot} from '../../dist/src/data-root.js';
import {composeRealDesktop2OwnedControl} from '../../dist/src/desktop2-real-owned-compose.js';
import {requireSafeNativeGuiMemory} from './resource-preflight.mjs';
import {terminateOwnedChild} from './owned-process-cleanup.mjs';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {AuditLogger} from '../../dist/src/audit.js';
import {DesktopPolicy} from '../../dist/src/desktop-policy.js';
import {DesktopBackendBridge} from '../../dist/src/desktop-backend-bridge.js';
import {ObservationStore} from '../../dist/src/observation-store.js';
import {ProcessSessionRegistry} from '../../dist/src/process-session-registry.js';
import {startHttpServer} from '../../dist/src/http-server.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const lease=process.argv[2],sentinel=process.argv[3];
if(process.argv.length!==4||sentinel!=='OWNED_NATIVE_WINFORMS_MCP_SINGLE_USE'
 ||!/^[a-f0-9]{8}-[a-f0-9-]{27}$/iu.test(lease??''))
 throw Error('EXACT_LEASE_AND_OWNED_TEST_SENTINEL_REQUIRED');
const repo=path.resolve(here,'../..');
// Keep the entire native fixture+observer toolchain in this exact staging branch.
const original=repo;
const sdk=path.resolve(repo,'../DeskMCP/runtime/dotnet-sdk');
const bin=(folder,name)=>path.join(original,'test-area',folder,'bin','Release','net10.0-windows',name);
const files={
 dotnet:path.join(sdk,'dotnet.exe'),
 vda:path.resolve(repo,'../DeskMCP/runtime/agent-desktop-runtime/win-x64/virtual-desktop-accessor/VirtualDesktopAccessor.dll'),
 native:path.join(original,'agent-desktop-host','bin','Release','net10.0-windows','DeskMCP.AgentDesktopHost.exe'),
 observer:bin('desktop2-switch-observer','DeskMCP.Desktop2SwitchObserver.exe'),
 uia:bin('desktop2-direct-uia','DeskMCP.Desktop2DirectUia.exe'),
 fixture:bin('desktop2-native-edit-probe','DeskMCP.Desktop2NativeEditProbe.dll')
};
for(const [name,p] of Object.entries(files)){
 if(!fs.existsSync(p))throw Error('OWNED_BRIDGE_TEST_BINARY_MISSING:'+name);
}
process.env.DOTNET_ROOT=sdk;
process.env.DOTNET_ROOT_X64=sdk;
process.env.DESKTOP_MCP_VDA_PATH=files.vda;
// SHA256 of the owned WinForms DLL freshly built from THIS branch's C# source.
const EXPECTED_OWNED_FIXTURE_SHA256='f189d5c5c2352e6bdbde58386d92b07a6adc1149d64332b2d2844f7c086a9904';
const fixtureSha=createHash('sha256').update(fs.readFileSync(files.fixture)).digest('hex');
if(fixtureSha!==EXPECTED_OWNED_FIXTURE_SHA256)
 throw Error('OWNED_FIXTURE_HASH_NOT_PINNED');
const out=path.join(here,'runs','native-owned-mcp-'+new Date().toISOString().replace(/[:.]/gu,'-'));
await mkdir(out,{recursive:true});
const ready=path.join(out,'fixture.ready.json'),
 uncloak=path.join(out,'fixture.uncloak.flag'),
 events=path.join(out,'fixture.events.log'),
 resultPath=path.join(out,'result.json');
let child,identity=null,opened=false,mcp,server;
const oldExperiment=process.env.DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT;
const native=new AgentDesktopNativeBridge(()=>files.native);
const leases=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
const result={pass:false,stage:'real-virtual-d2-owned-bridge',
 leaseValidated:false,observerStarted:false,discoveredOwned:false,
 editCallback:0,buttonCallback:0,listTop20:false,desktopBefore:null,
 desktopAfter:null,appFocusEvents:[],observerReleased:false,
 ownedGuiExitConfirmed:false,leaseHeldThroughTeardown:false,
 appEventVerified:false,mcpTransportVerified:false,mcpDeniedReplay:false,
 mcpClientClosed:false,loopbackServerClosed:false,error:null,fixtureSha256:fixtureSha};
function log(e,props={}){process.stdout.write(JSON.stringify({event:e,...props})+'\n');}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function guard(stage){
 const desktop=await native.info();
 if(desktop.currentDesktopNumber!==1)throw Error('OWNER_DESKTOP1_SWITCH_ABORT_'+stage);
 const attested=await leases.assertLease(lease);
 if(attested.control.desktopNumber!==2||!attested.control.active)throw Error('HUD_LEASE_INACTIVE_'+stage);
 return attested;
}
async function waitForReady(){
 for(let i=0;i<180;i++){
  await guard('WAIT_FIXTURE');
  if(fs.existsSync(ready))return JSON.parse(await readFile(ready,'utf8'));
  if(!child||child.exitCode!==null||child.signalCode!==null)throw Error('OWNED_GUI_EXIT_BEFORE_READY');
  await sleep(50);
 }
 throw Error('OWNED_GUI_READY_TIMEOUT');
}
const bridge=composeRealDesktop2OwnedControl(leases,
 {observerExe:files.observer,uiaExe:files.uia,vdaDll:files.vda},
 async w => Boolean(child && identity && child.exitCode===null && child.signalCode===null && child.pid===w.processId &&
  identity.hwnd===w.hwnd && w.className?.startsWith('WindowsForms10.Window.') &&
  w.isForeground===false && identity.sha===fixtureSha &&
  createHash('sha256').update(fs.readFileSync(files.fixture)).digest('hex')===fixtureSha),native);

async function call(name,args,expectedError=false) {
 if(!mcp)throw Error('MCP_NOT_CONNECTED');
 const answer=await mcp.callTool({name:'desktop2_real_owned_'+name,arguments:args});
 const text=answer.content?.find(v=>v.type==='text')?.text??'';
 if(Boolean(answer.isError)!==expectedError)
  throw Error('MCP_UNEXPECTED_TOOL_RESULT_'+name+':'+text.slice(0,220));
 return expectedError?text:JSON.parse(text);
}
async function createTestGateway(){
 // A dedicated local random port and the exact real bridge; no production
 // index.ts insertion, no global scope or installed file changes.
 const policy=await DesktopPolicy.create({profile:'full-control',allowedRoots:[repo]});
 const audit=new AuditLogger(path.join(out,'audit.jsonl'));
 await audit.init();
 process.env.DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT='1';
 server=await startHttpServer('127.0.0.1',0,new DesktopBackendBridge(),
  policy,audit,new ObservationStore(),new ProcessSessionRegistry(),
  undefined,undefined,undefined,undefined,undefined,undefined,leases,bridge);
 mcp=new Client({name:'owned-winforms-native-mcp-e2e',version:'1.0.0'},
  {versionNegotiation:{mode:'auto'}});
 await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url+'/mcp')));
 const names=(await mcp.listTools()).tools.map(v=>v.name);
 for(const n of ['start','windows','snapshot','action','stop'])
  if(!names.includes('desktop2_real_owned_'+n))throw Error('STAGING_MCP_TOOL_NOT_REGISTERED_'+n);
 log('REAL_LOCAL_MCP_CONNECTED',{port:server.port});
}

try{
 await requireSafeNativeGuiMemory();
 const initial=await guard('PREFLIGHT');
 if(initial.binding.desktopId.toLowerCase()!==initial.control.desktopId?.toLowerCase())
  throw Error('BOUND_DESKTOP_MISMATCH');
 result.desktopBefore=1;result.leaseValidated=true;
 await createTestGateway();
 await call('start',{agent_desktop_lease_id:lease});
 opened=true;result.observerStarted=true;log('REAL_MCP_VDA_OBSERVER_ARMED');
 await requireSafeNativeGuiMemory();
 child=spawn(files.dotnet,[files.fixture,ready,uncloak,events,'60000'],{
  cwd:original,shell:false,windowsHide:true,env:process.env,stdio:'ignore'
 });
 child.on('error',e=>log('OWNED_FIXTURE_PROCESS_ERROR',{kind:e.name}));
 const first=await waitForReady();
 if(first.pid!==child.pid||typeof first.hwnd!=='number'||first.hwnd<1
   ||first.dwmCloaked!==1||first.rootNoActivate!==true
   ||first.initialForeground!==first.afterForeground)
  throw Error('UNTRUSTED_OWNED_HIDDEN_FIXTURE');
 identity={hwnd:first.hwnd,sha:fixtureSha};
 const moved=await native.moveWindow(first.hwnd,initial.binding.desktopId);
 if(moved.desktopId?.toLowerCase()!==initial.binding.desktopId.toLowerCase())
  throw Error('REAL_VDA_PLACEMENT_NOT_VERIFIED');
 await guard('MOVED');
 await writeFile(uncloak,'UN-CLOAK-AFTER-VERIFIED-DESKTOP2');
 await sleep(380);await guard('UNCLOAK');
 const seen=await call('windows',{agent_desktop_lease_id:lease});
 const list=seen.windows;
 if(list.length!==1)throw Error('OWNED_MCP_DID_NOT_DISCOVER_EXACTLY_ONE_WINDOW');
 result.discoveredOwned=true;log('REAL_MCP_D2_OWNED_DISCOVERED',{count:list.length});
 const windowId=list[0].window_id;
 async function performMcpNative(kind,action) {
  const snap=await call('snapshot',{agent_desktop_lease_id:lease,window_id:windowId,kind});
  if(snap.controls.length!==1 || !snap.controls[0].control_id)
    throw Error('REAL_MCP_NATIVE_CONTROL_NOT_ATTESTED_'+kind);
  const args={agent_desktop_lease_id:lease,window_id:windowId,
   computer_observation_id:snap.computer_observation_id,
   control_id:snap.controls[0].control_id,action};
  const receipt=await call('action',args);
  if(!receipt.dispatched||receipt.app_event_verified!==false||
     receipt.business_outcome_verified!==false)
    throw Error('REAL_MCP_UNCONFIRMED_DELIVERY_'+kind);
  if(kind==='edit') {
   const denied=await call('action',args,true);
   if(!denied.includes('OPAQUE_ONESHOT_REAL_D2_PERMIT_INVALID'))
    throw Error('REAL_MCP_REPLAY_NOT_DENIED');
   result.mcpDeniedReplay=true;
  }
 }
 await performMcpNative('edit',{type:'set_native_edit',value:'D2_NATIVE_WINFORMS_ONE_SHOT',
  expected_previous_value:''});
 await guard('EDIT');
 await performMcpNative('button',{type:'click_native_button'});
 await guard('BUTTON');
 await performMcpNative('list',{type:'scroll_native_list',top_index:20,expected_previous_top_index:0});
 await sleep(480);await guard('LIST');
 result.mcpTransportVerified=true;
 const app=await readFile(events,'utf8');
 result.editCallback=app.split(/\r?\n/).filter(x=>x.includes('APP_EDIT=1:D2_NATIVE_WINFORMS_ONE_SHOT')).length;
 result.buttonCallback=app.split(/\r?\n/).filter(x=>x.includes('APP_BUTTON_CLICK=1')).length;
 result.listTop20=app.includes('APP_LIST_TOP=20');
 result.appFocusEvents=app.split(/\r?\n/).filter(x=>
  /\b(ROOT_WM_(6|7|8|1C)|EDIT_WM_(6|7|8|100|101|102)|BUTTON_WM_(6|7|8|100|101|102))\b/iu.test(x));
 if(result.editCallback!==1||result.buttonCallback!==1||
  !result.listTop20||result.appFocusEvents.length)
  throw Error('REAL_APP_CALLBACK_OR_FOREGROUND_GATE_FAILED');
 result.appEventVerified=true;
 log('REAL_APP_CALLBACKS_VERIFIED',{edit:result.editCallback,button:result.buttonCallback,listTop20:true});
} catch(err){
 result.error=err instanceof Error?err.message:String(err);
 log('FIRST_FAILURE_HALT',{reason:result.error});
} finally {
 if(child){
  try{result.ownedGuiExitConfirmed=await terminateOwnedChild(child,{deadlineMs:3000});}
  catch{result.error??='OWNED_GUI_EXIT_UNCONFIRMED';}
 }
 if(opened){
  try{
   if(mcp)await call('stop',{agent_desktop_lease_id:lease});
   else await bridge.stop(lease);
   result.observerReleased=true;
  }
  catch(err){result.error??='OBSERVER_STOP_FAILED';}
 }
 try{
  if(mcp){await mcp.close();result.mcpClientClosed=true;}
  if(server){await server.close();result.loopbackServerClosed=true;}
 }catch(err){result.error??='MCP_OR_STAGING_HTTP_SERVER_CLOSE_FAILED';}
 if(oldExperiment===undefined)delete process.env.DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT;
 else process.env.DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT=oldExperiment;
 try{
  const after=await guard('FINALLY');
  result.desktopAfter=1;
  result.leaseHeldThroughTeardown=after.control.active===true;
 }catch{result.error??='LEASE_OR_DESKTOP1_CHANGED_DURING_TEARDOWN';}
 result.pass=Boolean(result.mcpTransportVerified&&result.mcpDeniedReplay&&
  result.mcpClientClosed&&result.loopbackServerClosed&&result.leaseValidated&&result.observerStarted&&
  result.discoveredOwned&&result.appEventVerified&&result.observerReleased&&
  result.ownedGuiExitConfirmed&&result.leaseHeldThroughTeardown&&
  result.desktopBefore===1&&result.desktopAfter===1&&result.appFocusEvents.length===0&&!result.error);
 await writeFile(resultPath,JSON.stringify(result,null,2));
 log('FINAL_RESULT',{pass:result.pass,errors:result.error,
  appEventVerified:result.appEventVerified,mcpTransportVerified:result.mcpTransportVerified,
  deniedReplay:result.mcpDeniedReplay,desktopBefore:result.desktopBefore,
  desktopAfter:result.desktopAfter,ownedGuiExit:result.ownedGuiExitConfirmed,
  watcherExit:result.observerReleased,leaseHeld:result.leaseHeldThroughTeardown});
 if(!result.pass)process.exitCode=3;
}
