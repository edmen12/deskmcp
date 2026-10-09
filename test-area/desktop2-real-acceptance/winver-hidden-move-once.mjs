// Candidate-only real Desktop2 acceptance of ONE fresh Windows Winver process.
// No user files, GUI input, clipboard, ShowWindow or unmonitored retries.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {requireSafeNativeGuiMemory} from './resource-preflight.mjs';
import {terminateOwnedChild} from './owned-process-cleanup.mjs';
import {AgentDesktopManager} from '../../dist/src/agent-desktop-state.js';
import {AgentDesktopNativeBridge} from '../../dist/src/agent-desktop-native.js';
import {Desktop2ObserverLifecycle} from '../../dist/src/desktop2-observer-lifecycle.js';
import {resolveDeskMcpStateRoot} from '../../dist/src/data-root.js';

const lease=process.argv[2],token=process.argv[3];
if(process.argv.length!==4||token!=='OWNED_WINVER_HIDDEN_MOVE_ONCE'
  ||!/^[0-9a-f]{8}-[0-9a-f-]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(lease??''))
  throw Error('EXPLICIT_OWNED_WINVER_LEASE_AND_TOKEN_REQUIRED');
if(process.platform!=='win32')throw Error('REAL_WINDOWS_ONLY');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const main=path.resolve(root,'../DeskMCP');
const host=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows','DeskMCP.AgentDesktopHost.exe');
const observer=path.join(root,'test-area','desktop2-switch-observer','bin','Release','net10.0-windows','DeskMCP.Desktop2SwitchObserver.exe');
const dll=path.join(main,'runtime','agent-desktop-runtime','win-x64','virtual-desktop-accessor','VirtualDesktopAccessor.dll');
const sdk=path.join(main,'runtime','dotnet-sdk');
const winver=path.join(process.env.SystemRoot||'C:\\Windows','System32','winver.exe');
for(const f of [host,observer,dll,winver])if(!fs.existsSync(f))
  throw Error('REQUIRED_SIGNED_SYSTEM_OR_OBSERVER_BINARY_MISSING');
process.env.DOTNET_ROOT=sdk;process.env.DOTNET_ROOT_X64=sdk;
process.env.DESKTOP_MCP_VDA_PATH=dll;
const native=new AgentDesktopNativeBridge(()=>host);
const manager=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
const watcher=new Desktop2ObserverLifecycle(manager,native,observer,dll,undefined,15000,true);
const run=path.join(root,'test-area','desktop2-real-acceptance','runs',
  'winver-hidden-move-'+new Date().toISOString().replace(/[:.]/gu,'-'));
await mkdir(run,{recursive:true});
const result={pass:false,stage:'one-owned-hidden-winver',before:null,after:null,
  observerArmed:false,messagePumpReady:false,createdPid:null,foundHidden:false,movedHidden:false,
  visibleDetected:false,focusEvents:0,tripwire:false,everSentInput:false,
  externalGUIStarted:false,cleanupConfirmed:false,readback:null,error:null,eventLog:null};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const invoke=promisify(execFile);
