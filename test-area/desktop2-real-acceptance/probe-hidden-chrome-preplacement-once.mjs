// One-shot READ-ONLY hidden Chrome HWND census. Never moves/shows/inputs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {AgentDesktopManager} from '../../dist/src/agent-desktop-state.js';
import {AgentDesktopNativeBridge} from '../../dist/src/agent-desktop-native.js';
import {Desktop2ObserverLifecycle} from '../../dist/src/desktop2-observer-lifecycle.js';
import {DesktopBackendBridge} from '../../dist/src/desktop-backend-bridge.js';
import {OwnedBrowserProcessController} from '../../dist/src/browser-runtime.js';
import {ProcessSessionRegistry} from '../../dist/src/process-session-registry.js';
import {resolveDeskMcpStateRoot} from '../../dist/src/data-root.js';
import {requireSafeNativeGuiMemory} from './resource-preflight.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const main=path.resolve(root,'../DeskMCP');
const sdk=path.join(main,'runtime','dotnet-sdk');
const host=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows','DeskMCP.AgentDesktopHost.exe');
const watcherExe=path.join(root,'test-area','desktop2-switch-observer','bin','Release','net10.0-windows','DeskMCP.Desktop2SwitchObserver.exe');
const vda=path.join(main,'runtime','agent-desktop-runtime','win-x64','virtual-desktop-accessor','VirtualDesktopAccessor.dll');
const chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const hiddenTarget=process.argv[2]==='PROBE_OWNED_CHROME_CDP_HIDDEN_TARGET_ONCE';
const noStartup=hiddenTarget||process.argv[2]==='PROBE_OWNED_CHROME_NO_STARTUP_WINDOW_ONCE';
if(process.platform!=='win32'||process.argv.length!==3||
 (!noStartup&&process.argv[2]!=='PROBE_OWNED_HIDDEN_CHROME_HWND_ONCE'))
 throw Error('EXPLICIT_HIDDEN_CHROME_CENSUS_SENTINEL_REQUIRED');
for(const f of [host,watcherExe,vda,chrome,path.join(sdk,'dotnet.exe')])
 if(!fs.existsSync(f))throw Error('MISSING_BINARY_'+path.basename(f));
process.env.DOTNET_ROOT=sdk;
process.env.DOTNET_ROOT_X64=sdk;
process.env.DESKTOP_MCP_VDA_PATH=vda;
process.env.DESKTOP_MCP_AGENT_DESKTOP_HOST_PATH=host;
const native=new AgentDesktopNativeBridge(()=>host);
const manager=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
const observer=new Desktop2ObserverLifecycle(manager,native,watcherExe,vda);
const base=await mkdtemp(path.join(os.tmpdir(),'deskmcp-hidden-chrome-window-census-'));
const profile=path.join(base,'profile');
const evidence=path.join(root,'test-area','desktop2-real-acceptance','runs',
 (hiddenTarget?'chrome-cdp-hidden-target-':noStartup?'chrome-no-startup-window-':'hidden-chrome-census-')+new Date().toISOString().replace(/[:.]/gu,'-'));
await mkdir(profile,{recursive:true});await mkdir(evidence,{recursive:true});
let lease,watch,bridge,controller,processSession,ownedPid;
const state={stage:hiddenTarget?'Chrome no-startup CDP hidden-target creation probe':noStartup?'Chrome --no-startup-window (read-only process and HWND census)':'pre-placement read-only Chrome HWND census',pass:false,
 before:null,after:null,probed:false,probeWindows:[],cdpHiddenTargetCreated:false,afterCdpWindows:[],chromeForegroundEvents:[],
 observerExit:false,leaseHeldThroughTeardown:false,ownedJobStopped:false,tripwire:false,
 errors:[],watcherLog:null};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const quote=s=>"'"+s.replaceAll("'","''")+"'";
