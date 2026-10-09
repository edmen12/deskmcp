import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const worktree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const bin=path.join(worktree,'agent-desktop-host','bin','Release','net10.0-windows',
  'DeskMCP.AgentDesktopHost.exe');
const file=path.join(worktree,'agent-desktop-host','Program.ExternalWinverProbe.cs');
const main=readFileSync(path.join(worktree,'agent-desktop-host','Program.cs'),'utf8');
const source=readFileSync(file,'utf8');
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
 assert.match(source,/EXTERNAL_PROBE_SYSTEM32_WINVER_PATH_REQUIRED/);
 assert.match(source,/EXTERNAL_PROBE_PROCESS_START_PROOF_FAILED/);
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
