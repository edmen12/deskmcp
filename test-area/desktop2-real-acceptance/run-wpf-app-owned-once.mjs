// Source-only WPF fixture-owned Dispatcher pipe acceptance. NOT a generic WPF
// control path. Never fall back to UIA ValuePattern, SendInput or desktop switch.
import fs from 'node:fs';
import {sendOwnedWpfPipeCommand} from './wpf-app-owned-pipe.mjs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {requireSafeNativeGuiMemory} from './resource-preflight.mjs';
import {terminateOwnedChild} from './owned-process-cleanup.mjs';
import {AgentDesktopManager} from '../../dist/src/agent-desktop-state.js';
import {AgentDesktopNativeBridge} from '../../dist/src/agent-desktop-native.js';
import {resolveDeskMcpStateRoot} from '../../dist/src/data-root.js';
import {Desktop2ObserverLifecycle} from '../../dist/src/desktop2-observer-lifecycle.js';
import {Desktop2WindowInventory} from '../../dist/src/desktop2-window-inventory.js';
import {Desktop2DirectUiaLeaseCoordinator,Desktop2DirectUiaProcessInvoker} from '../../dist/src/desktop2-direct-uia-lease.js';
import {Desktop2ComputerUseCandidate} from '../../dist/src/desktop2-computer-use-candidate.js';
import {Desktop2ComputerUseSession} from '../../dist/src/desktop2-computer-use-session.js';
import {ComputerWindowRegistry,ComputerUseCoordinator} from '../../dist/src/computer-use-registry.js';
import {ComputerObservationRegistry} from '../../dist/src/computer-use-observation.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..'), main=path.resolve(root,'../DeskMCP');
const lease=process.argv[2], sentinel=process.argv[3];
if(process.platform!=='win32'||process.argv.length!==4||
   !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(lease??'')||
   sentinel!=='OWNED_WPF_DISPATCHER_ONCE')
 throw Error('EXPLICIT_OWNED_WPF_DESKTOP2_TEST_LEASE_REQUIRED');
const sdk=path.join(main,'runtime','dotnet-sdk'),dotnet=path.join(sdk,'dotnet.exe');
const vda=path.join(main,'runtime','agent-desktop-runtime','win-x64','virtual-desktop-accessor','VirtualDesktopAccessor.dll');
const binary=(folder,name)=>path.join(root,'test-area',folder,'bin','Release','net10.0-windows',name);
const observer=binary('desktop2-switch-observer','DeskMCP.Desktop2SwitchObserver.exe');
const uia=binary('desktop2-direct-uia','DeskMCP.Desktop2DirectUia.exe');
const fixture=binary('desktop2-wpf-probe','DeskMCP.Desktop2WpfProbe.dll');
const host=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows','DeskMCP.AgentDesktopHost.exe');
for(const p of [dotnet,vda,observer,uia,fixture,host]){
 if(!fs.existsSync(p))throw Error('MISSING_PREBUILT_NATIVE_COMPONENT:'+path.basename(p));
}
process.env.DOTNET_ROOT=sdk;process.env.DOTNET_ROOT_X64=sdk;
process.env.DESKTOP_MCP_VDA_PATH=vda;
const out=path.join(here,'runs','wpf-owned-dispatcher-'+new Date().toISOString().replace(/[:.]/gu,'-'));
await mkdir(out,{recursive:true});
const ready=path.join(out,'wpf.ready.json'), release=path.join(out,'wpf.uncloak.flag'),
 app=path.join(out,'wpf.events.log'),timeline=path.join(out,'steps.jsonl');
const pipe='deskmcp-d2-wpf-'+randomUUID();
const token=randomBytes(32).toString('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function log(event,details={}){
 const row={utc:new Date().toISOString(),event,...details};
 fs.appendFileSync(timeline,JSON.stringify(row)+'\n');
 process.stdout.write(JSON.stringify(row)+'\n');
}
const native=new AgentDesktopNativeBridge(()=>host);
const leases=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
const watcher=new Desktop2ObserverLifecycle(leases,native,observer,vda);
const inventory=new Desktop2WindowInventory(leases,native,lease);
const direct=new Desktop2DirectUiaLeaseCoordinator(leases,native,new Desktop2DirectUiaProcessInvoker(uia,vda));
const runtime={windows:new ComputerWindowRegistry(),observations:new ComputerObservationRegistry(),
 coordinator:new ComputerUseCoordinator()};
