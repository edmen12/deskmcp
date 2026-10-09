// Candidate-only real Windows VDA/WinEvent smoke, no target GUI launch.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {requireSafePassiveObserverMemory,
  requireStablePassiveObserverMemory} from './resource-preflight.mjs';
import {AgentDesktopManager} from '../../dist/src/agent-desktop-state.js';
import {AgentDesktopNativeBridge} from '../../dist/src/agent-desktop-native.js';
import {Desktop2ObserverLifecycle} from '../../dist/src/desktop2-observer-lifecycle.js';
import {resolveDeskMcpStateRoot} from '../../dist/src/data-root.js';

const lease=process.argv[2],token=process.argv[3];
if(process.argv.length!==4||token!=='STRICT_PRELAUNCH_OBSERVER_ONLY'
  ||!/^[0-9a-f]{8}-[0-9a-f-]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(lease??''))
  throw Error('LIVE_STRICT_WATCH_EXPLICIT_AUTHORIZATION_REQUIRED');
if(process.platform!=='win32')throw Error('REAL_WINDOWS_REQUIRED');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const main=path.resolve(root,'../DeskMCP');
const helper=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows','DeskMCP.AgentDesktopHost.exe');
const observerExe=path.join(root,'test-area','desktop2-switch-observer','bin','Release','net10.0-windows','DeskMCP.Desktop2SwitchObserver.exe');
const vda=path.join(main,'runtime','agent-desktop-runtime','win-x64','virtual-desktop-accessor','VirtualDesktopAccessor.dll');
const sdk=path.join(main,'runtime','dotnet-sdk');
for(const bin of [helper,observerExe,vda,sdk])
 if(!fs.existsSync(bin)) throw Error('MISSING_TRUSTED_HELPER_OR_RUNTIME');
process.env.DOTNET_ROOT=sdk;process.env.DOTNET_ROOT_X64=sdk;
process.env.DESKTOP_MCP_VDA_PATH=vda;
const out=path.join(root,'test-area','desktop2-real-acceptance','runs',
  'strict-foreground-watch-'+new Date().toISOString().replace(/[:.]/gu,'-'));
await mkdir(out,{recursive:true});
const native=new AgentDesktopNativeBridge(()=>helper);
const manager=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
// Never call manager.init(). Production owns live lease state.
const watcher=new Desktop2ObserverLifecycle(manager,native,observerExe,vda,undefined,15000,true);
const result={pass:false,strictArmed:false,before:null,after:null,latched:false,
  eventLog:null,foregroundEvents:0,observerExitConfirmed:false,
  messagePumpReady:false,error:null,launchedExternalGui:false};
let session;
try{
 await requireStablePassiveObserverMemory();
 await requireSafePassiveObserverMemory();
 const proof=await manager.assertLease(lease);
 const info=await native.info();
 if(info.currentDesktopNumber!==1||proof.control.desktopNumber!==2
   ||proof.control.desktopId?.toLowerCase()!==proof.binding.desktopId.toLowerCase())
   throw Error('OWNER_DESKTOP1_REAL_DESKTOP2_LEASE_REQUIRED');
 result.before=1;
 session=await watcher.start(lease);
 result.eventLog=session.eventLog;
 result.strictArmed=true; // watcher.start verified strictForegroundArmed=true
 await watcher.assertHealthy(lease);
 await new Promise(resolve=>setTimeout(resolve,850));
 await watcher.assertHealthy(lease);
 if(fs.existsSync(session.tripwireFile))throw Error('STRICT_FOREGROUND_TRIPWIRE_LATCHED');
 result.pass=true;
}catch(e){result.error=e instanceof Error?e.message:String(e)}
finally{
 try{
   const closed=await watcher.stop();
   result.observerExitConfirmed=closed.exitConfirmed===true;
 }catch(e){
   result.error=result.error||('WATCHER_STOP_FAILED:'+String(e));
 }
 if(session){
   result.latched=fs.existsSync(session.tripwireFile);
   const raw=await readFile(session.eventLog,'utf8').catch(()=>{
     result.pass=false;result.error=result.error||'OBSERVER_EVENT_LOG_MISSING';
     return '';
   });
   for(const line of raw.split(/\r?\n/)){
     if(!line)continue;
     try{
       const x=JSON.parse(line);
       if(x.kind==='FOREGROUND_CHANGED')result.foregroundEvents++;
       if(x.kind==='READY_AFTER_MESSAGE_PUMP')result.messagePumpReady=true;
       if(x.latchedAbort===true)result.latched=true;
     }catch{result.pass=false;result.error='OBSERVER_LOG_CORRUPT';}
   }
 }
 result.after=(await native.info().catch(()=>({currentDesktopNumber:null}))).currentDesktopNumber;
 result.pass=result.pass&&result.observerExitConfirmed&&result.messagePumpReady
   &&!result.latched&&result.after===1&&result.foregroundEvents===0;
 await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,runDirectory:out}));
}
if(!result.pass)process.exitCode=3;
