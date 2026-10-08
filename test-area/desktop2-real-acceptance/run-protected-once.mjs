// One-shot real Desktop2 OWNED/WS_EX_NOACTIVATE WPF acceptance.
// NO WinApp, no input injection, no desktop switch/auto return, no production update.
// Quarantine all future invocations after 2026-10-09 real foreground-theft
// reproduction. Preserve this script as forensic evidence, not as an active test.
throw new Error('DIRECT_UIA_GUI_QUARANTINED_AFTER_CONFIRMED_FOREGROUND_THEFT');
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
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
const work=path.resolve(here,'../..');
const main=path.resolve(work,'../DeskMCP');
const sdk=path.join(main,'runtime','dotnet-sdk');
const vda=path.join(main,'runtime','agent-desktop-runtime','win-x64','virtual-desktop-accessor','VirtualDesktopAccessor.dll');
const binary=(folder,name)=>path.join(work,'test-area',folder,'bin','Release','net10.0-windows',name);
const observerExe=binary('desktop2-switch-observer','DeskMCP.Desktop2SwitchObserver.exe');
const uiaExe=binary('desktop2-direct-uia','DeskMCP.Desktop2DirectUia.exe');
const fixtureExe=binary('desktop2-wpf-probe','DeskMCP.Desktop2WpfProbe.exe');
const fixtureDll=fixtureExe.replace(/\.exe$/iu,'.dll');
const bundledDotnet=path.join(sdk,'dotnet.exe');
const host=path.join(work,'agent-desktop-host','bin','Release','net10.0-windows','DeskMCP.AgentDesktopHost.exe');
const leaseId=process.argv[2];
if(process.argv.length!==4||process.argv[3]!=='PROTECTED_OWNED_WPF_ONCE'
   || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(leaseId??''))
  throw Error('LIVE_TEST_REQUIRES_EXPLICIT_LEASE_AND_OWNED_FIXTURE_SENTINEL');
for(const f of [vda,observerExe,uiaExe,fixtureDll,bundledDotnet,host])
  if(!fs.existsSync(f))throw Error('MISSING_PREBUILT_BINARY:'+path.basename(f));
process.env.DOTNET_ROOT=sdk;
process.env.DOTNET_ROOT_X64=sdk;
process.env.DESKTOP_MCP_VDA_PATH=vda;
const out=path.join(here,'runs','guarded-'+new Date().toISOString().replace(/[:.]/gu,'-'));
await mkdir(out,{recursive:true});
const events=path.join(out,'steps.jsonl');
function log(stage,detail={}) {
 const row={utc:new Date().toISOString(),stage,...detail};
 fs.appendFileSync(events,JSON.stringify(row)+'\n');
 console.log(JSON.stringify(row));
}
const native=new AgentDesktopNativeBridge(()=>host);
const leases=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
// NEVER call leases.init(): it revokes real active production Gateway leases.
const watcher=new Desktop2ObserverLifecycle(leases,native,observerExe,vda);
const inventory=new Desktop2WindowInventory(leases,native,leaseId);
const uia=new Desktop2DirectUiaLeaseCoordinator(leases,native,new Desktop2DirectUiaProcessInvoker(uiaExe,vda));
const shared={windows:new ComputerWindowRegistry(),observations:new ComputerObservationRegistry(),
 coordinator:new ComputerUseCoordinator()};
const computer=new Desktop2ComputerUseCandidate(shared,uia,()=>inventory.list());
const session=new Desktop2ComputerUseSession(leaseId,inventory,watcher,computer);
let child,watch,trip=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ready=path.join(out,'wpf.ready.json'),release=path.join(out,'wpf.uncloak.flag');
const app=path.join(out,'wpf.app.log');
const result={pass:false,errors:[],desktopBefore:undefined,desktopAfter:undefined,
 tripwire:false,appCallback:false,inspected:[],stepsFile:events};