const candidate=new Desktop2ComputerUseCandidate(runtime,direct,()=>inventory.list(),native);
const session=new Desktop2ComputerUseSession(lease,inventory,watcher,candidate);
let child,watch,trip=false,generation=null;
const result={pass:false,appClass:'WPF-owned-fixture-only',pipeScope:'current-user-per-test',
 desktopBefore:null,desktopAfter:null,observerExitConfirmed:false,ownedGuiExitConfirmed:false,
 leaseHeldThroughTeardown:false,tripwire:false,error:null,foregroundEvents:[],responses:[],
 observerEventPath:null,appEventPath:app,timelinePath:timeline};
async function guard(where){
 const info=await native.info();
 if(info.currentDesktopNumber!==1) {trip=true;throw Error('OWNER_DESKTOP_CHANGED_AT_'+where);}
 if(watch&&fs.existsSync(watch.tripwireFile)) {trip=true;throw Error('WATCHER_TRIPWIRE_AT_'+where);}
 if(watch)await watcher.assertHealthy(lease);
}
async function readyFile(deadlineMs){
 const limit=Date.now()+deadlineMs;
 while(Date.now()<limit){
  await guard('READY');
  if(fs.existsSync(ready))return JSON.parse(await readFile(ready,'utf8'));
  if(child&&(child.exitCode!==null||child.signalCode!==null))throw Error('WPF_EARLY_EXIT');
  await sleep(60);
 }
 throw Error('WPF_READY_TIMEOUT');
}
async function command(sequence,action,extra={}){
 return sendOwnedWpfPipeCommand({
  pipe,token,sequence,action,extra,
  // Re-arm evidence before any ENOENT-only reconnect; never resend after
  // an established connection because app callbacks could already run.
  onBeforeReconnect:()=>guard('PIPE_ENDPOINT_RECONNECT_NO_DELIVERY')
 });
}
try{
 const pre=await native.info(),proof=await leases.assertLease(lease);
 if(pre.currentDesktopNumber!==1||proof.control.desktopNumber!==2||
    proof.control.desktopId?.toLowerCase()!==proof.binding.desktopId.toLowerCase())
  throw Error('VERIFIED_OWNER_D1_AND_LEASE_D2_REQUIRED');
 result.desktopBefore=1;generation=proof.control.generation;
 log('PREFLIGHT_MEMORY',await requireSafeNativeGuiMemory());
 await session.start();watch=await watcher.assertHealthy(lease);
 result.observerEventPath=watch.eventLog;
 await requireSafeNativeGuiMemory();
 child=spawn(dotnet,[fixture,ready,release,app,'90000',pipe,token],{
  cwd:root,shell:false,windowsHide:true,env:process.env,stdio:['ignore','ignore','pipe']
 });
 log('WPF_OWNED_SPAWNED',{pid:child.pid??null});
 child.on('error',e=>log('WPF_OWNED_ERROR',{error:String(e)}));
 child.stderr.on('data',buf=>log('WPF_STDERR',{message:buf.toString().slice(0,300)}));
 const first=await readyFile(18000);
 if(first.pid!==child.pid||!Number.isSafeInteger(first.hwnd)||first.hwnd<1||
    first.dwmCloaked!==1||first.rootNoActivate!==true||
    first.initialForeground!==first.afterForeground)
  throw Error('WPF_INITIAL_NOACTIVATE_CLOAK_OR_PROCESS_ID_UNVERIFIED');
 await guard('CLOAK');
 const moved=await native.moveWindow(first.hwnd,proof.binding.desktopId);
 if(moved.desktopId?.toLowerCase()!==proof.binding.desktopId.toLowerCase())
  throw Error('WPF_DESKTOP2_MOVE_NOT_CONFIRMED');
 await guard('MOVE');
 await writeFile(release,'UN-CLOAK-AFTER-VERIFIED-DESKTOP2');
 await sleep(420);await guard('UNCLOAK');
 const found=(await session.discoverWindows()).filter(row=>
  row.window.hwnd===first.hwnd&&row.window.processId===first.pid);
 if(found.length!==1)throw Error('OWNED_WPF_WINDOW_NOT_UNIQUELY_DISCOVERED');
 await session.dispatch({phase:'arm',windowId:found[0].windowId,
  computerObservationId:found[0].computerObservationId});
 watch=await watcher.assertHealthy(lease);
 await guard('TARGET_WATCH_ARMED');
 // UIA mutation remains quarantined. App-local Dispatcher commands have
 // exact sequence, capability and expected-old-value checks.
 const actions=[
  [1,'edit',{expected:'',value:'D2_WPF_DISPATCHER_OK'}],
  [2,'edit',{expected:'WRONG_OLD_VALUE',value:'SHOULD_NOT_APPEAR'}],
  [3,'button',{}],
  [4,'scroll',{}],
 ];
 for(const [sequence,action,extra] of actions){
  await guard('BEFORE_'+sequence);
  const response=await command(sequence,action,extra);
  result.responses.push({sequence,action,...response});
  log('APP_DISPATCHER_REPLY',{sequence,action,ok:response.ok,error:response.error??null});
  if(sequence===2){
   if(response.ok!==false||response.error!=='STALE_OR_INVALID_EDIT')
    throw Error('STALE_WPF_EDIT_NOT_REJECTED');
  }else if(response.ok!==true||response.sequence!==sequence||
   (sequence===1&&response.actual!=='D2_WPF_DISPATCHER_OK')||
   (sequence===3&&response.actual!=='1')||
   (sequence===4&&!(Number(response.actual)>0)))
    throw Error('WPF_APPLICATION_COMMAND_RESULT_WRONG:'+sequence);
  await guard('AFTER_'+sequence);
 }
 await sleep(400);await guard('SETTLED');
 const raw=await readFile(app,'utf8');
 const lines=raw.split(/\r?\n/).filter(Boolean);
 const edits=lines.filter(x=>x.includes('APP_EDIT='));
 const clicks=lines.filter(x=>x.includes('APP_CLICK='));
 const scrolled=lines.filter(x=>x.includes('APP_SCROLLED='));
 const acks=lines.filter(x=>x.includes('APP_OWNED_ACK='));
 result.foregroundEvents=lines.filter(x=>/\b(ROOT_WM_(6|7|8|1C)|POPUP_WM_(6|7|8|1C))\b/iu.test(x));
 if(edits.length!==1||!edits[0].endsWith('APP_EDIT=D2_WPF_DISPATCHER_OK')||
    clicks.length!==1||!clicks[0].endsWith('APP_CLICK=1')||
    scrolled.length!==1||acks.length!==3||result.foregroundEvents.length>0)
  throw Error('WPF_APP_CALLBACK_OR_FOCUS_WITNESS_FAILED');
 log('WPF_APP_EFFECTS_VERIFIED',{edits:edits.length,clicks:clicks.length,
  scrolled:scrolled.length,successfulAcks:acks.length});
 result.pass=true;
}catch(e){
 result.error=e instanceof Error?e.message:String(e);
 log('FIRST_FAILURE_ABORT',{error:result.error});
}finally{
 if(child){
  try{result.ownedGuiExitConfirmed=await terminateOwnedChild(child,{deadlineMs:3000});}
  catch(e){result.error??='OWNED_GUI_TERMINATION:'+String(e);}
 }
 if(watch&&fs.existsSync(watch.tripwireFile))trip=true;
 try{
  await session.stop();
  result.observerExitConfirmed=Boolean(watch);
 }catch(e){result.error??='OBSERVER_STOP:'+String(e);}
 if(watch&&fs.existsSync(watch.tripwireFile))trip=true;
 result.tripwire=trip;
 result.desktopAfter=(await native.info().catch(()=>({currentDesktopNumber:null}))).currentDesktopNumber;
 try{
  const proof=await leases.assertLease(lease);
  result.leaseHeldThroughTeardown=Boolean(proof.control.active&&
   proof.control.generation===generation&&proof.control.desktopNumber===2&&
   proof.control.leaseId?.toLowerCase()===lease.toLowerCase());
 }catch{result.leaseHeldThroughTeardown=false;}
 result.pass=Boolean(result.pass&&!result.error&&!trip&&result.desktopAfter===1&&
  result.ownedGuiExitConfirmed&&result.observerExitConfirmed&&result.leaseHeldThroughTeardown);
 if(!result.pass&&!result.error)result.error='FINAL_SAFETY_OR_TEARDOWN_GATE_FAILED';
 await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));
 log('FINAL_RESULT',{pass:result.pass,error:result.error,desktopAfter:result.desktopAfter,
  tripwire:result.tripwire,ownedGuiExitConfirmed:result.ownedGuiExitConfirmed,
  observerExitConfirmed:result.observerExitConfirmed,leaseHeldThroughTeardown:result.leaseHeldThroughTeardown});
}
process.exitCode=result.pass?0:3;
