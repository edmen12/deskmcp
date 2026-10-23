// Candidate-only, one-shot WINDOWS THIRD-PARTY READ-ONLY test.
// Launch only Microsoft Windows System32 Winver through the process-host's
// CREATE_SUSPENDED + lpDesktop Win32 desktop object. Does not launch on the
// owner's current Win32 desktop, switch Windows virtual desktops, or send input.
// Real Desktop2 lease & strict independent foreground watcher required.
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentDesktopManager } from '../../dist/src/agent-desktop-state.js';
import { AgentDesktopNativeBridge } from '../../dist/src/agent-desktop-native.js';
import { NativeWindowsProcessBackend } from '../../dist/src/native-process-backend.js';
import { WinAppComputerBackend } from '../../dist/src/computer-use-backend.js';
import { resolveDeskMcpStateRoot } from '../../dist/src/data-root.js';

const invoke=promisify(execFile);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const adjacent=path.join(path.dirname(root),'DeskMCP-D2-Native-Acceptance');
const stateDir=path.join(root,'test-area','isolated-thirdparty-prelaunch','runs');
const host=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows','DeskMCP.AgentDesktopHost.exe');
const launcher=path.join(root,'process-host','bin','Release','net10.0-windows','win-x64','DeskMCP.ProcessHost.exe');
const observerExe=path.join(adjacent,'test-area','desktop2-switch-observer','bin','Release','net10.0-windows','DeskMCP.Desktop2SwitchObserver.exe');
const watcherLib=path.join(adjacent,'dist','src','desktop2-observer-lifecycle.js');
const preflightLib=path.join(adjacent,'test-area','desktop2-real-acceptance','resource-preflight.mjs');
const winver=path.join(process.env.SystemRoot||'C:\\Windows','System32','winver.exe');
const winapp=path.join(process.env.LOCALAPPDATA||'C:\\Users\\User\\AppData\\Local','Programs','DesktopMCP','gateway','winapp','winapp.exe');
const vda=process.env.DESKTOP_MCP_VDA_PATH?.trim();
const [lease,token]=process.argv.slice(2);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
if(process.platform!=='win32'||process.argv.length!==4
  ||token!=='OWNED_SYSTEM_WINVER_WIN32_OBJECT_READONLY_ONCE'
  ||!/^[a-f0-9]{8}-[a-f0-9-]{4}-[a-f0-9-]{4}-[a-f0-9-]{4}-[a-f0-9]{12}$/iu.test(lease??'')
  ||!vda||!path.isAbsolute(vda)||path.basename(vda).toLowerCase()!=='virtualdesktopaccessor.dll'
  ||![host,launcher,observerExe,watcherLib,preflightLib,winver,vda,winapp].every(existsSync))
  throw Error('EXACT_LEASE_SENTINEL_AND_PREBUILT_TRUSTED_BINARIES_REQUIRED');