async function guard(phase){
 const info=await native.info();
 if(info.currentDesktopNumber!==1){trip=true;log('OWNER_SWITCHED',{phase,actual:info.currentDesktopNumber});throw Error('OWNER_DESKTOP_SWITCH_ABORT');}
 if(watch && fs.existsSync(watch.tripwireFile)){
   trip=true;log('SWITCH_OR_FOREGROUND_TRIPWIRE',{phase,tripwire:await readFile(watch.tripwireFile,'utf8')});
   throw Error('PASSIVE_TRIPWIRE_ABORT');
 }
 if(watch)await watcher.assertHealthy(leaseId);
}
async function fileReady(file,ms){
 const end=Date.now()+ms;
 while(Date.now()<end){
  await guard('WAIT_FIXTURE');
  if(fs.existsSync(file))return JSON.parse(await readFile(file,'utf8'));
  if(child?.exitCode!==null && child?.exitCode!==undefined)throw Error('OWNED_WPF_EARLY_EXIT');
  await sleep(45);
 }
 throw Error('OWNED_WPF_READY_TIMEOUT');
}
try {
 const initial=await native.info();
 const proof=await leases.assertLease(leaseId);
 if(initial.currentDesktopNumber!==1||proof.control.desktopNumber!==2)
   throw Error('OWNER_DESKTOP1_AGENT_DESKTOP2_LEASE_REQUIRED');
 result.desktopBefore=initial.currentDesktopNumber;
 log('PRECHECK_PASS',{desktopId:proof.binding.desktopId});
 await session.start();
 watch=await watcher.assertHealthy(leaseId);
 log('PASSIVE_FOREGROUND_MONITOR_READY',{monitor:watch.readyFile});
 // Use the exact bundled dotnet DLL launch mode that succeeded in the
 // earlier guarded WPF A/B; AppHost start/ready timing was not validated.
 child=spawn(bundledDotnet,[fixtureDll,ready,release,app,'65000'],{
   cwd:work,windowsHide:true,shell:false,env:process.env,
   stdio:['ignore','ignore','pipe']});
 log('OWNED_WPF_PROCESS_SPAWNED',{pid:child.pid??null});
 child.on('error',err=>log('OWNED_WPF_SPAWN_FAILED',{error:err.message}));
 child.on('exit',(code,signal)=>log('OWNED_WPF_EXITED',{code,signal}));
 child.stderr.on('data',chunk=>log('OWNED_WPF_RUNTIME_STDERR',{first300:chunk.toString().slice(0,300)}));
 const first=await fileReady(ready,14000);
 if(first.dwmCloaked!==1||first.initialForeground!==first.afterForeground)
   throw Error('CLOAK_OR_FOREGROUND_STARTUP_FAILED');
 log('OWNED_WPF_CLOAK_PASS',{pid:first.pid,hwnd:first.hwnd});
 const moved=await native.moveWindow(first.hwnd,proof.binding.desktopId);
 if(moved.desktopId.toLowerCase()!==proof.binding.desktopId.toLowerCase())
   throw Error('WINDOW_MOVE_DESKTOP2_UNVERIFIED');
 await guard('MOVED');
 await writeFile(release,'UN-CLOAK-AFTER-VERIFIED-DESKTOP2');
 await sleep(500);
 await guard('UNCLOAKED');
 const found=(await session.discoverWindows()).filter(x=>x.window.hwnd===first.hwnd
   &&x.window.processId===first.pid);
 if(found.length!==1)throw Error('PASSIVE_NATIVE_DESKTOP2_OWNED_WINDOW_MISSING');
 const target=found[0];
 log('PASSIVE_WINDOW_ID_ISSUED',{windowId:target.windowId});
 await session.dispatch({phase:'arm',windowId:target.windowId,
   computerObservationId:target.computerObservationId});
 await guard('ARMED');
 log('EARLY_FOREGROUND_TARGET_ARMED');
 const snapshot=await session.snapshotWindow(target.windowId);
 result.inspected=snapshot.controls;
 log('PROTECTED_UIA_METADATA_SNAPSHOT_PASS',{controls:snapshot.controls});
 await guard('SNAPSHOT');
 if(!snapshot.controls.some(c=>c.automationId==='WpfEdit'&&c.canSetValue))
   throw Error('TEXTBOX_MISSING_IN_METADATA_SNAPSHOT');
 if(!snapshot.controls.some(c=>c.automationId==='WpfScroller'&&c.canScrollTopBottom))
   throw Error('SCROLLER_MISSING_IN_METADATA_SNAPSHOT');
 const value='D2_CANDIDATE_UIA_ACCEPTANCE';
 const changed=await session.dispatch({phase:'perform',windowId:target.windowId,
   computerObservationId:snapshot.computerObservationId,
   action:{type:'set_value',automationId:'WpfEdit',value}});
 if(changed?.uiaReadbackConfirmed!==true)throw Error('VALUE_PATTERN_READBACK_NOT_PROVEN');
 await guard('VALUE_PATTERN');
 result.appCallback=(await readFile(app,'utf8')).includes('APP_EDIT='+value);
 if(!result.appCallback)throw Error('REAL_WPF_TEXT_CHANGED_CALLBACK_MISSING');
 log('VALUE_PATTERN_AND_APP_CALLBACK_PASS');
 const next=await session.snapshotWindow(target.windowId);
 const scrolled=await session.dispatch({phase:'perform',windowId:target.windowId,
   computerObservationId:next.computerObservationId,
   action:{type:'scroll',automationId:'WpfScroller',to:'bottom'}});
 if(scrolled?.uiaReadbackConfirmed!==true)throw Error('SCROLL_PATTERN_READBACK_NOT_PROVEN');
 await guard('SCROLL_PATTERN');
 log('SCROLL_PATTERN_PASS');
 result.pass=true;
} catch(err){
 const reason=err instanceof Error?err.message:String(err);
 result.errors.push(reason);log('FIRST_FAILURE_HALT',{reason});
} finally {
 await session.stop().catch(err=>log('MONITOR_STOP_ERROR',{error:String(err)}));
 if(child&&child.exitCode===null)child.kill();
 if(watch&&fs.existsSync(watch.tripwireFile)){
   trip=true;result.tripwireEvidence=await readFile(watch.tripwireFile,'utf8').catch(()=>null);
 }
 result.tripwire=trip;
 const final=await native.info().catch(()=>({currentDesktopNumber:null}));
 result.desktopAfter=final.currentDesktopNumber;
 result.pass=result.pass&&!trip&&result.desktopAfter===1;
 await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));
 log('TEST_RESULT',{pass:result.pass,desktopAfter:result.desktopAfter,tripwire:result.tripwire,
 errors:result.errors});
}
if(!result.pass)process.exitCode=3;
