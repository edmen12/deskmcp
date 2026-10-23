// Candidate-only, self-owned WinForms UIA Invoke probe in private Win32 desktop object.
// Never an MCP action route. No global mouse/keyboard, window switch or retries.
import {existsSync} from 'node:fs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {OwnedWinFormsInvokeTrial, OWNED_WINFORMS_FIXTURE_DLL_SHA256} from '../../dist/src/computer-use-owned-invoke-gate.js';
import {classifyOwnedLaunchFailure,describeLeaseLoss} from '../../dist/src/computer-use-owned-launch-diagnostics.js';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {AgentDesktopManager} from '../../dist/src/agent-desktop-state.js';
import {AgentDesktopNativeBridge} from '../../dist/src/agent-desktop-native.js';
import {NativeWindowsProcessBackend} from '../../dist/src/native-process-backend.js';
import {WinAppComputerBackend} from '../../dist/src/computer-use-backend.js';
import {resolveDeskMcpStateRoot} from '../../dist/src/data-root.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const adjacent=path.join(path.dirname(root),'DeskMCP-D2-Native-Acceptance');
const out=path.join(root,'test-area','isolated-thirdparty-prelaunch','runs');
const nativeHost=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows','DeskMCP.AgentDesktopHost.exe');
const processHost=path.join(root,'process-host','bin','Release','net10.0-windows','win-x64','DeskMCP.ProcessHost.exe');
const watcherExe=path.join(adjacent,'test-area','desktop2-switch-observer','bin','Release','net10.0-windows','DeskMCP.Desktop2SwitchObserver.exe');
const watcherLib=path.join(adjacent,'dist','src','desktop2-observer-lifecycle.js');
const preflightLib=path.join(adjacent,'test-area','desktop2-real-acceptance','resource-preflight.mjs');
const fixtureExe=path.join(root,'test-area','desktop2-list-selection','fixture','bin','Release','net10.0-windows','DeskMCP.SelectionFixture.exe');
const fixtureDll=path.join(path.dirname(fixtureExe),'DeskMCP.SelectionFixture.dll');
const winapp=path.join(process.env.LOCALAPPDATA||'C:\\Users\\User\\AppData\\Local','Programs','DesktopMCP','gateway','winapp','winapp.exe');
const vda=process.env.DESKTOP_MCP_VDA_PATH?.trim();
const [lease,mode,sentinel]=process.argv.slice(2);
if(process.platform!=='win32'||process.argv.length!==5||!['read','invoke'].includes(mode)
  ||sentinel!==(mode==='read'
    ? 'OWNED_WINFORMS_OBJECT_UIA_READ_ONCE'
    : 'OWNED_WINFORMS_OBJECT_UIA_INVOKE_ONCE')
  ||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(lease??'')
  ||!vda||!path.isAbsolute(vda)||path.basename(vda).toLowerCase()!=='virtualdesktopaccessor.dll'
  ||![nativeHost,processHost,watcherExe,watcherLib,preflightLib,fixtureExe,fixtureDll,winapp,vda].every(existsSync))
  throw Error('OWNED_WINFORMS_EXACT_LEASE_MODE_AND_TRUSTED_BINARIES_REQUIRED');
const {Desktop2ObserverLifecycle}=await import(pathToFileURL(watcherLib).href);
const {requireSafeNativeGuiMemory}=await import(pathToFileURL(preflightLib).href);
const native=new AgentDesktopNativeBridge(()=>nativeHost);
const manager=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
const watcher=new Desktop2ObserverLifecycle(manager,native,watcherExe,vda,undefined,15000,true);
const backend=new NativeWindowsProcessBackend(processHost);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stamp=Date.now().toString(36);
const ready=path.join(out,'owned-winforms-'+stamp+'.ready.json');
const release=path.join(out,'owned-winforms-'+stamp+'.release.flag');
const events=path.join(out,'owned-winforms-'+stamp+'.events.log');
let watch,hostPid,started=false,windowHwnd=null,expectedPid=null;
const invokeGate=new OwnedWinFormsInvokeTrial();
let objectName='';
const result={mode,run_stamp:stamp,pass:false,owner_before:null,owner_after:null,
  fixture_verified:false,uncloaked:false,observer_armed:false,
  fixture_hash_verified:false,app_callback_attested:false,
  provider_controls:0,matched_owned_button:0,invoke_dispatched:false,
  app_click_callbacks:0,unexpected_focus_events:0,
  observer_quiet:false,owned_job_terminated:false,watcher_terminated:false,
  lease_held_to_cleanup:false,production_action_authorized:false,
  launch_failure_diagnostic:null,lease_loss_diagnostic:null,errors:[]};
