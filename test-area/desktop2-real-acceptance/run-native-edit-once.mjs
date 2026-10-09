// OWNED WinForms HWND Edit only: two-phase real virtual Desktop2 acceptance.
// Stage 'inspect' never issues WM_SETTEXT. Stage 'write' sends at most ONE
// WM_SETTEXT to a prior, one-time native Edit capability if every guard passed.
// Never runs quarantined WPF direct UIA ValuePattern harness.
// No system SendInput, switching desktop, shared clipboard or auto-return.
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
const root=path.resolve(here,'../..');
const main=path.resolve(root,'../DeskMCP');
const lease=process.argv[2],stage=process.argv[3],sentinel=process.argv[4];
if(process.argv.length!==5||!['inspect','write','deny-stale'].includes(stage)
   ||sentinel!=='OWNED_WINFORMS_NATIVE_EDIT_ONCE'
   ||!/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(lease??''))
  throw Error('EXPLICIT_TEST_LEASE_STAGE_AND_OWNED_FIXTURE_REQUIRED');
if(process.platform!=='win32')throw Error('REAL_WINDOWS_REQUIRED');
const sdk=path.join(main,'runtime','dotnet-sdk');
const vda=path.join(main,'runtime','agent-desktop-runtime','win-x64','virtual-desktop-accessor','VirtualDesktopAccessor.dll');
const bin=(folder,name)=>path.join(root,'test-area',folder,'bin','Release','net10.0-windows',name);
const observer=bin('desktop2-switch-observer','DeskMCP.Desktop2SwitchObserver.exe');
const uia=bin('desktop2-direct-uia','DeskMCP.Desktop2DirectUia.exe');
const fixture=bin('desktop2-native-edit-probe','DeskMCP.Desktop2NativeEditProbe.dll');
const dotnet=path.join(sdk,'dotnet.exe');
const host=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows','DeskMCP.AgentDesktopHost.exe');
for(const p of [vda,observer,uia,fixture,dotnet,host])
  if(!fs.existsSync(p))throw Error('MISSING_VERIFIED_PREBUILT_BINARY:'+path.basename(p));
process.env.DOTNET_ROOT=sdk;
process.env.DOTNET_ROOT_X64=sdk;
process.env.DESKTOP_MCP_VDA_PATH=vda;
const out=path.join(here,'runs','native-'+stage+'-'+new Date().toISOString().replace(/[:.]/gu,'-'));
await mkdir(out,{recursive:true});
const ready=path.join(out,'owned-winforms.ready.json'),
  release=path.join(out,'owned-winforms.uncloak.flag'),
  app=path.join(out,'owned-winforms.events.log'),
  timeline=path.join(out,'steps.jsonl');
function log(event,details={}){
  const row={utc:new Date().toISOString(),event,...details};
  fs.appendFileSync(timeline,JSON.stringify(row)+'\n');
  process.stdout.write(JSON.stringify(row)+'\n');
}
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const native=new AgentDesktopNativeBridge(()=>host);
const leases=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
// DO NOT call leases.init() — it resets the production-owned Agent lease.
const watcher=new Desktop2ObserverLifecycle(leases,native,observer,vda);
const inventory=new Desktop2WindowInventory(leases,native,lease);
const direct=new Desktop2DirectUiaLeaseCoordinator(leases,native,
  new Desktop2DirectUiaProcessInvoker(uia,vda));
