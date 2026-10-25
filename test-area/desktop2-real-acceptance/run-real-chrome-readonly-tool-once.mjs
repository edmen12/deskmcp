// Real third-party Chrome, real Windows Win+Tab Desktop2, not private Win32 object.
// Dedicated test-only Chrome profile, monitor, exact VDA inventory and DOM readback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {AgentDesktopManager} from '../../dist/src/agent-desktop-state.js';
import {AgentDesktopNativeBridge} from '../../dist/src/agent-desktop-native.js';
import {Desktop2ObserverLifecycle} from '../../dist/src/desktop2-observer-lifecycle.js';
import {BrowserRuntime,OwnedBrowserProcessController} from '../../dist/src/browser-runtime.js';
import {DesktopBackendBridge} from '../../dist/src/desktop-backend-bridge.js';
import {ProcessSessionRegistry} from '../../dist/src/process-session-registry.js';
import {ArtifactStore} from '../../dist/src/artifact-store.js';
import {resolveDeskMcpStateRoot} from '../../dist/src/data-root.js';
import {readRealVirtualDesktop2Windows} from '../../dist/src/desktop2-real-inventory-tools.js';
import {requireSafeNativeGuiMemory} from './resource-preflight.mjs';

if(process.platform!=='win32'||process.argv.length!==3||
 process.argv[2]!=='REAL_THIRDPARTY_CHROME_D2_ONCE')
 throw Error('EXPLICIT_REAL_D2_CHROME_SENTINEL_REQUIRED');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const main=path.resolve(root,'../DeskMCP');
const sdk=path.join(main,'runtime','dotnet-sdk');
const vda=path.join(main,'runtime','agent-desktop-runtime','win-x64','virtual-desktop-accessor','VirtualDesktopAccessor.dll');
const host=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows','DeskMCP.AgentDesktopHost.exe');
const watcherExe=path.join(root,'test-area','desktop2-switch-observer','bin','Release','net10.0-windows','DeskMCP.Desktop2SwitchObserver.exe');
const chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
for(const f of [path.join(sdk,'dotnet.exe'),vda,host,watcherExe,chrome])
 if(!fs.existsSync(f))throw Error('MISSING_BINARY:'+path.basename(f));
process.env.DOTNET_ROOT=sdk;
process.env.DOTNET_ROOT_X64=sdk;
process.env.DESKTOP_MCP_VDA_PATH=vda;
process.env.DESKTOP_MCP_AGENT_DESKTOP_HOST_PATH=host;
const native=new AgentDesktopNativeBridge(()=>host);
const agent=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
const observer=new Desktop2ObserverLifecycle(agent,native,watcherExe,vda);
const temp=await mkdtemp(path.join(os.tmpdir(),'deskmcp-true-d2-chrome-'));
const evidence=path.join(root,'test-area','desktop2-real-acceptance','runs','real-thirdparty-chrome-'+new Date().toISOString().replace(/[:.]/gu,'-'));
await mkdir(evidence,{recursive:true});
const page='<html><head><title>True D2 Chrome test</title></head><body><div id="source">ACTUAL_D2_中文</div><input id="entry" oninput="document.querySelector(\'#echo\').textContent=\'FIELD:\'+this.value"/><div id="echo">FIELD:EMPTY</div><button id="send" onclick="document.querySelector(\'#result\').textContent=\'DONE:\'+document.querySelector(\'#entry\').value">Submit</button><div id="result">PENDING</div></body></html>';
const http=createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(page);});
let lease,watch,runtime,bridge,session;
const ownedChromePids=new Set(),ownedChromeHwnds=new Set();
const result={pass:false,before:null,after:null,realD2Chrome:false,appEffects:false,
 noTargetForeground:false,foregroundChangedCount:null,ownedChromeForegroundCount:null,
 observerExit:false,browserExit:false,leaseHeldThroughTeardown:false,
 tripwire:false,failures:[],watcherLog:null};