let session,child,ownPid=null;
const verify=async()=>{
  if(!session||fs.existsSync(session.tripwireFile))throw Error('WATCHER_NOT_ARMED_OR_TRIPPED');
  await watcher.assertHealthy(lease);
  const state=await native.info();
  if(state.currentDesktopNumber!==1)throw Error('OWNER_DESKTOP_NOT_ONE');
};
try{
  await requireSafeNativeGuiMemory();
  const state=await manager.assertLease(lease);
  if(state.control.desktopNumber!==2
    ||state.control.desktopId?.toLowerCase()!==state.binding.desktopId.toLowerCase()
    ||(await native.info()).currentDesktopNumber!==1)throw Error('OWNER_DESKTOP_LEASE_MISMATCH');
  result.before=1;
  session=await watcher.start(lease);
  result.eventLog=session.eventLog;
  result.observerArmed=true;
  await verify();
  await requireSafeNativeGuiMemory();
  await verify();
  const started=new Date().toISOString();
  child=spawn(winver,[],{shell:false,windowsHide:true,stdio:'ignore'});
  child.on('error',()=>{});
  ownPid=child.pid??0;
  if(!Number.isInteger(ownPid)||ownPid<=0)throw Error('OWNED_WINVER_LAUNCH_FAILED');
  result.externalGUIStarted=true;result.createdPid=ownPid;
  let discovered=null;
  const deadline=Date.now()+4300;
  while(Date.now()<deadline) {
    await verify();
    if(child.exitCode!==null||child.signalCode!==null)
      throw Error('OWNED_WINVER_EXITED_EARLY');
    const {stdout}=await invoke(host,['probe-hidden-winver','--pid',String(ownPid),
      '--started-utc',started],{windowsHide:true,shell:false,timeout:2300,
      maxBuffer:12000,env:process.env});
    const proof=JSON.parse(stdout);
    if(proof.pass!==true||proof.authorizedForInput!==false
      ||proof.signatureVerified!==false||proof.ownerDesktopBefore!==1
      ||proof.ownerDesktopAfter!==1||!Array.isArray(proof.hiddenWindows)
      ||proof.hiddenWindows.length!==proof.candidateCount||proof.candidateCount>1)
      throw Error('HIDDEN_PROBE_UNTRUSTED');
    if(proof.candidateCount===1) {
      const w=proof.hiddenWindows[0];
      if(w.visible!==false||w.desktopNumber!==1||w.className!=='#32770'
        ||!Number.isSafeInteger(w.hwnd)||w.hwnd<=0)
        throw Error('HIDDEN_DIALOG_IDENTITY_INVALID');
      discovered=w;break;
    }
    await wait(85);
  }
  if(!discovered)throw Error('HIDDEN_DIALOG_NOT_CREATED_WITHIN_DEADLINE');
  result.foundHidden=true;
  await requireSafeNativeGuiMemory();
  await verify();
  // Never route this external Winver trial through generic moveWindow.
  // Native host independently verifies the exact own PID/start, root HWND,
  // hidden state, user Desktop1 and fixed Desktop2 destination.
  // Native move must independently verify the live strict watcher, not
  // merely trust a previous Node-side assertHealthy() result.
  const observerReady=JSON.parse(await readFile(session.readyFile,'utf8'));
  if(!Number.isSafeInteger(observerReady.processId)||observerReady.processId<=0)
    throw Error('STRICT_OBSERVER_PID_MISSING');
  const move=await native.moveOwnedHiddenWinver(
    discovered.hwnd,ownPid,started,state.binding.desktopId,
    {readyFile:session.readyFile,tripwireFile:session.tripwireFile,
      exePath:observer,pid:observerReady.processId});
  if(move.hiddenMoveVerified!==true||move.ownerProcessId!==ownPid
    ||move.desktopId?.toLowerCase()!==state.binding.desktopId.toLowerCase()
    ||move.desktopNumber!==2||move.onCurrentDesktop!==false
    ||move.isVisible!==false)throw Error('HIDDEN_MOVE_READBACK_FAILED');
  await wait(250);
  await verify();
  const settled=await native.windowInfo(discovered.hwnd);
  if(settled.desktopId?.toLowerCase()!==state.binding.desktopId.toLowerCase()
    ||settled.desktopNumber!==2||settled.onCurrentDesktop!==false
    ||settled.isVisible!==false)
    throw Error('HIDDEN_WINVER_SETTLED_DESKTOP_MISMATCH');
  result.readback={desktopNumber:settled.desktopNumber,
    onCurrentDesktop:settled.onCurrentDesktop,isVisible:settled.isVisible};
  result.movedHidden=true;
  result.pass=true;
}catch(e){
  result.error=e?.stderr?.trim()||String(e);
  result.visibleDetected=result.error.includes('VISIBLE_WINDOW');
}
finally{
  // Terminate ONLY the PID we created. Keep observer running until the
  // owned app has exited; otherwise a late SHOW/focus event could be missed.
  try{
    const ownedChildTerminated=await terminateOwnedChild(child);
    result.cleanupConfirmed=Boolean(child)&&ownedChildTerminated;
  }catch(e){
    result.cleanupConfirmed=false;
    result.error=result.error||('OWNED_WINVER_CLEANUP_ERROR:'+String(e));
  }
  if(child && !result.cleanupConfirmed)
    result.error=result.error||'OWNED_WINVER_TERMINATION_NOT_CONFIRMED';
  // The native watcher is now stopped (and its writer flushed) before
  // observing the final alarm ledger, not after an early partial read.
  let observerExited=false;
  try{
    const ended=await watcher.stop();
    observerExited=Boolean(session)&&ended.exitConfirmed===true;
  }catch(e){
    result.error=result.error||('WATCHER_STOP_FAILED:'+String(e));
  }
  if(session && !observerExited){
    result.error=result.error||'WATCHER_EXIT_UNCONFIRMED';
    result.pass=false;
  }
  if(session){
    result.tripwire=fs.existsSync(session.tripwireFile);
    const raw=await readFile(session.eventLog,'utf8').catch(()=>{
      result.error=result.error||'OBSERVER_EVENT_LOG_MISSING';result.pass=false;
      return '';
    });
    for(const line of raw.split(/\r?\n/).filter(Boolean)){
      try{
        const x=JSON.parse(line);
        if(x.kind==='READY_AFTER_MESSAGE_PUMP')result.messagePumpReady=true;
        if(x.kind==='FOREGROUND_CHANGED')result.focusEvents++;
        if(x.kind==='PRELAUNCH_VISIBLE_ROOT')result.visibleDetected=true;
      }catch{result.error='OBSERVER_LOG_CORRUPT';result.pass=false;}
    }
  }
  result.after=(await native.info().catch(()=>({currentDesktopNumber:null}))).currentDesktopNumber;
  result.pass=result.pass&&result.cleanupConfirmed&&result.messagePumpReady
    &&result.after===1
    &&!result.tripwire&&result.focusEvents===0&&!result.visibleDetected;
  await writeFile(path.join(run,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,runDirectory:run}));
}
if(!result.pass)process.exitCode=3;
