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
const root=path.resolve(here,'../..');
const main=path.resolve(root,'../DeskMCP');
const lease=process.argv[2],stage=process.argv[3],sentinel=process.argv[4];
if(process.argv.length!==5||!['inspect','write','deny-stale','button-inspect','button-click',
     'list-inspect','list-scroll','list-deny-stale','background-matrix','full-matrix'].includes(stage)
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
const computer=new Desktop2ComputerUseCandidate(runtime,direct,()=>inventory.list(),native);
const session=new Desktop2ComputerUseSession(lease,inventory,watcher,computer);
let child,watch,trip=false,expectedLeaseGeneration;
const value='D2_NATIVE_WINFORMS_ONE_SHOT';
const result={
  stage,pass:false,desktopBefore:undefined,desktopAfter:undefined,
  claimedForegroundSafety:false,tripwire:false,error:undefined,
  ownedGuiExitConfirmed:false,observerExitConfirmed:false,
  leaseHeldThroughTeardown:false,
  observed:[],appCallbackCount:0,appButtonCallbackCount:0,appListTopChanges:[],
  backgroundActions:[],backgroundAppWitnesses:[],
  appFocusEvents:[],observerEventPath:null,
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
    if(child && (child.exitCode!==null || child.signalCode!==null))
      throw Error('OWNED_WINFORMS_EARLY_EXIT');
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
  expectedLeaseGeneration=proof.control.generation;
  // Protect the owner PC before spawning even the monitor subprocess.
  // Low RAM must fail closed rather than slow or stall Desktop1.
  const memory=await requireSafeNativeGuiMemory();
  log('HOST_MEMORY_PREFLIGHT_PASS',memory);
  log('PREFLIGHT_PASS',{lease,desktopId:proof.binding.desktopId});
  await session.start();
  watch=await watcher.assertHealthy(lease);
  result.observerEventPath=watch.eventLog;
  log('OBSERVER_READY',{eventLog:watch.eventLog,readyFile:watch.readyFile});
  // Recheck after observer launch; do not start a GUI under sudden pressure.
  await requireSafeNativeGuiMemory();
  child=spawn(dotnet,[fixture,ready,release,app,stage==='full-matrix'?'90000':'60000'],{
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
  if(stage.startsWith('list-') && (
    !Number.isSafeInteger(first.listHwnd) || first.listHwnd<=0
    || !(first.listClass?.toLowerCase()==='listbox'
         || first.listClass?.toLowerCase().startsWith('windowsforms10.listbox.'))
    || !Number.isSafeInteger(first.listStyle) || (first.listStyle & 0x2230)!==0
    || first.listCount!==80 || first.listTop!==0
  ))throw Error('OWNED_NATIVE_LIST_STYLE_OR_HANDLE_UNVERIFIED');
  if(stage.startsWith('button-') && (
    !Number.isSafeInteger(first.buttonHwnd) || first.buttonHwnd<=0
    || !first.buttonClass?.toLowerCase().startsWith('windowsforms10.button.')
    || !Number.isSafeInteger(first.buttonStyle)
    || ![0,1].includes(first.buttonStyle & 0xF)
  ))throw Error('OWNED_NATIVE_PUSHBUTTON_STYLE_OR_HANDLE_UNVERIFIED');
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
  const buttonMode=stage==='button-inspect'||stage==='button-click';
  const listMode=stage.startsWith('list-');
  const snap=listMode
    ? await session.snapshotNativeLists(target.windowId)
    : buttonMode ? await session.snapshotNativeButtons(target.windowId)
    : await session.snapshotNativeWindow(target.windowId);
  result.observed=snap.controls;
  if(snap.controls.length!==1
    || (listMode
      ? snap.controls[0].automationId!=='native-list:'+first.listHwnd
        || snap.controls[0].canScrollNativeList!==true
      : buttonMode
      ? snap.controls[0].automationId!=='native-button:'+first.buttonHwnd
        || snap.controls[0].canClickNative!==true
      : snap.controls[0].automationId!=='native-edit:'+first.childHwnd
        || snap.controls[0].canSetNativeValue!==true))
    throw Error('NATIVE_CHILD_CAPABILITY_NOT_SEMANTICALLY_VERIFIED');
  await guard('NATIVE_SNAPSHOT');
  log('NATIVE_CHILD_CAPABILITY_PASS',{controls:snap.controls});
  if(stage==='background-matrix'||stage==='full-matrix'){
    // One guarded target-mode observer, one real Desktop2 root window and
    // a fresh single-use observation for EACH message action. The bridge
    // deliberately says confirmedAppState=false: only fixture logs can prove
    // that the app received each message.
    const messages=[
      {type:'move',x:315,y:185},
      {type:'click',x:315,y:185},
      {type:'right-click',x:315,y:185},
      {type:'double-click',x:315,y:185},
      {type:'drag',x:315,y:185,toX:345,toY:195,steps:4},
      {type:'wheel',x:315,y:185,delta:-120},
      {type:'text',text:'AGENT_BG'},
      {type:'key',vk:65}
    ];
    for(const action of messages){
      await guard('BACKGROUND_PRE_'+action.type);
      const choices=(await session.discoverWindows()).filter(row=>
        row.window.hwnd===first.hwnd && row.window.processId===first.pid);
      if(choices.length!==1)throw Error('BACKGROUND_EXACT_FRESH_D2_TARGET_REQUIRED');
      const candidate=choices[0];
      const sent=await session.backgroundMessage({
        windowId:candidate.windowId,
        computerObservationId:candidate.computerObservationId,action
      });
      if(sent.acceptedByWindowProcedure!==true
        ||sent.confirmedAppState!==false||sent.hostInputWasNotUsed!==true
        ||sent.desktopNumber!==2)
        throw Error('BACKGROUND_APP_ACK_WAS_INCORRECTLY_CLAIMED');
      result.backgroundActions.push(action.type);
      await guard('BACKGROUND_POST_'+action.type);
    }
    await sleep(350);
    await guard('BACKGROUND_MATRIX_SETTLED');
  }
  if(stage==='button-click'){
    // One native BM_CLICK, never SetActiveWindow or fallback global mouse.
    const clicked=await session.dispatch({
      phase:'perform',windowId:target.windowId,
      computerObservationId:snap.computerObservationId,
      action:{type:'click_native_button',automationId:snap.controls[0].automationId}
    });
    if(clicked?.messageDispatched!==true||clicked?.appEventConfirmed!==false
      ||clicked?.foregroundSafetyUnproven!==true)
      throw Error('NATIVE_BUTTON_DISPATCH_NOT_CONFIRMED');
    await guard('BM_CLICK_COMPLETE');
    await sleep(300);
    await guard('BM_CLICK_SETTLED');
    log('NATIVE_BUTTON_MESSAGE_DISPATCHED');
  }
  if(stage==='list-scroll'){
    // Exactly one guarded native LB_SETTOPINDEX, with a fresh one-use ListBox permit.
    const outcome=await session.dispatch({
      phase:'perform',windowId:target.windowId,
      computerObservationId:snap.computerObservationId,
      action:{type:'scroll_native_list',automationId:snap.controls[0].automationId,
        topIndex:20,expectedPreviousTopIndex:0}
    });
    if(outcome?.topIndexReadbackConfirmed!==true||outcome?.appEventConfirmed!==false
       ||outcome?.foregroundSafetyUnproven!==true)
      throw Error('LISTBOX_TOPINDEX_READBACK_NOT_CONFIRMED');
    await guard('NATIVE_LIST_SCROLL_COMPLETE');
    await sleep(350);
    await guard('NATIVE_LIST_SETTLED');
    log('NATIVE_LIST_TOPINDEX_READBACK_PASS');
  }
  if(stage==='list-deny-stale'){
    let denied=false;
    try{
      await session.dispatch({phase:'perform',windowId:target.windowId,
        computerObservationId:snap.computerObservationId,
        action:{type:'scroll_native_list',automationId:snap.controls[0].automationId,
          topIndex:20,expectedPreviousTopIndex:5}});
    }catch(e){denied=true;log('WRONG_TOPINDEX_REJECTED',{error:e instanceof Error?e.message:String(e)});}
    if(!denied)throw Error('NATIVE_LIST_STALE_SCROLL_UNSAFE_ACCEPTED');
    await guard('NATIVE_LIST_WRONG_OLD_INDEX_DENIED');
    await sleep(300);
    await guard('NATIVE_LIST_DENIAL_SETTLED');
  }
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
  if(stage==='full-matrix'){
    // Real application-state witnesses on the same owned D2 window after
    // generic root messages: TextChanged, Button.Click and ListBox.TopIndex.
    const editSnap=await session.snapshotNativeWindow(target.windowId);
    if(editSnap.controls.length!==1||editSnap.controls[0].canSetNativeValue!==true)
      throw Error('FULL_MATRIX_NATIVE_EDIT_UNAVAILABLE');
    const changed=await session.dispatch({
      phase:'perform',windowId:target.windowId,
      computerObservationId:editSnap.computerObservationId,
      action:{type:'set_native_edit',
        automationId:editSnap.controls[0].automationId,
        value,expectedPreviousValue:''}
    });
    if(changed?.textReadbackConfirmed!==true)
      throw Error('FULL_MATRIX_EDIT_VALUE_NOT_READ_BACK');
    await guard('FULL_MATRIX_EDIT');
    const buttonSnap=await session.snapshotNativeButtons(target.windowId);
    if(buttonSnap.controls.length!==1||buttonSnap.controls[0].canClickNative!==true)
      throw Error('FULL_MATRIX_NATIVE_BUTTON_UNAVAILABLE');
    const clicked=await session.dispatch({
      phase:'perform',windowId:target.windowId,
      computerObservationId:buttonSnap.computerObservationId,
      action:{type:'click_native_button',
        automationId:buttonSnap.controls[0].automationId}
    });
    if(clicked?.messageDispatched!==true)
      throw Error('FULL_MATRIX_BUTTON_MESSAGE_REJECTED');
    await guard('FULL_MATRIX_BUTTON');
    const listSnap=await session.snapshotNativeLists(target.windowId);
    if(listSnap.controls.length!==1||listSnap.controls[0].canScrollNativeList!==true)
      throw Error('FULL_MATRIX_NATIVE_LIST_UNAVAILABLE');
    const scrolled=await session.dispatch({
      phase:'perform',windowId:target.windowId,
      computerObservationId:listSnap.computerObservationId,
      action:{type:'scroll_native_list',
        automationId:listSnap.controls[0].automationId,
        topIndex:20,expectedPreviousTopIndex:0}
    });
    if(scrolled?.topIndexReadbackConfirmed!==true)
      throw Error('FULL_MATRIX_LIST_TOPINDEX_NOT_READ_BACK');
    await sleep(450);
    await guard('FULL_MATRIX_NATIVE_CALLBACKS');
  }
  const appText=await readFile(app,'utf8').catch(()=>'(missing)');
  if(stage==='background-matrix'||stage==='full-matrix'){
    const witness=['ROOT_WM_200','ROOT_WM_201','ROOT_WM_202',
      'ROOT_WM_203','ROOT_WM_204','ROOT_WM_205','ROOT_WM_20A',
      'ROOT_WM_100','ROOT_WM_101','ROOT_WM_102'];
    result.backgroundAppWitnesses=witness.filter(message=>appText.includes(message));
    if(result.backgroundActions.length!==8
       ||result.backgroundAppWitnesses.length!==witness.length)
      throw Error('BACKGROUND_WINDOW_PROCEDURE_MESSAGES_NOT_RECEIVED');
    // This proves the Win32 WndProc saw the messages, NOT that arbitrary
    // WPF/Electron/WinUI apps obey pointer/keyboard messages.
    log('BACKGROUND_ROOT_WNDPROC_WITNESSED',{
      messages:result.backgroundAppWitnesses,
      appStateConfirmed:false
    });
  }
  result.appFocusEvents=appText.split(/\r?\n/).filter(line=>
    /\b(ROOT_WM_(6|7|8|1C)|EDIT_WM_(6|7|8|100|101|102)|BUTTON_WM_(6|7|8|100|101|102))\b/iu.test(line));
  result.appCallbackCount=appText.split(/\r?\n/).filter(line=>line.includes('APP_EDIT=')).length;
  const changes=appText.split(/\r?\n/).filter(line=>line.includes('APP_EDIT='));
  const clickCallbacks=appText.split(/\r?\n/).filter(line=>line.includes('APP_BUTTON_CLICK='));
  result.appButtonCallbackCount=clickCallbacks.length;
  result.appListTopChanges=appText.split(/\r?\n/).filter(line=>line.includes('APP_LIST_TOP='));
  if((stage==='list-scroll'||stage==='full-matrix') && (result.appListTopChanges.length!==1
      || !result.appListTopChanges[0].endsWith('APP_LIST_TOP=20')))
    throw Error('LISTBOX_REAL_TOPINDEX_CHANGE_NOT_CONFIRMED');
  if(stage!=='list-scroll'&&stage!=='full-matrix' && result.appListTopChanges.length!==0)
    throw Error('LISTBOX_UNEXPECTED_SCROLL');
  if((stage==='button-click'||stage==='full-matrix')&&(clickCallbacks.length!==1
      || !clickCallbacks[0].endsWith('APP_BUTTON_CLICK=1')))
    throw Error('NATIVE_BUTTON_REAL_CALLBACK_NOT_EXACTLY_ONCE');
  if(stage!=='button-click'&&stage!=='full-matrix'&&clickCallbacks.length!==0)
    throw Error('NATIVE_BUTTON_UNEXPECTED_CALLBACK');
  if(result.appFocusEvents.length)
    throw Error('APP_ACTIVATION_OR_KEYBOARD_FOCUS_EVENT_DETECTED');
  if((stage==='write'||stage==='full-matrix')&&(changes.length!==1 || !changes[0].endsWith('APP_EDIT=1:'+value)))
    throw Error('APP_TEXT_CHANGED_CALLBACK_MISSING_OR_EXTRA_CHARACTERS');
  if(stage!=='write'&&stage!=='full-matrix'&&changes.length!==0)
    throw Error('NON_WRITING_NATIVE_OPERATION_CAUSED_APP_TEXT_CHANGE');
  await guard('FINAL');
  result.pass=true;
  log('NATIVE_EDIT_'+stage.toUpperCase()+'_ACCEPTANCE_PASS',{callbackCount:result.appCallbackCount});
} catch(e){
  result.error=e instanceof Error?e.message:String(e);
  log('FIRST_FAILURE_HALT',{error:result.error});
} finally {
  // Do not auto-return the owner's Desktop1 or repeat a failed GUI action.
  // The watcher MUST remain active while the actual owned GUI process exits.
  // Sending a kill signal alone is not evidence of process termination.
  if(child){
    try{
      result.ownedGuiExitConfirmed=await terminateOwnedChild(child,{deadlineMs:2500});
    }catch(e){
      result.error=result.error||('OWNED_GUI_CLEANUP_FAILED:'+String(e));
    }
    if(!result.ownedGuiExitConfirmed){
      result.error=result.error||'OWNED_GUI_EXIT_UNCONFIRMED';
      log('OWNED_GUI_EXIT_UNCONFIRMED');
    }
  }
  if(watch && fs.existsSync(watch.tripwireFile)){
    trip=true;
    result.tripwireEvidence=await readFile(watch.tripwireFile,'utf8').catch(()=>'(unreadable)');
  }
  try{
    await session.stop();
    result.observerExitConfirmed=Boolean(watch);
  }catch(e){
    result.error=result.error||('SESSION_STOP_FAILED:'+String(e));
    log('SESSION_STOP_FAILED',{error:String(e)});
  }
  // A late tripwire during fixture teardown still voids the experiment.
  if(watch && fs.existsSync(watch.tripwireFile)){
    trip=true;
    result.tripwireEvidence=await readFile(watch.tripwireFile,'utf8').catch(()=>'(unreadable)');
  }
  result.tripwire=trip;
  const last=await native.info().catch(()=>({currentDesktopNumber:null}));
  result.desktopAfter=last.currentDesktopNumber;
  // External orchestrator MUST keep the exact HUD lease alive until both
  // owned GUI and watcher have exited. Releasing it early invalidates PASS.
  try{
    const held=await leases.assertLease(lease);
    result.leaseHeldThroughTeardown=Boolean(held.control.active
      &&held.control.leaseId?.toLowerCase()===lease.toLowerCase()
      &&held.control.desktopNumber===2
      &&held.control.generation===expectedLeaseGeneration
      &&held.control.desktopId?.toLowerCase()===held.binding.desktopId.toLowerCase());
  }catch{
    result.leaseHeldThroughTeardown=false;
  }
  if(!result.leaseHeldThroughTeardown)
    result.error=result.error||'HUD_LEASE_RELEASED_BEFORE_GUI_TEARDOWN';
  result.pass=Boolean(result.pass&&result.ownedGuiExitConfirmed
    &&result.observerExitConfirmed&&result.leaseHeldThroughTeardown
    &&!trip&&last.currentDesktopNumber===1
    &&result.appFocusEvents.length===0&&!result.error);
  result.claimedForegroundSafety=result.pass; // ONLY owned one-off fixture
  await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));
  log('FINAL_RESULT',{stage,pass:result.pass,desktopAfter:result.desktopAfter,
    tripwire:result.tripwire,error:result.error,
    ownedGuiExitConfirmed:result.ownedGuiExitConfirmed,
    observerExitConfirmed:result.observerExitConfirmed,
    leaseHeldThroughTeardown:result.leaseHeldThroughTeardown,
    appCallbackCount:result.appCallbackCount,
    appFocusEvents:result.appFocusEvents.length});
}
if(!result.pass)process.exitCode=3;