const guard=async(phase)=>{
 await observer.assertHealthy(lease);
 if((await native.info()).currentDesktopNumber!==1)throw Error('OWNER_DESKTOP_CHANGED_'+phase);
};
async function act(b,action){
 await guard('BEFORE_'+action.type);
 const snap=await runtime.snapshot(b.session_id,b.page_id,{screenshot:false});
 await runtime.act(b.session_id,b.page_id,snap.browser_observation_id,[action],{screenshot:false});
 await guard('AFTER_'+action.type);
}
try{
 if((await agent.status()).controls.some(x=>x.active))throw Error('D2_ALREADY_LEASED');
 result.before=(await native.info()).currentDesktopNumber;
 if(result.before!==1)throw Error('OWNER_NOT_ON_D1');
 await requireSafeNativeGuiMemory();
 const started=await agent.startControl('Real D2 thirdparty Chrome inventory and action',undefined,2);
 lease=started.control?.leaseId;
 if(!lease)throw Error('NO_LEASE');
 await requireSafeNativeGuiMemory();
 watch=await observer.start(lease);result.watcherLog=watch.eventLog;
 await guard('PRELAUNCH');
 await requireSafeNativeGuiMemory();
 await new Promise((resolve,reject)=>http.listen(0,'127.0.0.1',e=>e?reject(e):resolve()));
 const artifacts=new ArtifactStore(path.join(temp,'artifacts'));await artifacts.init();
 bridge=new DesktopBackendBridge();
 runtime=new BrowserRuntime(path.join(temp,'browser'),
   new OwnedBrowserProcessController(bridge,new ProcessSessionRegistry(),agent),
   artifacts,undefined,chrome,agent,30000,true,observer);
 await runtime.init();
 const b=await runtime.start({agent_desktop_lease_id:lease,headless:false,
   url:'http://127.0.0.1:'+http.address().port+'/',timeout_ms:25000});
 session=b.session_id;
 if(b.headless)throw Error('FELL_BACK_TO_HEADLESS');
 await guard('POSTLAUNCH');
 const first=await readRealVirtualDesktop2Windows(agent,native,lease);
 if(first.source!=='windows-virtual-desktop-2-vda'||first.is_private_win32_desktop_object||
  first.actionable||!first.windows.some(x=>x.app.toLowerCase().includes('chrome')))
  throw Error('NO_ACTUAL_VIRTUAL_D2_CHROME');
 const proof=await agent.assertLease(lease);
 const actual=await native.listVirtualWindows(proof.binding.desktopId);
 const roots=actual.windows.filter(x=>x.processName.toLowerCase().includes('chrome')&&
   x.desktopNumber===2&&x.onCurrentDesktop===false);
 if(roots.length<1)throw Error('REAL_VDA_CHROME_NATIVE_IDENTITY_MISSING');
 for(const x of roots){ownedChromePids.add(x.processId);ownedChromeHwnds.add(x.hwnd);}
 result.realD2Chrome=true;
 console.log('TRUE_D2_WINDOW_INVENTORY='+JSON.stringify(first));
 console.log('OWNED_CHROME_NATIVE_WINDOW_IDENTITIES='+roots.length);
 // A monitor with no exact target arm cannot latch Chrome-focused incidents.
 // Inspect its independent foreground PID/HWND events BEFORE first CDP action.
 const early=await readFile(watch.eventLog,'utf8');
 const earlyFocus=early.split(/\r?\n/gu).filter(Boolean).flatMap(line=>{
  try { const e=JSON.parse(line);return e.kind==='FOREGROUND_CHANGED'&&
   (ownedChromePids.has(e.processId)||ownedChromeHwnds.has(e.hwnd))?[e]:[]; }
  catch{return [];}
 });
 if(earlyFocus.length)throw Error('OWNED_CHROME_STARTUP_STOLE_DESKTOP1_FOREGROUND');
 await act(b,{type:'virtual_copy',selector:'#source'});
 await act(b,{type:'virtual_paste',selector:'#entry'});
 const echoed=await runtime.snapshot(b.session_id,b.page_id,{screenshot:false});
 if(!echoed.text.includes('FIELD:ACTUAL_D2_中文'))throw Error('INPUT_EVENT_NOT_REACHED');
 await act(b,{type:'click',selector:'#send'});
 const final=await runtime.snapshot(b.session_id,b.page_id,{screenshot:false});
 if(!final.text.includes('DONE:ACTUAL_D2_中文'))throw Error('CHROME_APP_CLICK_FAILED');
 result.appEffects=true;
 await guard('POST_EFFECT');
 const after=await readRealVirtualDesktop2Windows(agent,native,lease);
 if(!after.windows.some(x=>x.app.toLowerCase().includes('chrome')))throw Error('CHROME_LEFT_REAL_D2');
 console.log('TRUE_D2_THIRDPARTY_APP_STATE_PASS=true');
 await runtime.close(b.session_id);session=undefined;result.browserExit=true;
 await guard('AFTER_CLOSE');
}catch(e){
 result.failures.push(String(e?.stack??e).slice(0,1600));
 console.log('TRUE_D2_TEST_ERROR='+result.failures.at(-1));
}finally{
 if(runtime){
  try{await runtime.closeAll();result.browserExit=!session;}
  catch(e){result.failures.push('CLOSE_ALL:'+String(e));}
 }
 if(bridge)try{await bridge.close();}catch(e){result.failures.push('BRIDGE:'+String(e));}
 if(http.listening)await new Promise(resolve=>http.close(resolve));
 if(watch){
  result.tripwire=fs.existsSync(watch.tripwireFile);
  try{
   const stopped=await observer.stop();
   result.observerExit=stopped.exitConfirmed===true;
   const text=await readFile(watch.eventLog,'utf8');
   const events=text.split(/\r?\n/gu).filter(Boolean).flatMap(line=>{
    try{return [JSON.parse(line)];}catch{return [];}
   });
   const foreground=events.filter(e=>e.kind==='FOREGROUND_CHANGED');
   const target=foreground.filter(e=>ownedChromePids.has(e.processId)||ownedChromeHwnds.has(e.hwnd));
   result.foregroundChangedCount=foreground.length;
   result.ownedChromeForegroundCount=target.length;
   // Normal target watcher is passive before target arming, so the absence
   // of TARGET_FOREGROUND_EARLY_ABORT ALONE is not a no-focus proof.
   result.noTargetForeground=ownedChromePids.size>0&&target.length===0&&
     !events.some(e=>e.kind==='TARGET_FOREGROUND_EARLY_ABORT');
   console.log('FOREGROUND_EVENT_ATTRIBUTION='+JSON.stringify({all:foreground.length,
     ownedChromeTargets:target.length,otherOrUnknown:foreground.length-target.length}));
  }catch(e){result.failures.push('WATCHER:'+String(e));}
  result.tripwire ||= fs.existsSync(watch.tripwireFile);
 }
 result.after=(await native.info().catch(()=>({currentDesktopNumber:null}))).currentDesktopNumber;
 if(lease){
  try{const s=await agent.assertLease(lease);
    result.leaseHeldThroughTeardown=s.control.active&&s.control.leaseId===lease;}
  catch(e){result.failures.push('LEASE_LOST:'+String(e));}
  try{await agent.stopControl(lease);}catch(e){result.failures.push('LEASE_STOP:'+String(e));}
 }
 await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
 result.pass=Boolean(result.before===1&&result.after===1&&result.realD2Chrome&&
   result.appEffects&&result.browserExit&&result.observerExit&&result.leaseHeldThroughTeardown&&
   result.noTargetForeground&&!result.tripwire&&result.failures.length===0);
 await writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));
 console.log('TRUE_D2_FINAL='+JSON.stringify({...result,evidence}));
}
process.exitCode=result.pass?0:3;