const runtime={
  windows:new ComputerWindowRegistry(),observations:new ComputerObservationRegistry(),
  coordinator:new ComputerUseCoordinator()
};
const computer=new Desktop2ComputerUseCandidate(runtime,direct,()=>inventory.list());
const session=new Desktop2ComputerUseSession(lease,inventory,watcher,computer);
let child,watch,trip=false;
const value='D2_NATIVE_WINFORMS_ONE_SHOT';
const result={
  stage,pass:false,desktopBefore:undefined,desktopAfter:undefined,
  claimedForegroundSafety:false,tripwire:false,error:undefined,
  observed:[],appCallbackCount:0,appFocusEvents:[],observerEventPath:null,
  appEventPath:app,timelinePath:timeline
};
async function guard(where){
  const state=await native.info();
  if(state.currentDesktopNumber!==1){
    trip=true;
    log('OWNER_VIRTUAL_DESKTOP_CHANGE_ABORT',{where,desktopNumber:state.currentDesktopNumber});
    throw Error('OWNER_DESKTOP_CHANGED_ABORT');
  }
  if(watch && fs.existsSync(watch.tripwireFile)){
    trip=true;
    const alarm=await readFile(watch.tripwireFile,'utf8').catch(()=>'(unreadable)');
    log('EARLY_FOREGROUND_OR_DESKTOP_TRIPWIRE',{where,alarm});
    throw Error('PASSIVE_FOREGROUND_TRIPWIRE_ABORT');
  }
  if(watch) await watcher.assertHealthy(lease);
}
async function awaitReady(ms){
  const limit=Date.now()+ms;
  while(Date.now()<limit){
    await guard('WAIT_READY');
    if(fs.existsSync(ready))return JSON.parse(await readFile(ready,'utf8'));
    if(child && child.exitCode!==null)throw Error('OWNED_WINFORMS_EARLY_EXIT');
    await sleep(50);
  }
  throw Error('OWNED_WINFORMS_READINESS_TIMEOUT');
}
try{
  const pre=await native.info();
  const proof=await leases.assertLease(lease);
  if(pre.currentDesktopNumber!==1||proof.control.desktopNumber!==2
    ||proof.control.desktopId?.toLowerCase()!==proof.binding.desktopId.toLowerCase())
    throw Error('OWNER_DESKTOP1_AND_ACTIVE_DESKTOP2_AGENT_LEASE_REQUIRED');
  result.desktopBefore=1;
  log('PREFLIGHT_PASS',{lease,desktopId:proof.binding.desktopId});
  await session.start();
  watch=await watcher.assertHealthy(lease);
  result.observerEventPath=watch.eventLog;
  log('OBSERVER_READY',{eventLog:watch.eventLog,readyFile:watch.readyFile});
  child=spawn(dotnet,[fixture,ready,release,app,'60000'],{
    cwd:root,shell:false,windowsHide:true,
    env:process.env,stdio:['ignore','ignore','pipe']
  });
  log('OWNED_FIXTURE_SPAWNED',{pid:child.pid??null});
  child.on('error',e=>log('FIXTURE_SPAWN_ERROR',{error:String(e)}));
  child.on('exit',(code,signal)=>log('FIXTURE_EXIT',{code,signal}));
  child.stderr.on('data',b=>log('FIXTURE_STDERR',{message:b.toString().slice(0,250)}));
  const first=await awaitReady(16000);
  log('OWNED_FIXTURE_CLOAKED',{hwnd:first.hwnd,pid:first.pid,
    childHwnd:first.childHwnd,childClass:first.childClass});
  if(first.dwmCloaked!==1||first.rootNoActivate!==true
    ||first.initialForeground!==first.afterForeground
    ||first.pid!==child.pid || typeof first.childHwnd!=='number'
    || !(first.childClass?.toLowerCase()==='edit'||first.childClass?.toLowerCase().startsWith('windowsforms10.edit.')))
    throw Error('OWNED_FIXTURE_PROTECTION_OR_PROCESS_IDENTITY_FAILED');
  await guard('FIXTURE_CLOAKED');
  const moved=await native.moveWindow(first.hwnd,proof.binding.desktopId);
  if(moved.desktopId.toLowerCase()!==proof.binding.desktopId.toLowerCase())
    throw Error('NATIVE_DESKTOP2_MOVE_NOT_VERIFIED');
  await guard('MOVE');
  await writeFile(release,'UN-CLOAK-AFTER-VERIFIED-DESKTOP2');
  await sleep(380);
  await guard('UNCLOAK');
  const found=(await session.discoverWindows()).filter(row=>
    row.window.hwnd===first.hwnd && row.window.processId===first.pid);
  if(found.length!==1)throw Error('PASSIVE_OWNED_WINDOW_NOT_FOUND_OR_AMBIGUOUS');
  const target=found[0];
  await session.dispatch({phase:'arm',windowId:target.windowId,
    computerObservationId:target.computerObservationId});
  await guard('TARGET_WATCH_ARMED');
  log('TARGET_FOREGROUND_HOOK_ARMED');
  const snap=await session.snapshotNativeWindow(target.windowId);
  result.observed=snap.controls;
  if(snap.controls.length!==1
    || snap.controls[0].automationId!=='native-edit:'+first.childHwnd
    || snap.controls[0].canSetNativeValue!==true)
    throw Error('NATIVE_EDIT_CHILD_ID_NOT_SEMANTICALLY_VERIFIED');
  await guard('NATIVE_SNAPSHOT');
  log('NATIVE_CHILD_CAPABILITY_PASS',{controls:snap.controls});
  if(stage==='deny-stale'){
    // Compare-and-swap safety: wrong old value MUST reject before WM_SETTEXT.
    let denied=false;
    try{
      await session.dispatch({
        phase:'perform',windowId:target.windowId,
        computerObservationId:snap.computerObservationId,
        action:{type:'set_native_edit',automationId:snap.controls[0].automationId,
          value,expectedPreviousValue:'INCORRECT_PRIOR_VALUE'}
      });
    }catch(e){
      denied=true;
      log('WRONG_PREVIOUS_VALUE_REJECTED',{error:e instanceof Error?e.message:String(e)});
    }
    if(!denied)throw Error('UNSAFE_STALE_EDIT_WAS_ACCEPTED');
    await guard('PRECONDITION_DENIAL');
    await sleep(280);
    await guard('DENIAL_SETTLED');
  }
  if(stage==='write'){
    // This is THE ONLY intentional WM_SETTEXT attempt in the stage.
    const applied=await session.dispatch({
      phase:'perform',windowId:target.windowId,
      computerObservationId:snap.computerObservationId,
      action:{type:'set_native_edit',automationId:snap.controls[0].automationId,
        value,expectedPreviousValue:''}
    });
    if(applied?.textReadbackConfirmed!==true||applied?.foregroundSafetyUnproven!==true
       ||applied?.appEventConfirmed!==false)
      throw Error('NATIVE_EDIT_RESULT_MISMATCH');
    await guard('WM_SETTEXT_COMPLETED');
    log('NATIVE_EDIT_WIN32_MESSAGE_READBACK_PASS');
    await sleep(280);
    await guard('POST_WRITE_SETTLE');
  }
  const appText=await readFile(app,'utf8').catch(()=>'(missing)');
  result.appFocusEvents=appText.split(/\r?\n/).filter(line=>
    /\b(ROOT_WM_(6|7|8|1C)|EDIT_WM_(6|7|8|100|101|102))\b/iu.test(line));
  result.appCallbackCount=appText.split(/\r?\n/).filter(line=>line.includes('APP_EDIT=')).length;
  const changes=appText.split(/\r?\n/).filter(line=>line.includes('APP_EDIT='));
  if(result.appFocusEvents.length)
    throw Error('APP_ACTIVATION_OR_KEYBOARD_FOCUS_EVENT_DETECTED');
  if(stage==='write'&&(changes.length!==1 || !changes[0].endsWith('APP_EDIT=1:'+value)))
    throw Error('APP_TEXT_CHANGED_CALLBACK_MISSING_OR_EXTRA_CHARACTERS');
  if(stage!=='write'&&changes.length!==0)
    throw Error('NON_WRITING_NATIVE_OPERATION_CAUSED_APP_TEXT_CHANGE');
  await guard('FINAL');
  result.pass=true;
  log('NATIVE_EDIT_'+stage.toUpperCase()+'_ACCEPTANCE_PASS',{callbackCount:result.appCallbackCount});
} catch(e){
  result.error=e instanceof Error?e.message:String(e);
  log('FIRST_FAILURE_HALT',{error:result.error});
} finally {
  // Do not auto-return user's desktop or retry the failed GUI action.
  await session.stop().catch(e=>log('SESSION_STOP_FAILED',{error:String(e)}));
  if(child && child.exitCode===null)child.kill();
  if(watch && fs.existsSync(watch.tripwireFile)){
    trip=true;
    result.tripwireEvidence=await readFile(watch.tripwireFile,'utf8').catch(()=>'(unreadable)');
  }
  result.tripwire=trip;
  const last=await native.info().catch(()=>({currentDesktopNumber:null}));
  result.desktopAfter=last.currentDesktopNumber;
  result.pass=result.pass&&!trip&&last.currentDesktopNumber===1;
  result.claimedForegroundSafety=result.pass; // only for owned one-off fixture
  await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));
  log('FINAL_RESULT',{stage,pass:result.pass,desktopAfter:result.desktopAfter,
    tripwire:result.tripwire,error:result.error,appCallbackCount:result.appCallbackCount,
    appFocusEvents:result.appFocusEvents.length});
}
if(!result.pass)process.exitCode=3;