const {Desktop2ObserverLifecycle}=await import(pathToFileURL(watcherLib).href);
const {requireSafeNativeGuiMemory}=await import(pathToFileURL(preflightLib).href);
const native=new AgentDesktopNativeBridge(()=>host);
const manager=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
const observer=new Desktop2ObserverLifecycle(manager,native,observerExe,vda,undefined,15000,true);
const backend=new NativeWindowsProcessBackend(launcher);
let watching, hostPid, launched=false, visibleSystemWinver=false,winverHwnd;
const result={
  stage:'WIN32_ISOLATED_DESKTOP_OBJECT_PRELAUNCH_WINVER',
  pass:false, owner_desktop_before:null, owner_desktop_after:null,
  hud_lease_verified:false, strict_observer_ready:false,
  preassigned_desktop_object:true,
  owned_system_winver_window_found:false,
  system_app_window_count:0,
  isolated_ui_inspection_status:'not_attempted', isolated_ui_elements:0,
  app_business_effect_verified:false,
  windows_virtual_desktop2_visibility_verified:false,
  observer_quiet:false, owned_job_terminated:false,
  watcher_terminated:false, lease_held_through_teardown:false,
  production_action_authorized:false, errors:[]
};
const verify=async()=>{
  await observer.assertHealthy(lease);
  const current=await native.info();
  if(!current.virtualDesktopAccessor||current.currentDesktopNumber!==1)
    throw Error('OWNER_VIRTUAL_DESKTOP_CHANGED');
  await manager.assertLease(lease);
};
try {
  await requireSafeNativeGuiMemory();
  const before=await manager.assertLease(lease);
  const info=await native.info();
  if(before.control.desktopNumber!==2 || info.currentDesktopNumber!==1
    ||info.virtualDesktopAccessor!==true)throw Error('OWNER_OR_AGENT_DESKTOP_LEASE_NOT_READY');
  result.owner_desktop_before=1;result.hud_lease_verified=true;
  const desktopObject=await manager.desktopObjectNameForLease(lease);
  watching=await observer.start(lease);
  result.strict_observer_ready=true;
  await verify();
  // The process-host sets STARTUPINFO.lpDesktop BEFORE CreateProcessW and
  // resumes child only AFTER assigning it to KILL_ON_JOB_CLOSE Job Object.
  const started=await backend.start('"'+winver+'"',900,'cmd.exe','hidden',
    'standard','job',root,undefined,desktopObject);
  if(started.isError)throw Error('CANDIDATE_ISOLATED_PROCESS_HOST_START_DENIED');
  launched=true;
  const match=started.text.match(/Process started with PID (\d+)/);
  if(!match)throw Error('ISOLATED_PROCESS_HOST_PID_UNAVAILABLE');
  hostPid=Number(match[1]);
  for(let attempt=0;attempt<16;attempt++){
    await verify();
    const {stdout}=await invoke(host,['object-windows','--desktop-object',desktopObject],{
      windowsHide:true,timeout:2000,maxBuffer:16000,env:process.env
    });
    const rows=JSON.parse(stdout);
    if(!Array.isArray(rows)||rows.length>30)throw Error('ISOLATED_DESKTOP_ENUMERATION_INVALID');
    const winvers=rows.filter(row=>
      String(row.processName).toLowerCase()==='winver'
      &&String(row.className)==='#32770'
      &&row.isForeground===false);
    if(winvers.length>0) {
      visibleSystemWinver=true;
      result.owned_system_winver_window_found=true;
      result.system_app_window_count=winvers.length;
      winverHwnd=winvers[0].hwnd;
      break;
    }
    await delay(250);
  }
  await verify();
  if(!visibleSystemWinver)throw Error('ISOLATED_WINVER_UI_NOT_OBSERVED');
  // These are two fundamentally different desktop namespaces.
  const leaseDetails=await manager.assertLease(lease);
  const virtualD2=await native.listVirtualWindows(leaseDetails.binding.desktopId);
  result.windows_virtual_desktop2_visibility_verified=virtualD2.windows.some(
    w=>w.hwnd===winverHwnd);
  // Read-only UIA provider probe via child WinApp launched into the SAME
  // Win32 object. Never use generic D2 GUID scoping for this HWND.
  process.env.DESKTOP_MCP_PROCESS_HOST=launcher;
  process.env.DESKTOP_MCP_AGENT_DESKTOP_HOST=host;
  const uiBackend=new WinAppComputerBackend(()=>winapp);
  try {
    const inspection=await uiBackend.inspect(winverHwnd,false,100,desktopObject);
    result.isolated_ui_elements=inspection.elements.length;
    result.isolated_ui_inspection_status=inspection.elements.length>0?'elements_visible':'provider_empty';
  }catch {
    result.isolated_ui_inspection_status='provider_error_or_timeout';
  }
  await verify();
  result.pass=true;
}catch(e){
  result.errors.push(e instanceof Error ? e.message : 'UNKNOWN_TEST_FAILURE');
}finally {
  try {
    if(hostPid){
      const stop=await backend.terminate(hostPid);
      result.owned_job_terminated=stop.isError!==true;
    }
    await backend.close();
  } catch {
    result.errors.push('OWNED_PROCESS_JOB_CLEANUP_FAILED');
  }
  if(launched && !result.owned_job_terminated)result.errors.push('OWNED_JOB_TERMINATION_NOT_CONFIRMED');
  if(watching) {
    try {
      const stopped=await observer.stop();
      result.watcher_terminated=stopped.exitConfirmed===true;
      const events=(await readFile(watching.eventLog,'utf8')).split(/\r?\n/)
        .filter(Boolean).map(line=>JSON.parse(line));
      result.observer_quiet=!existsSync(watching.tripwireFile) &&
        events.some(row=>row.kind==='READY_AFTER_MESSAGE_PUMP') &&
        events.every(row=>row.kind==='START'||row.kind==='READY_AFTER_MESSAGE_PUMP');
    }catch{result.errors.push('OBSERVER_STOP_OR_EVIDENCE_FAILED');}
  }
  try{
    await manager.assertLease(lease);
    result.lease_held_through_teardown=true;
  }catch {result.errors.push('LEASE_REVOKED_BEFORE_CLEANUP');}
  const info=await native.info().catch(()=>({currentDesktopNumber:null}));
  result.owner_desktop_after=info.currentDesktopNumber;
  result.pass=result.pass && result.owned_job_terminated &&
    result.watcher_terminated && result.observer_quiet &&
    result.lease_held_through_teardown && result.owner_desktop_after===1
    &&result.errors.length===0;
  await mkdir(stateDir,{recursive:true});
  const safeFile=path.join(stateDir,'winver-isolated-object-result.json');
  await writeFile(safeFile,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}
if(!result.pass)process.exitCode=3;