let initialGeneration=null;
const controlGeneration=async()=>{
  const state=JSON.parse(await readFile(path.join(manager.root,'control.json'),'utf8'));
  return Number.isSafeInteger(state.generation)?state.generation:null;
};
const verify=async()=>{
  await watcher.assertHealthy(lease);
  const current=await native.info();
  if(current.virtualDesktopAccessor!==true||current.currentDesktopNumber!==1)
    throw Error('OWNER_DESKTOP_CHANGED');
  try{
    const scope=await manager.assertWin32ObjectReadLease(lease);
    if(scope!==objectName)throw Error('DESKTOP_OBJECT_LEASE_CHANGED');
  }catch(e){
    if(e instanceof Error && /revoked or replaced/.test(e.message)
      &&initialGeneration!==null){
      const after=await controlGeneration().catch(()=>null);
      result.lease_loss_diagnostic=describeLeaseLoss(initialGeneration,after);
    }
    throw e;
  }
};
const readReady=async()=>{
  const deadline=Date.now()+8500;
  while(Date.now()<deadline) {
    await verify();
    if(existsSync(ready)) return JSON.parse(await readFile(ready,'utf8'));
    if(existsSync(events) && (await readFile(events,'utf8')).includes('FIXTURE_ERROR'))
      throw Error('OWNED_FIXTURE_FAILED_BEFORE_READY');
    if(hostPid) {
      const report=await backend.read(hostPid,0,0,30);
      if(/Process completed with exit code/u.test(report.text)) {
        result.launch_failure_diagnostic=classifyOwnedLaunchFailure(report.text);
        await writeFile(path.join(out,'owned-winforms-'+stamp+'.host-diagnostic.log'),
          report.text.slice(-12000),'utf8');
        throw Error('OWNED_PROCESS_HOST_EARLY_EXIT_'+
          (result.launch_failure_diagnostic.process_host_exit_code??'unknown'));
      }
    }
    await delay(100);
  }
  throw Error('OWNED_FIXTURE_READY_TIMEOUT');
};
try {
  await requireSafeNativeGuiMemory();
  const digest=createHash('sha256').update(await readFile(fixtureDll)).digest('hex');
  const executableDigest=createHash('sha256').update(await readFile(fixtureExe)).digest('hex');
  if(digest!==OWNED_WINFORMS_FIXTURE_DLL_SHA256
    ||executableDigest!=='56bcee8985a52c5115ee2be015e21f31a42b36df57f6fda0ca973789a95705d5')
    throw Error('OWNED_WINFORMS_FIXTURE_DIGEST_MISMATCH');
  result.fixture_hash_verified=true;
  const proof=await manager.assertLease(lease);
  initialGeneration=await controlGeneration();
  const info=await native.info();
  if(proof.control.desktopNumber!==2||info.virtualDesktopAccessor!==true
    ||info.currentDesktopNumber!==1)throw Error('OWNER_D1_AND_HUD_D2_REQUIRED');
  result.owner_before=1;
  objectName=await manager.assertWin32ObjectReadLease(lease);
  watch=await watcher.start(lease);result.observer_armed=true;
  await verify();
  await mkdir(out,{recursive:true});
  // This apphost is compiled only from a local, owned WinForms fixture.
  // Spawned directly onto STARTUPINFO.lpDesktop, never onto owner desktop.
  const quoted=[fixtureExe,ready,release,events,'45000']
    .map(x=>"'"+x.replaceAll("'","''")+"'").join(' ');
  const command='& '+quoted+'; exit $LASTEXITCODE';
  const reply=await backend.start(command,900,'powershell.exe','hidden','standard',
    'job',root,undefined,objectName);
  if(reply.isError)throw Error('OWNED_JOB_START_REJECTED');
  started=true;
  const match=reply.text.match(/Process started with PID (\d+)/);
  if(!match)throw Error('OWNED_PROCESS_HOST_PID_NOT_RETURNED');
  hostPid=Number(match[1]);
  const app=await readReady();expectedPid=app.pid;windowHwnd=app.hwnd;
  if(!Number.isSafeInteger(windowHwnd)||windowHwnd<=0||!Number.isSafeInteger(expectedPid)
    ||expectedPid<=0||app.dwmCloaked!==1||app.rootNoActivate!==true
    ||app.initialForeground!==app.afterForeground
    ||app.buttonClass?.startsWith('WindowsForms10.Button.')!==true)
    throw Error('OWNED_WINFORMS_CLOAK_PID_OR_NOACTIVATE_PROOF_FAILED');
  result.fixture_verified=true;
  await verify();
  // A Win32-object fixture may be uncloaked without ever becoming visible on
  // the user's input desktop; no Windows virtual desktop movement occurs.
  await writeFile(release,'UN-CLOAK-AFTER-VERIFIED-DESKTOP2');
  await delay(500);await verify();result.uncloaked=true;
  process.env.DESKTOP_MCP_PROCESS_HOST=processHost;
  process.env.DESKTOP_MCP_AGENT_DESKTOP_HOST=nativeHost;
  const ui=new WinAppComputerBackend(()=>winapp);
  const inspect=()=>ui.inspect(windowHwnd,false,150,objectName);
  const before=await inspect();
  await verify();
  result.provider_controls=before.elements.length;
  if(before.elements.length===0)throw Error('OWNED_WINFORMS_UIA_PROVIDER_EMPTY');
  const matches=before.elements.filter(e=>e.automationId==='OwnedNativePushButton'
      ||(e.name==='Test action'&&e.type==='Button'));
  result.matched_owned_button=matches.length;
  if(mode==='invoke'){
    if(matches.length!==1)throw Error('OWNED_UIA_TARGET_NOT_UNIQUE');
    const windows=await ui.listWindows(undefined,objectName);
    const actualWindows=windows.filter(w=>w.hwnd===windowHwnd
      &&w.processId===expectedPid &&w.className?.startsWith('WindowsForms10.Window.')===true);
    if(actualWindows.length!==1)
      throw Error('OWNED_WINFORMS_WINDOW_IDENTITY_CHANGED');
    await verify();
    const selector=invokeGate.claimOnce({
      ownerDesktopNumber:1,leaseActive:true,independentObserverReady:true,
      rootHwnd:windowHwnd,childRootHwnd:actualWindows[0].hwnd,
      processId:expectedPid,childProcessId:actualWindows[0].processId,
      rootClass:actualWindows[0].className,appAssemblySha256:digest,
      rootNoActivate:app.rootNoActivate===true,appInitialized:result.fixture_verified,
      currentSelectionGeneration:1,expectedSelectionGeneration:1
    },before);
    // One-shot, exact selector and exact known window. Do not retry on errors.
    result.invoke_dispatched=true;
    await ui.act(windowHwnd,{type:'invoke',selector},objectName);
    await verify();
    await delay(500);await verify();
    const appLog=await readFile(events,'utf8');
    result.app_click_callbacks=appLog.split(/\r?\n/).filter(s=>s.includes('APP_BUTTON_CLICK=')).length;
    result.unexpected_focus_events=appLog.split(/\r?\n/)
      .filter(s=>/ROOT_WM_(6|7|8|1C)\b/.test(s)).length;
    if(result.app_click_callbacks!==1||result.unexpected_focus_events!==0)
      throw Error('OWNED_APP_CALLBACK_OR_FOREGROUND_CONTRACT_FAILED');
  }
  result.pass=true;
}catch(e){
  result.errors.push(e instanceof Error?e.message:'UNKNOWN_OWNED_FIXTURE_FAILURE');
}finally {
  try {
    if(hostPid){
      const ended=await backend.terminate(hostPid);
      result.owned_job_terminated=ended.isError!==true;
    }
    await backend.close();
  }catch {result.errors.push('OWNED_JOB_CLEANUP_FAILED');}
  if(started&&!result.owned_job_terminated)result.errors.push('OWNED_JOB_EXIT_UNCONFIRMED');
  if(watch){
    try {
      const stopped=await watcher.stop();
      result.watcher_terminated=stopped.exitConfirmed===true;
      const lines=(await readFile(watch.eventLog,'utf8')).split(/\r?\n/).filter(Boolean)
        .map(x=>JSON.parse(x));
      result.observer_quiet=!existsSync(watch.tripwireFile)
        &&lines.some(x=>x.kind==='READY_AFTER_MESSAGE_PUMP')
        &&lines.every(x=>x.kind==='START'||x.kind==='READY_AFTER_MESSAGE_PUMP');
    } catch{result.errors.push('OBSERVER_CLEANUP_OR_LOG_FAILED');}
  }
  try{await manager.assertLease(lease);result.lease_held_to_cleanup=true;}
  catch{result.errors.push('LEASE_NOT_HELD_THROUGH_CLEANUP');}
  result.owner_after=(await native.info().catch(()=>({currentDesktopNumber:null}))).currentDesktopNumber;
  result.pass=result.pass&&result.observer_quiet&&result.watcher_terminated
    &&result.owned_job_terminated&&result.lease_held_to_cleanup
    &&result.owner_before===1&&result.owner_after===1&&result.errors.length===0;
  if(mode==='invoke' && result.pass) {
    try {
      const eventLines=(await readFile(events,'utf8')).split(/\r?\n/).filter(Boolean);
      const attestation=invokeGate.attestAppEffect(eventLines,result.owner_after,
        result.observer_quiet,result.owned_job_terminated,result.watcher_terminated,
        result.lease_held_to_cleanup);
      result.app_callback_attested=attestation.callback_count===1;
    }catch {
      result.pass=false;
      result.errors.push('OWNED_INVOKE_CALLBACK_OR_CLEANUP_NOT_ATTESTED');
    }
  }
  await mkdir(out,{recursive:true});
  await writeFile(path.join(out,'owned-winforms-ui-'+mode+'-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}
if(!result.pass)process.exitCode=3;