function queryOwned(){
 const ps='$d='+quote(profile)+'; Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$d*" -and $_.CommandLine -notlike "*--type=*" } | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($p){[pscustomobject]@{pid=[int]$_.ProcessId;startedUtc=$p.StartTime.ToUniversalTime().ToString(\'o\')}} } | ConvertTo-Json -Compress';
 try{
  const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],
   {encoding:'utf8',timeout:8000,windowsHide:true}).trim();
  if(!raw)return [];
  const value=JSON.parse(raw);
  return (Array.isArray(value)?value:[value])
    .filter(x=>Number.isSafeInteger(x.pid)&&Date.parse(x.startedUtc)>0);
 }catch(e){console.log('OWNED_QUERY_ERROR='+String(e.message).slice(0,180));return [];}
}
function census(pid,startedUtc){
 return JSON.parse(execFileSync(host,['probe-hidden-chrome','--pid',String(pid),
  '--started-utc',startedUtc],{encoding:'utf8',timeout:8500,windowsHide:true,
    env:process.env}).trim());
}
try{
 await manager.init();
 if((await manager.status()).controls?.some(x=>x.active))throw Error('ANOTHER_ACTIVE_AGENT_DESKTOP_LEASE');
 state.before=(await native.info()).currentDesktopNumber;
 if(state.before!==1)throw Error('OWNER_D1_REQUIRED');
 await requireSafeNativeGuiMemory();
 const started=await manager.startControl('Read-only hidden Chrome HWND census',undefined,2);
 lease=started.control?.leaseId;
 if(!lease)throw Error('NO_LEASE');
 await requireSafeNativeGuiMemory();
 watch=await observer.start(lease);state.watcherLog=watch.eventLog;
 await observer.assertHealthy(lease);
 await requireSafeNativeGuiMemory();
 bridge=new DesktopBackendBridge();
 controller=new OwnedBrowserProcessController(bridge,new ProcessSessionRegistry(),manager);
 const args=[
  '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
  '--user-data-dir='+profile,'--no-first-run','--no-default-browser-check',
  '--disable-background-networking','--disable-extensions','--disable-sync',
  ...(noStartup ? ['--no-startup-window'] : ['--start-minimized','about:blank'])
 ];
 const psArgs=args.map(x=>quote('"'+x+'"')).join(',');
 const command='$a=@('+psArgs+'); $p=Start-Process -FilePath '+quote(chrome)+
  ' -ArgumentList $a -WindowStyle Hidden -PassThru; $p.WaitForExit(); exit $p.ExitCode';
 processSession=await controller.start(command,lease,'visible-desktop2');
 for(let i=0;i<32;i++){
  await observer.assertHealthy(lease);
  const pids=queryOwned();
  if(pids.length===1){ownedPid=pids[0];break;}
  if(pids.length>1)throw Error('MULTIPLE_MATCHING_PROFILE_BROWSER_ROOTS');
  await delay(280);
 }
 if(!ownedPid)throw Error('UNIQUE_PROFILE_BROWSER_PID_NOT_FOUND');
 console.log('OWNED_HIDDEN_CHROME_PID='+ownedPid.pid);
 for(let i=0;i<4;i++){
  await observer.assertHealthy(lease);
  const data=census(ownedPid.pid,ownedPid.startedUtc);
  state.probed=true;
  state.probeWindows.push({sample:i,count:data.windowCount,
   chromeTopLevels:data.windows.filter(x=>x.className.startsWith('Chrome_WidgetWin_')),
   otherWindowCount:data.windows.filter(x=>!x.className.startsWith('Chrome_WidgetWin_')).length});
  console.log('HIDDEN_CHROME_NATIVE_CENSUS_'+i+'='+JSON.stringify(state.probeWindows.at(-1)));
  if((await native.info()).currentDesktopNumber!==1)throw Error('OWNER_D1_CHANGED');
  await delay(400);
 }
 if(hiddenTarget){
  await observer.assertHealthy(lease);
  const portFile=path.join(profile,'DevToolsActivePort');
  if(!fs.existsSync(portFile))throw Error('NO_STARTUP_CHROME_NO_DEVTOOLS_PORT');
  const port=Number((await readFile(portFile,'utf8')).split(/\r?\n/u)[0]);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('CDP_PORT_INVALID');
  const {chromium}=await import('playwright-core');
  const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:9000});
  try{
   const cdp=await browser.newBrowserCDPSession();
   await cdp.send('Target.createTarget',{url:'about:blank',background:true,hidden:true});
   state.cdpHiddenTargetCreated=true;
   await delay(500);
   await observer.assertHealthy(lease);
   const after=census(ownedPid.pid,ownedPid.startedUtc);
   state.afterCdpWindows=after.windows.filter(x=>x.className.startsWith('Chrome_WidgetWin_'));
   console.log('AFTER_CDP_HIDDEN_TARGET='+JSON.stringify(state.afterCdpWindows));
  }finally{await browser.close().catch(()=>undefined);}
 }
 state.pass=true; // Census success ONLY, never zero-focus/movable.
}catch(e){
 state.errors.push(String(e.stack||e).slice(0,1100));
 console.log('HIDDEN_CHROME_CENSUS_FAILURE='+state.errors.at(-1));
}finally{
 if(controller&&processSession){
  try{await controller.terminate(processSession);state.ownedJobStopped=true;}
  catch(e){state.errors.push('OWNED_JOB_TERMINATION:'+String(e));}
 }
 if(bridge)try{await bridge.close();}catch(e){state.errors.push('BRIDGE_CLOSE:'+String(e));}
 if(watch){
  state.tripwire=fs.existsSync(watch.tripwireFile);
  try{
   const stopped=await observer.stop();
   state.observerExit=stopped.exitConfirmed===true;
   const lines=(await readFile(watch.eventLog,'utf8')).split(/\r?\n/gu).filter(Boolean);
   const events=lines.flatMap(x=>{try{return [JSON.parse(x)];}catch{return [];}});
   state.chromeForegroundEvents=events.filter(e=>e.kind==='FOREGROUND_CHANGED'&&
    (ownedPid?.pid===e.processId||
     state.probeWindows.some(s=>s.chromeTopLevels.some(w=>w.hwnd===e.hwnd))));
   state.foregroundEventCount=events.filter(e=>e.kind==='FOREGROUND_CHANGED').length;
   console.log('OWNED_CHROME_FOREGROUND_EVENTS='+JSON.stringify(state.chromeForegroundEvents));
  }catch(e){state.errors.push('OBSERVER_CLEANUP:'+String(e));}
  state.tripwire ||= fs.existsSync(watch.tripwireFile);
 }
 state.after=(await native.info().catch(()=>({currentDesktopNumber:null}))).currentDesktopNumber;
 if(lease){
  try{const last=await manager.assertLease(lease);
   state.leaseHeldThroughTeardown=last.control.active&&last.control.leaseId===lease;}
  catch(e){state.errors.push('LEASE_LOST:'+String(e));}
  try{await manager.stopControl(lease);}catch(e){state.errors.push('LEASE_STOP:'+String(e));}
 }
 await rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:150}).catch(e=>
  state.errors.push('PROFILE_REMOVE:'+String(e)));
 state.pass=state.pass&&state.probed&&state.after===1&&state.observerExit&&
  state.ownedJobStopped&&state.leaseHeldThroughTeardown&&!state.tripwire&&state.errors.length===0;
 await writeFile(path.join(evidence,'result.json'),JSON.stringify(state,null,2));
 console.log('HIDDEN_CHROME_CENSUS_FINAL='+JSON.stringify({...state,evidence}));
}
process.exitCode=state.pass?0:3;
