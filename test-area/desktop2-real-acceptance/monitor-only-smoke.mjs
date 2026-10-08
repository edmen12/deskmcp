// Passive monitor ONLY. No GUI fixture, target HWND, provider, input, browser or desktop switching.
import fs from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentDesktopNativeBridge} from '../../dist/src/agent-desktop-native.js';
import {AgentDesktopManager} from '../../dist/src/agent-desktop-state.js';
import {resolveDeskMcpStateRoot} from '../../dist/src/data-root.js';
import {Desktop2ObserverLifecycle} from '../../dist/src/desktop2-observer-lifecycle.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..'),main=path.resolve(root,'../DeskMCP');
const lease=process.argv[2];
if(process.argv.length!==4||process.argv[3]!=='MONITOR_ONLY_NO_GUI'
 || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(lease??''))throw Error('PASSIVE_MONITOR_TEST_LEASE_REQUIRED');
process.env.DOTNET_ROOT=path.join(main,'runtime','dotnet-sdk');
process.env.DOTNET_ROOT_X64=process.env.DOTNET_ROOT;
process.env.DESKTOP_MCP_VDA_PATH=path.join(main,'runtime','agent-desktop-runtime','win-x64','virtual-desktop-accessor','VirtualDesktopAccessor.dll');
const observer=path.join(root,'test-area','desktop2-switch-observer','bin','Release','net10.0-windows','DeskMCP.Desktop2SwitchObserver.exe');
const host=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows','DeskMCP.AgentDesktopHost.exe');
for(const p of [observer,host,process.env.DESKTOP_MCP_VDA_PATH])if(!fs.existsSync(p))throw Error('NATIVE_DEPENDENCY_MISSING');
const native=new AgentDesktopNativeBridge(()=>host);
const manager=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
const watcher=new Desktop2ObserverLifecycle(manager,native,observer,process.env.DESKTOP_MCP_VDA_PATH);
let session;
const result={pass:false,stage:'start',elapsedMs:undefined,before:undefined,after:undefined,
 eventsFile:undefined,error:undefined,tripwire:false};
const began=Date.now();
try {
 const pre=await native.info(),authority=await manager.assertLease(lease);
 result.before=pre.currentDesktopNumber;
 if(pre.currentDesktopNumber!==1||authority.control.desktopNumber!==2)
   throw Error('DESKTOP1_OWNER_DESKTOP2_LEASE_REQUIRED');
 session=await watcher.start(lease);
 result.elapsedMs=Date.now()-began;
 result.stage='observer_ready';
 await watcher.assertHealthy(lease);
 const ready=JSON.parse(fs.readFileSync(session.readyFile,'utf8'));
 if(ready.watchedTargetFile!==session.targetFile||ready.hasForegroundHook!==true
  ||ready.hasVirtualDesktopNotifications!==true||fs.existsSync(session.tripwireFile))
    throw Error('PASSIVE_MONITOR_READY_STATE_UNTRUSTED');
 result.eventsFile=session.eventLog;
 result.pass=true;
} catch(e) {
 result.error=e instanceof Error?e.message:String(e);
} finally {
 const closed=await watcher.stop().catch(e=>({error:String(e)}));
 if(session && fs.existsSync(session.tripwireFile))result.tripwire=true;
 const after=await native.info().catch(()=>({currentDesktopNumber:null}));
 result.after=after.currentDesktopNumber;
 result.pass=result.pass&&!result.tripwire&&result.after===1;
 result.stage='complete';
 const runs=path.join(here,'runs');
 await mkdir(runs,{recursive:true});
 await writeFile(path.join(runs,'monitor-only-'+new Date().toISOString().replace(/[:.]/gu,'-')+'.json'),
   JSON.stringify({...result,closed},null,2));
 console.log(JSON.stringify({...result,closed}));
}
if(!result.pass)process.exitCode=3;
