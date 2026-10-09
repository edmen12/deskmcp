// Live native WinEvent/VDA process-lifecycle test. It does NOT validate the
// DeskMCP Desktop2 lease or general third-party Computer Use authorization.
// Never create a GUI app, start a HUD, move windows, or send OS input.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {requireSafePassiveObserverMemory,
  requireStablePassiveObserverMemory} from './resource-preflight.mjs';
import {terminateOwnedChild} from './owned-process-cleanup.mjs';
import {AgentDesktopNativeBridge} from '../../dist/src/agent-desktop-native.js';

if(process.platform!=='win32')throw Error('REAL_WINDOWS_ONLY');
if(process.argv.length!==3||process.argv[2]!=='NATIVE_OBSERVER_EXIT_NO_HUD')
  throw Error('NATIVE_LIVE_NO_HUD_EXPLICIT_TOKEN_REQUIRED');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const runtime=path.resolve(root,'../DeskMCP');
const host=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows',
  'DeskMCP.AgentDesktopHost.exe');
const monitor=path.join(root,'test-area','desktop2-switch-observer','bin','Release',
  'net10.0-windows','DeskMCP.Desktop2SwitchObserver.exe');
const dll=path.join(runtime,'runtime','agent-desktop-runtime','win-x64',
  'virtual-desktop-accessor','VirtualDesktopAccessor.dll');
const sdk=path.join(runtime,'runtime','dotnet-sdk');
for(const item of [host,monitor,dll,sdk])if(!fs.existsSync(item))
  throw Error('NATIVE_WATCHER_BINARY_OR_RUNTIME_MISSING');
// NativeBridge inherits process.env when starting its independent helper.
// Configure only this one-shot test process, never the user's system env.
process.env.DOTNET_ROOT=sdk;
process.env.DOTNET_ROOT_X64=sdk;
process.env.DESKTOP_MCP_VDA_PATH=dll;
const env={...process.env};
const native=new AgentDesktopNativeBridge(()=>host);
const run=path.join(root,'test-area','desktop2-real-acceptance','runs',
  'native-observer-no-hud-'+new Date().toISOString().replace(/[:.]/gu,'-'));
await mkdir(run,{recursive:true});
const events=path.join(run,'watcher.jsonl');
const ready=path.join(run,'watcher.ready.json');
const tripwire=path.join(run,'watcher.alarm.json');
const target=path.join(run,'never-create-target.json');
const result={pass:false,mode:'native-strict-no-HUD',before:null,after:null,
  messagePumpReady:false,foregroundEvents:0,showEvents:0,alarm:false,
  ownedNativePid:null,exitConfirmed:false,started:false,error:null,
  thirdPartyGuiLaunched:false,desktop2LeaseUsed:false};
let child;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  await requireStablePassiveObserverMemory();
  await requireSafePassiveObserverMemory();
  const baseline=await native.info();
  if(baseline.currentDesktopNumber!==1||baseline.virtualDesktopAccessor!==true)
    throw Error('OWNER_DESKTOP1_OR_VDA_UNAVAILABLE');
  result.before=1;
  await requireSafePassiveObserverMemory();
  child=spawn(monitor,['--observe-strict-launch',dll,events,ready,tripwire,target],
    {shell:false,windowsHide:true,stdio:'ignore',env});
  child.on('error',()=>{});
  result.started=true;
  if(!Number.isSafeInteger(child.pid)||child.pid<=0)
    throw Error('NATIVE_OBSERVER_PID_MISSING');
  result.ownedNativePid=child.pid;
  let proof;
  const until=Date.now()+3200;
  while(Date.now()<until){
    if(child.exitCode!==null||child.signalCode!==null)
      throw Error('NATIVE_OBSERVER_DIED_BEFORE_READY');
    if(fs.existsSync(tripwire))throw Error('NATIVE_OBSERVER_ALARM_BEFORE_READY');
    if(fs.existsSync(ready)){
      proof=JSON.parse(await readFile(ready,'utf8'));break;
    }
    await sleep(50);
  }
  if(!proof||proof.processId!==child.pid
    ||proof.messagePumpRunning!==true
    ||proof.strictForegroundArmed!==true||proof.strictWindowShowArmed!==true
    ||proof.expectedDesktopIndex!==0)
    throw Error('NATIVE_OBSERVER_READY_UNVERIFIED');
  await sleep(500);
  if(child.exitCode!==null||child.signalCode!==null
    ||fs.existsSync(tripwire)||(await native.info()).currentDesktopNumber!==1)
    throw Error('NATIVE_OBSERVER_UNHEALTHY');
}catch(e){result.error=e instanceof Error?e.message:String(e)}
finally{
  try{result.exitConfirmed=await terminateOwnedChild(child,{deadlineMs:2200});}
  catch(e){result.error=result.error||('OWNED_OBSERVER_EXIT_FAILED:'+String(e));}
  if(!result.exitConfirmed)result.error=result.error||'OWNED_NATIVE_OBSERVER_EXIT_UNCONFIRMED';
  result.alarm=fs.existsSync(tripwire);
  if(result.started){
    const raw=await readFile(events,'utf8').catch(()=>{
      result.error=result.error||'NATIVE_EVENT_LOG_UNAVAILABLE';return '';
    });
    for(const line of raw.split(/\r?\n/).filter(Boolean)){
      try{
        const e=JSON.parse(line);
        if(e.kind==='READY_AFTER_MESSAGE_PUMP')result.messagePumpReady=true;
        if(e.kind==='FOREGROUND_CHANGED')result.foregroundEvents++;
        if(e.kind==='PRELAUNCH_VISIBLE_ROOT')result.showEvents++;
        if(e.latchedAbort===true)result.alarm=true;
      }catch{result.error=result.error||'NATIVE_EVENT_LOG_CORRUPT';}
    }
  }
  result.after=(await native.info().catch(()=>({currentDesktopNumber:null}))).currentDesktopNumber;
  result.pass=result.error===null&&result.before===1&&result.after===1
    &&result.started&&result.exitConfirmed&&result.messagePumpReady
    &&result.foregroundEvents===0&&result.showEvents===0&&!result.alarm;
  await writeFile(path.join(run,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,evidenceDir:run}));
}
if(!result.pass)process.exitCode=3;
