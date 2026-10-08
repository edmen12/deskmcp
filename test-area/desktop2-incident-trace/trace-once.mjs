// USER-REQUESTED ONE-SHOT DIAGNOSTIC 2026-10-09.
// Reproduce old WPF/WinApp sequence one step at a time; STOP on FIRST switch.
// No GUI beyond the owned WPF fixture, no host SendInput or auto-switch back.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// HARD STOP AFTER REPRODUCTION: original, unprotected WPF caused a verified
// Desktop1->Desktop2 switch during WinApp ui set-value (2026-10-09 MYT).
// Never silently run this GUI trace a second time. A new explicit owner
// instruction and a reviewed, separately scoped test are required.
throw new Error('GUI_DIAGNOSTIC_QUARANTINED_AFTER_CONFIRMED_DESKTOP_SWITCH');

const dir=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(dir,'..','..');
const sdk='C:\\Users\\User\\Desktop\\DeskMCP\\runtime\\dotnet-sdk';
const vda='C:\\Users\\User\\Desktop\\DeskMCP\\runtime\\agent-desktop-runtime\\win-x64\\virtual-desktop-accessor\\VirtualDesktopAccessor.dll';
const winapp='C:\\Users\\User\\AppData\\Local\\Programs\\DesktopMCP\\gateway\\winapp\\winapp.exe';
const observer=path.join(root,'test-area','desktop2-switch-observer','bin','Release','net10.0-windows','DeskMCP.Desktop2SwitchObserver.dll');
const host=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows','DeskMCP.AgentDesktopHost.dll');
const fixtureVariant=process.env.DESKMCP_TRACE_LEGACY_WPF==='1'?'UNPROTECTED_ORIGINAL':'PROTECTED_CANDIDATE';
const wpf=fixtureVariant==='UNPROTECTED_ORIGINAL'
  ? path.join(dir,'legacy-wpf','bin','Release','net10.0-windows','DeskMCP.Desktop2WpfLegacy.dll')
  : path.join(root,'test-area','desktop2-wpf-probe','bin','Release','net10.0-windows','DeskMCP.Desktop2WpfProbe.dll');
const dotnet=path.join(sdk,'dotnet.exe');
const tag=(fixtureVariant==='UNPROTECTED_ORIGINAL'?'legacy-':'protected-')+'incident-'+new Date().toISOString().replaceAll(':','-').replaceAll('.','-')+'-'+crypto.randomBytes(3).toString('hex');
const events=path.join(dir,tag+'-desktop-events.jsonl');
const timeline=path.join(dir,tag+'-action-timeline.jsonl');
const ownerReady=path.join(dir,tag+'-observer.ready.json');
const tripwire=path.join(dir,tag+'-observer.tripwire.json');
const wpfReady=path.join(dir,tag+'-wpf.ready.json');
const wpfRelease=path.join(dir,tag+'-wpf.release.flag');
const wpfEvents=path.join(dir,tag+'-wpf.events.log');
const resultFile=path.join(dir,tag+'-result.json');
const env={...process.env,DOTNET_ROOT:sdk,DOTNET_ROOT_X64:sdk,DESKTOP_MCP_VDA_PATH:vda,
  DOTNET_CLI_TELEMETRY_OPTOUT:'1',NO_COLOR:'1',WINAPP_CLI_TELEMETRY_OPTOUT:'1'};
