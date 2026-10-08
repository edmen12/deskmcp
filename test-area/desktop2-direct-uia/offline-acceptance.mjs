import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const dir=path.dirname(fileURLToPath(import.meta.url));
const worktree=path.resolve(dir,'..','..');
const sdk='C:\\Users\\User\\Desktop\\DeskMCP\\runtime\\dotnet-sdk\\dotnet.exe';
const vda='C:\\Users\\User\\Desktop\\DeskMCP\\runtime\\agent-desktop-runtime\\win-x64\\virtual-desktop-accessor\\VirtualDesktopAccessor.dll';
const project=path.join(dir,'DeskMCP.Desktop2DirectUia.csproj');
const dll=path.join(dir,'bin','Release','net10.0-windows','DeskMCP.Desktop2DirectUia.dll');
const denyMissing=path.join(dir,'deny-missing-observer.json');
const denyInvoke=path.join(dir,'deny-invoke.json');
const env={...process.env,DOTNET_ROOT:path.dirname(sdk),
  DOTNET_CLI_HOME:path.join(worktree,'.dotnet-home'),
  DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1'};
const run=(exe,args,timeout=30000)=>spawnSync(exe,args,{
  cwd:worktree,env,timeout,encoding:'utf8',windowsHide:true,shell:false,
  maxBuffer:1024*1024
});
assert.ok(fs.existsSync(sdk) && fs.existsSync(vda),'Bundled SDK/VDA required. Do not install new runtimes.');
for(const fixture of [denyMissing,denyInvoke]){
  const r=JSON.parse(fs.readFileSync(fixture,'utf8'));
  assert.equal(r.hwnd,1);
  assert.equal(r.processId,1234);
  assert.ok(r.observerReady && !fs.existsSync(r.observerReady),
    'Fixture observer must be a definitely absent file; no live GUI call permitted.');
}
const build=run(sdk,['build',project,'-c','Release','--nologo','-v:q']);
assert.equal(build.status,0,'Build failed: '+(build.stdout||'')+' '+(build.stderr||''));
console.log('DIRECT_UIA_BUILD_PASS');
const policy=run(sdk,[dll,'--self-test'],10000);
assert.equal(policy.status,0,'Policy self-test failed');
const state=JSON.parse(policy.stdout);
assert.deepEqual([state.pass,state.desktop1,state.desktop2,state.unreadable,state.invokeIsDisabled],
  [true,true,false,false,true]);
console.log('DIRECT_UIA_POLICY_PASS');
const noObserver=run(sdk,[dll,'--request',denyMissing,'--vda',vda],12000);
assert.equal(noObserver.status,3,'Missing observer must deny with code 3');
assert.match(noObserver.stderr,/PASSIVE_OBSERVER_NOT_READY/);
console.log('DIRECT_UIA_NO_OBSERVER_DENIED_PASS');
const noInvoke=run(sdk,[dll,'--request',denyInvoke,'--vda',vda],12000);
assert.equal(noInvoke.status,3,'Unverified invoke must deny with code 3');
assert.match(noInvoke.stderr,/INVOKE_DISABLED_UNTIL_DESKTOP2_POPUP_ACTIVATION_ACCEPTANCE/);
console.log('DIRECT_UIA_UNVERIFIED_INVOKE_DENIED_PASS');
const suite=run(process.execPath,['--test',path.join(dir,'contract.test.mjs')],12000);
assert.equal(suite.status,0,'Static guard suite failed: '+(suite.stdout||'')+' '+(suite.stderr||''));
console.log('DIRECT_UIA_STATIC_GUARDS_6_OF_6_PASS');
console.log('DIRECT_UIA_OFFLINE_ACCEPTANCE_PASS');
