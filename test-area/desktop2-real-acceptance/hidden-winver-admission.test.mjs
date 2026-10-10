import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync,existsSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';

const worktree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const bin=path.join(worktree,'agent-desktop-host','bin','Release','net10.0-windows',
  'DeskMCP.AgentDesktopHost.exe');
const file=path.join(worktree,'agent-desktop-host','Program.ExternalWinverProbe.cs');
const main=readFileSync(path.join(worktree,'agent-desktop-host','Program.cs'),'utf8');
const source=readFileSync(file,'utf8');
const guarded=readFileSync(path.join(worktree,'agent-desktop-host','Program.GuardedHiddenMove.cs'),'utf8');
function run(args) {
 return spawnSync(bin,args,{
  cwd:worktree,windowsHide:true,shell:false,timeout:6000,encoding:'utf8',
  maxBuffer:16384,
  env:{...process.env,
   DOTNET_ROOT:path.resolve(worktree,'../DeskMCP/runtime/dotnet-sdk'),
   DOTNET_ROOT_X64:path.resolve(worktree,'../DeskMCP/runtime/dotnet-sdk'),
   DESKTOP_MCP_VDA_PATH:path.resolve(worktree,'../DeskMCP/runtime/agent-desktop-runtime/win-x64/virtual-desktop-accessor/VirtualDesktopAccessor.dll')}
 });
}
test('dedicated hidden Winver probe exists in candidate but cannot launch programs',()=>{
 assert.ok(existsSync(bin));
 assert.match(main,/"probe-hidden-winver" => ProbeHiddenWinver/);
 assert.match(source,/GetWindowThreadProcessId/);
 assert.match(source,/IsWindowVisible/);
 assert.match(guarded,/EXTERNAL_PROBE_SYSTEM32_WINVER_PATH_REQUIRED/);
 assert.match(guarded,/EXTERNAL_PROBE_PROCESS_START_PROOF_FAILED/);
 assert.match(source,/EXTERNAL_PROBE_OWNER_DESKTOP1_REQUIRED/);
 assert.match(source,/signatureVerified=false,authorizedForInput=false/);
 for(const forbidden of [/\bProcess\.Start\s*\(/,/\bShowWindow\s*\(/,
  /\bMoveWindowToDesktop\s*\(/,/\bSendInput\s*\(/,
  /\bSetForegroundWindow\s*\(/,/\bCreateProcess\s*\(/,
  /\bSetCursorPos\s*\(/,/\bSetClipboardData\s*\(/])
  assert.doesNotMatch(source,forbidden);
});
test('invalid start-time proof denies before process discovery',()=>{
 const result=run(['probe-hidden-winver','--pid',String(process.pid),'--started-utc','invalid']);
 assert.equal(result.status,1);
 assert.match(result.stderr,/EXTERNAL_PROBE_VALID_START_TIME_REQUIRED/);
});
test('Node process can never pose as Winver even with plausible timestamp',()=>{
 const result=run(['probe-hidden-winver','--pid',String(process.pid),
  '--started-utc',new Date().toISOString()]);
 assert.equal(result.status,1);
 assert.match(result.stderr,/EXTERNAL_PROBE_ONLY_WINVER_PROCESS_ALLOWED/);
});
test('malformed pid fails before any HWND enumeration',()=>{
 const r=run(['probe-hidden-winver','--pid','0','--started-utc',new Date().toISOString()]);
 assert.equal(r.status,1);
 assert.match(r.stderr,/pid|positive|Invalid/i);
});

test('hidden-window move native executable denies all unsafe eligibility combinations',()=>{
 const r=run(['self-test-hidden-move']);
 assert.equal(r.status,0,r.stderr);
 const v=JSON.parse(r.stdout);
 assert.equal(v.pass,true);
 for(const k of ['eligible','deniesVisible','deniesForeign','deniesForeground',
   'deniesNonroot','deniesWrongOwner','deniesWrongSource','deniesWrongTarget'])
   assert.equal(v[k],true,k);
});
test('Winver candidate uses only exact owned hidden move, not generic move-window',()=>{
 const script=readFileSync(path.join(worktree,'test-area','desktop2-real-acceptance',
  'winver-hidden-move-once.mjs'),'utf8');
 const bridge=readFileSync(path.join(worktree,'src','agent-desktop-native.ts'),'utf8');
 assert.match(script,/await native\.moveOwnedHiddenWinver\(/);
 assert.doesNotMatch(script,/await native\.moveWindow\(/);
 assert.match(bridge,/'move-owned-hidden-winver'/);
 assert.match(main,/"move-owned-hidden-winver" => MoveOwnedHiddenWinver/);
 assert.match(guarded,/VerifyFreshOwnedWinver\(pid,startedUtc\)/);
 assert.match(guarded,/AssertFreshHiddenWindow\(hwnd,pid,desktop1Id\.Value,0,vda\)/);
 assert.match(guarded,/MoveWindowCore\(hwnd,desktopId,1,false,false,vda\)/);
 assert.match(guarded,/AssertFreshHiddenWindow\(hwnd,pid,desktopId,1,vda\)/);
 assert.match(guarded,/HIDDEN_MOVE_SHARED_WITH_DESKTOP1/);
 assert.doesNotMatch(guarded,/\bShowWindow\(|\bSetForegroundWindow\(|\bSendInput\(|\bSwitchDesktop\(|\bSetFocus\(/);
});
test('no HWND or malformed ownership is rejected without any GUI mutation',()=>{
 const invalid=run(['move-owned-hidden-winver','--hwnd','0','--pid',String(process.pid),
   '--started-utc',new Date().toISOString(),'--desktop-id',
   '00000000-0000-4000-8000-000000000001']);
 assert.equal(invalid.status,1);
 assert.match(invalid.stderr,/Invalid HWND/);
 const stale=run(['move-owned-hidden-winver','--hwnd','1','--pid','0',
   '--started-utc',new Date().toISOString(),'--desktop-id',
   '00000000-0000-4000-8000-000000000001']);
 assert.equal(stale.status,1);
 assert.match(stale.stderr,/pid|positive|Invalid/i);
});

test('native hidden move refuses a real Node process even when destination Desktop2 exists',()=>{
 const state=run(['desktop-info','--desktop-number','2']);
 assert.equal(state.status,0,state.stderr);
 const destination=JSON.parse(state.stdout);
 assert.equal(destination.desktopNumber,2);
 const candidate=run(['move-owned-hidden-winver','--hwnd','1',
   '--pid',String(process.pid),'--started-utc',new Date().toISOString(),
   '--desktop-id',destination.desktopId]);
 assert.equal(candidate.status,1);
 assert.match(candidate.stderr,/Missing --observer-ready/);
});

test('strict native watcher executable guard rejects missing hooks and pre-loop Ready',()=>{
 const r=run(['self-test-strict-observer-guard']);
 assert.equal(r.status,0,r.stderr);
 const v=JSON.parse(r.stdout);
 assert.equal(v.pass,true);
 for(const k of ['valid','rejectsNoPump','rejectsNoVda','rejectsNoForeground',
    'rejectsNoStrictForeground','rejectsNoShowHook','rejectsDesktop2'])
   assert.equal(v[k],true,k);
});
test('owned hidden Winver move is denied when watcher ready or live PID proof is absent',()=>{
 const strict=readFileSync(path.join(worktree,'agent-desktop-host',
   'Program.StrictObserverGuard.cs'),'utf8');
 const move=guarded;
 const first=move.indexOf('AssertStrictObserverLive(observerReady,observerTripwire,observerExe,observerPid)');
 const actual=move.indexOf('MoveWindowCore(hwnd,desktopId,1,false,false,vda)',first);
 const second=move.indexOf('AssertStrictObserverLive(observerReady,observerTripwire,observerExe,observerPid)',actual);
 assert.ok(first>0&&actual>first&&second>actual,'watcher must be checked before AND after moving HWND');
 for(const literal of ['hasVirtualDesktopNotifications','hasForegroundHook',
 'strictForegroundArmed','strictWindowShowArmed','messagePumpRunning',
 'processId','firstStartUtc','observer.ready.json','observer.tripwire.json'])
   assert.ok(strict.includes(literal),literal);
 assert.match(strict,/owner\.HasExited/);
 assert.match(strict,/File\.Exists\(alarm\)/);
 assert.match(strict,/HIDDEN_MOVE_OBSERVER_PID_OR_EXE_MISMATCH/);
 assert.doesNotMatch(strict,/\bShowWindow\s*\(|\bSetForegroundWindow\s*\(|\bSendInput\s*\(/);
 const state=run(['desktop-info','--desktop-number','2']);
 assert.equal(state.status,0,state.stderr);
 const destination=JSON.parse(state.stdout);
 const fake=path.join(worktree,'test-area','desktop2-real-acceptance',
   'nonexistent-observer-identity','observer.ready.json');
 const guardArgs=['move-owned-hidden-winver','--hwnd','1','--pid',String(process.pid),
   '--started-utc',new Date().toISOString(),'--desktop-id',destination.desktopId,
   '--observer-ready',fake,
   '--observer-tripwire',path.join(path.dirname(fake),'observer.tripwire.json'),
   '--observer-exe',path.join(worktree,'test-area','desktop2-switch-observer',
     'bin','Release','net10.0-windows','DeskMCP.Desktop2SwitchObserver.exe'),
   '--observer-pid',String(process.pid)];
 const denied=run(guardArgs);
 assert.equal(denied.status,1,denied.stderr);
 assert.match(denied.stderr,/HIDDEN_MOVE_OBSERVER_READY_OR_ALARM_INVALID/);
});

test('forged strict ready file for a real Node PID cannot impersonate the native observer binary',()=>{
 const state=run(['desktop-info','--desktop-number','2']);
 assert.equal(state.status,0,state.stderr);
 const desktopId=JSON.parse(state.stdout).desktopId;
 const temp=mkdtempSync(path.join(os.tmpdir(),'deskmcp-watch-forgery-'));
 try{
  const ready=path.join(temp,'observer.ready.json');
  const alarm=path.join(temp,'observer.tripwire.json');
  writeFileSync(ready,JSON.stringify({
    processId:process.pid,expectedDesktopIndex:0,
    firstStartUtc:new Date().toISOString(),
    tripwireFile:alarm,eventLog:path.join(temp,'observer.events.jsonl'),
    hasVirtualDesktopNotifications:true,hasForegroundHook:true,
    messagePumpRunning:true,strictForegroundArmed:true,
    strictWindowShowArmed:true
  }));
  const denied=run(['move-owned-hidden-winver',
    '--hwnd','1','--pid',String(process.pid),
    '--started-utc',new Date().toISOString(),'--desktop-id',desktopId,
    '--observer-ready',ready,'--observer-tripwire',alarm,
    '--observer-exe',path.join(worktree,'test-area','desktop2-switch-observer',
      'bin','Release','net10.0-windows','DeskMCP.Desktop2SwitchObserver.exe'),
    '--observer-pid',String(process.pid)]);
  assert.equal(denied.status,1,denied.stderr);
  assert.match(denied.stderr,/HIDDEN_MOVE_OBSERVER_PID_OR_EXE_MISMATCH/);
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test('native background message refuses any request lacking exact active target watcher authority',()=>{
 const state=run(['desktop-info','--desktop-number','2']);
 assert.equal(state.status,0,state.stderr);
 const destination=JSON.parse(state.stdout);
 const unsupported=run(['background-input',
  '--hwnd','1','--pid',String(process.pid),'--desktop-id',destination.desktopId,
  '--action','text','--text','NOT_SENT']);
 assert.equal(unsupported.status,1,unsupported.stderr);
 assert.match(unsupported.stderr,/Missing --observer-ready/);
 const native=readFileSync(path.join(worktree,'agent-desktop-host','BackgroundWindowInput.cs'),'utf8');
 const checked=readFileSync(path.join(worktree,'agent-desktop-host','Program.TargetObserverGuard.cs'),'utf8');
 assert.match(native,/Program.AssertTargetObserverLive\(/);
 assert.match(checked,/BACKGROUND_TARGET_WATCH_IDENTITY_MISMATCH/);
 assert.match(checked,/BACKGROUND_TARGET_WATCHER_EXITED_OR_TRIPPED/);
 assert.match(checked,/target.GetProperty\("desktopIndex"\).GetInt32\(\)!=1/);
 assert.match(checked,/state.GetProperty\("strictForegroundArmed"\).GetBoolean\(\)/);
});