let observerProc=null, probeProc=null, activeTool=null, timer=null;
let switched=false, ended=false, currentStep='PRESTART', lastOk='NONE', runError='';
let pid=0, hwnd='', desktopId='';
let startNs=process.hrtime.bigint();
const log=(kind,extra={})=>{
  const obj={utc:new Date().toISOString(),elapsedMs:Number((process.hrtime.bigint()-startNs)/1000000n),
    kind,step:currentStep,...extra};
  fs.appendFileSync(timeline,JSON.stringify(obj)+'\n');
  if(kind==='START'||kind==='SUCCESS'||kind==='ABORT'||kind==='SWITCH_TRIPWIRE') console.log(JSON.stringify(obj));
};
const abort=(reason)=>{
  if(ended) return;
  switched=fs.existsSync(tripwire) || switched;
  runError=reason;
  log('ABORT',{reason});
  // Kill the currently running operation immediately, never auto-return.
  if(activeTool && !activeTool.killed)try{activeTool.kill()}catch{}
  throw Error(reason);
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ensure=async()=>{
  if(fs.existsSync(tripwire))abort('VIRTUAL_DESKTOP_SWITCH_DETECTED');
  if(observerProc?.exitCode!==null || !fs.existsSync(ownerReady))abort('PASSIVE_OBSERVER_UNAVAILABLE');
  const ready=JSON.parse(fs.readFileSync(ownerReady,'utf8'));
  if(ready.processId!==observerProc.pid || ready.expectedDesktopIndex!==0 || !ready.hasVirtualDesktopNotifications || !ready.hasForegroundHook)
    abort('OBSERVER_IDENTITY_OR_READINESS_FAILED');
  const count=fs.existsSync(events)?fs.readFileSync(events,'utf8').split('\n').filter(Boolean):[];
  // Track fixture process becoming foreground even if desktop number does not change.
  if(probeProc?.pid && count.some(line=>{
    try{const e=JSON.parse(line);return e.kind==='FOREGROUND_CHANGED' && e.processId===probeProc.pid;}catch{return false;}
  }))abort('WPF_FIXTURE_STOLE_OWNER_FOREGROUND');
  if(fs.existsSync(tripwire))abort('VIRTUAL_DESKTOP_SWITCH_DETECTED');
};
const run=async(label,exe,args,limitMs=8500,{check=true}={})=>{
  currentStep=label;
  if(check)await ensure();
  log('START',{tool:exe===winapp?'winapp.exe':exe===dotnet?'dotnet/native':'other',command:args[0],
    // no actual input values / user text
    category:label.split(':')[0]});
  return await new Promise((resolve,reject)=>{
    let out='',err='',done=false;
    const child=spawn(exe,args,{cwd:root,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    activeTool=child;
    const clock=setTimeout(()=>finish(Error('TOOL_TIMEOUT_'+label)),limitMs);
    const finish=(error)=>{
      if(done)return;done=true;clearTimeout(clock);
      if(error)try{child.kill()}catch{}
      activeTool=null;
      if(error)reject(error);
      else {
        log('SUCCESS',{exitCode:0,tool:label});
        lastOk=label;
        resolve(out.trim());
      }
    };
    child.stdout.on('data',b=>{out+=b.toString('utf8');if(out.length>75000)finish(Error('OUTPUT_BOUND_EXCEEDED'))});
    child.stderr.on('data',b=>{err+=b.toString('utf8');if(err.length>75000)finish(Error('STDERR_BOUND_EXCEEDED'))});
    child.on('error',finish);
    child.on('close',(exitCode)=>finish(exitCode===0?null:Error(label+' exit='+exitCode+' stderr='+err.slice(0,350))));
  }).then(async data=>{
     if(check){await sleep(230);await ensure();}
     return data;
  });
};
const native=(label,args)=>run('NATIVE:'+label,dotnet,[host,...args],8500);
const ui=(label,args)=>run('WINAPP:'+label,winapp,['ui',...args],9000);
async function waitFor(file,ms,proc){
 const start=Date.now();
 while(Date.now()-start<ms){
   await ensure();
   if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file,'utf8'));
   if(proc.exitCode!==null)abort('OWNED_WPF_APP_EXITED_BEFORE_READY');
   await sleep(40);
 }
 abort('WPF_READY_TIMEOUT');
}
async function checkWpfEvents(expect,label){
 currentStep='APP_READBACK:'+label;await ensure();
 const data=fs.existsSync(wpfEvents)?fs.readFileSync(wpfEvents,'utf8'):'';
 log('APP_READBACK',{name:label,confirmed:data.includes(expect)});
 if(!data.includes(expect))abort('WPF_APP_EVENT_MISSING_'+label);
}
async function main(){
 for(const f of [dotnet,vda,observer,host,wpf,winapp]) if(!fs.existsSync(f))throw Error('DEPENDENCY_MISSING '+f);
 // Guard against stale / inherited incident traces; never delete prior runs.
 currentStep='CHECK_INITIAL_OWNER';
 const baseline=JSON.parse(await run('BASELINE_NATIVE_CURRENT_DESKTOP',dotnet,[host,'current-desktop'],7000,{check:false}));
 if(baseline.desktopNumber!==1 || baseline.desktopCount<2)throw Error('OWNER_NOT_ON_DESKTOP1_BASELINE');
 currentStep='START_PASSIVE_MONITOR';
 observerProc=spawn(dotnet,[observer,'--observe',vda,events,ownerReady,tripwire],{
  cwd:root,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
 observerProc.on('error',e=>{runError='OBSERVER_PROCESS_ERROR '+e.message;});
 for(let i=0;i<160 && !fs.existsSync(ownerReady);i++){
   if(observerProc.exitCode!==null)throw Error('OBSERVER_COULD_NOT_START');
   await sleep(40);
 }
 if(!fs.existsSync(ownerReady))throw Error('OBSERVER_READY_TIMEOUT');
 await ensure();
 log('MONITOR_READY',{pid:observerProc.pid});
 timer=setInterval(()=>{
   // monitor runs on a separate process while child actions execute.
   if(fs.existsSync(tripwire) && !switched){
     switched=true;log('SWITCH_TRIPWIRE',{activeStep:currentStep});
     if(activeTool && !activeTool.killed)try{activeTool.kill()}catch{}
   }
 },25);
 // All subsequent operations are gated; a first switch permanently halts the test.
 const d=JSON.parse(await native('desktop-info',['desktop-info','--desktop-number','2']));
 if(d.currentDesktopNumber!==1||!d.desktopId)abort('CANNOT_RESOLVE_DESKTOP2');
 desktopId=d.desktopId;
 currentStep='WPF_PROCESS_CREATE_CLOAKED';
 await ensure(); log('START',{tool:'owned-WPF-fixture'});
 probeProc=spawn(dotnet,[wpf,wpfReady,wpfRelease,wpfEvents,'65000'],{
   cwd:root,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
 const ready=await waitFor(wpfReady,13000,probeProc);
 pid=ready.pid;hwnd=String(ready.hwnd);
 log('SUCCESS',{tool:'owned-WPF-fixture',pid,hwnd,dwmCloaked:ready.dwmCloaked,
   foregroundUnchanged:ready.initialForeground===ready.afterForeground});
 if(ready.dwmCloaked!==1||ready.afterForeground===ready.hwnd||ready.initialForeground!==ready.afterForeground)
    abort('WPF_LAUNCH_STOLE_FOREGROUND_OR_CLOAK_FAILED');
 await ensure();
 let info=JSON.parse(await native('window-info-before',['window-info','--hwnd',hwnd]));
 if(info.desktopNumber!==1)abort('PRE_MOVE_TARGET_NOT_ON_DESKTOP1');
 await native('move-window',['move-window','--hwnd',hwnd,'--desktop-id',desktopId]);
 info=JSON.parse(await native('window-info-after',['window-info','--hwnd',hwnd]));
 if(info.desktopNumber!==2 || info.onCurrentDesktop!==false)abort('MOVE_FAILED_TO_ISOLATE');
 currentStep='WPF_UNCLOAK_WHILE_ON_DESKTOP2';
 await ensure();log('START',{tool:'owned-WPF-fixture',command:'uncloak'});
 fs.writeFileSync(wpfRelease,'UN-CLOAK-AFTER-VERIFIED-DESKTOP2');
 await sleep(470);await ensure();
 log('SUCCESS',{tool:'owned-WPF-fixture',command:'uncloak'});
 await checkWpfEvents('UNCLOAK_SUCCESS','UNCLOAK_SUCCESS');
 // This exact WinApp CLI sequence reproduces the former probe; each call is separate.
 await ui('inspect',['inspect','-w',hwnd,'--json','-i','-d','8']);
 await ui('set-value',['set-value','WpfEdit','WPF_D2_SAFE_TEXT','-w',hwnd,'--json']);
 await checkWpfEvents('APP_EDIT=WPF_D2_SAFE_TEXT','TEXT_SET');
 await ui('get-value',['get-value','WpfEdit','-w',hwnd,'--json']);
 await ui('invoke-button',['invoke','WpfButton','-w',hwnd,'--json']);
 await checkWpfEvents('APP_CLICK=1','BUTTON_CLICK');
 await ui('invoke-scroll-button',['invoke','WpfScrollButton','-w',hwnd,'--json']);
 await checkWpfEvents('APP_SCROLLED=','SCROLL_BUTTON');
 await ui('scroll-top',['scroll','WpfScroller','--to','top','-w',hwnd,'--json']);
 await ui('scroll-bottom',['scroll','WpfScroller','--to','bottom','-w',hwnd,'--json']);
 // Previously tested raw Win32 WM-message operations.
 await native('background-text',['background-input','--hwnd',hwnd,'--pid',String(pid),'--desktop-id',desktopId,'--action','text','--text','MCPCHARS']);
 await native('background-wheel',['background-input','--hwnd',hwnd,'--pid',String(pid),'--desktop-id',desktopId,'--action','wheel','--x','290','--y','255','--delta','-120']);
 await native('background-double-click',['background-input','--hwnd',hwnd,'--pid',String(pid),'--desktop-id',desktopId,'--action','double-click','--x','290','--y','225']);
 await native('background-drag',['background-input','--hwnd',hwnd,'--pid',String(pid),'--desktop-id',desktopId,'--action','drag','--x','290','--y','230','--to-x','330','--to-y','260','--steps','6']);
 await ui('invoke-popup',['invoke','WpfPopup','-w',hwnd,'--json']);
 await sleep(250);await ensure();
 lastOk='ALL_UI_ACTIONS';
}
try{
 await main();
}catch(e){
 runError=String(e?.message||e);
 log('TEST_STOPPED',{reason:runError,switched});
}finally{
 ended=true;
 if(timer)clearInterval(timer);
 if(activeTool && !activeTool.killed)try{activeTool.kill()}catch{}
 if(probeProc && !probeProc.killed)try{probeProc.kill()}catch{}
 // 250 ms for the passive observer to write its final events.
 await sleep(250);
 if(observerProc && !observerProc.killed)try{observerProc.kill()}catch{}
 await sleep(180);
 const logged=fs.existsSync(events)?fs.readFileSync(events,'utf8').trim().split(/\r?\n/).filter(Boolean):[];
 const parsed=logged.map(s=>{try{return JSON.parse(s)}catch{return null}}).filter(Boolean);
 const switchEvents=parsed.filter(x=>String(x.kind||'').startsWith('VIRTUAL_DESKTOP_NOTIFICATION') || x.kind==='POLL_DESKTOP_CHANGE');
 const frontEvents=parsed.filter(x=>x.kind==='FOREGROUND_CHANGED');
 const trip=fs.existsSync(tripwire)?JSON.parse(fs.readFileSync(tripwire,'utf8')):null;
 const verdict={
    runId:tag,fixtureVariant,utc:new Date().toISOString(),switched:!!trip,firstFailingStep:runError?currentStep:null,
    firstSwitchObservedUtc:trip?.utc||null,firstSwitchReason:trip?.firstReason||null,
    lastCompletedAction:lastOk,reason:runError||null,
    switchEvents,foregroundChanges:frontEvents.slice(-25),
    actorProbePid:pid,probeHwnd:hwnd,allActionsCompleted:lastOk==='ALL_UI_ACTIONS',
    paths:{timeline,events,tripwire,wpfEvents},
    notes:"No auto-return. Tool overlap shows correlation, not definitive OS attribution."
 };
 fs.writeFileSync(resultFile,JSON.stringify(verdict,null,2));
 log('RESULT',{switched:verdict.switched,failedStep:currentStep,firstSwitch:trip?.utc||null,lastOk,
   desktopSwitchNotifications:switchEvents.length,foregroundEvents:frontEvents.length,
   resultFile});
 console.log('DIAGNOSTIC_RESULT='+JSON.stringify(verdict));
}
