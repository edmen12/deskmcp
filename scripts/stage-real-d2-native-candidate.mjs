// Offline / isolated candidate staging ONLY. Never installs, merges, updates
// a running Gateway, starts a GUI, or modifies the user's Desktop 1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sdk='C:\\Users\\User\\Desktop\\DeskMCP\\runtime\\dotnet-sdk';
const dotnet=path.join(sdk,'dotnet.exe');
const sourceHead=()=>exec('git',['rev-parse','HEAD']).stdout.trim();
const pinnedBase='c2ad782290a7bad780764d34aa79add54863f944';
const artifacts=[
 {name:'agent-desktop-host',rel:'agent-desktop-host',assembly:'DeskMCP.AgentDesktopHost'},
 {name:'desktop2-switch-observer',rel:'test-area/desktop2-switch-observer',assembly:'DeskMCP.Desktop2SwitchObserver'},
 {name:'desktop2-direct-uia',rel:'test-area/desktop2-direct-uia',assembly:'DeskMCP.Desktop2DirectUia'}
];
function exec(file,args){
 const run=spawnSync(file,args,{cwd:repo,windowsHide:true,shell:false,
  encoding:'utf8',timeout:120000,maxBuffer:1048576,
  env:{...process.env,DOTNET_ROOT:sdk,DOTNET_ROOT_X64:sdk,DOTNET_CLI_TELEMETRY_OPTOUT:'1'}});
 if(run.error||run.status!==0)
  throw Error('NATIVE_STAGE_STEP_FAILED '+path.basename(file)+' '+args.join(' ')+
    ': '+(run.stderr||run.stdout||run.error?.message||'').slice(0,1300));
 return run;
}
const sha256=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const packageRoot=path.join(repo,'test-area','desktop2-real-acceptance','runs');
assert.equal(process.platform,'win32','Windows-only native release');
assert.ok(fs.existsSync(dotnet),'Use pre-existing local .NET SDK only');
assert.equal(exec('git',['merge-base','--is-ancestor',pinnedBase,'HEAD']).status,0);
const head=sourceHead();
const stamp=new Date().toISOString().replace(/[:.]/gu,'-');
const dest=path.join(packageRoot,'native-stage-'+stamp);
assert.ok(!fs.existsSync(dest),'No overwrite of an existing stage');
fs.mkdirSync(dest,{recursive:true});
let completed=false;
try {
 const manifest={
  schema:1,
  status:'STAGED_NATIVE_HELPERS_ONLY_NOT_INSTALLABLE',
  sourceHead:head,
  sourceBase:pinnedBase,
  runtimeContract:'.NET 10 windows / bundled runtime required',
  createdUtc:new Date().toISOString(),
  productionUpdatePerformed:false,
  releaseApproved:false,
  includesDesktop1Input:false,
  nativePackages:[],
  negativeSecurityTests:{passed:false},
 };
 for(const x of artifacts){
  const project=path.join(repo,x.rel,x.assembly+'.csproj');
  assert.ok(fs.existsSync(project),'Source project missing '+project);
  exec(dotnet,['build',project,'--no-restore','-c','Release','--nologo','-v:q']);
  const assemblyDir=path.join(path.dirname(project),'bin','Release','net10.0-windows');
  const target=path.join(dest,x.name);
  fs.mkdirSync(target);
  const assets=[];
  for(const ext of ['.exe','.dll','.deps.json','.runtimeconfig.json']){
   const name=x.assembly+ext,from=path.join(assemblyDir,name),to=path.join(target,name);
   assert.ok(fs.existsSync(from),'Compiled Native asset missing '+from);
   fs.copyFileSync(from,to);
   assert.equal(sha256(from),sha256(to),'Staging hash changed');
   assets.push({name,bytes:fs.statSync(to).size,sha256:sha256(to)});
  }
  const sources=fs.readdirSync(path.dirname(project)).filter(n=>n.endsWith('.cs')||n.endsWith('.csproj'))
   .sort().map(n=>({name:n,sha256:sha256(path.join(path.dirname(project),n))}));
  manifest.nativePackages.push({name:x.name,assets,sources});
 }
 const guard=path.join(repo,'test-area','desktop2-direct-uia','native-release-guard.test.mjs');
 const check=exec(process.execPath,['--test',guard]);
 assert.match(check.stdout,/(?:#|ℹ)\s+pass\s+5/u);
 assert.match(check.stdout,/(?:#|ℹ)\s+fail\s+0/u);
 manifest.negativeSecurityTests={passed:true,summary:'5 pass; zero fail',
  includes:['real D2 native OS policy','foreground watcher self-test',
   'no-observer rejects native Edit/Button/List','quarantined ValuePattern and Invoke']};
 const manifestPath=path.join(dest,'manifest.json');
 fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{encoding:'utf8',flag:'wx'});
 completed=true;
 console.log(JSON.stringify({status:manifest.status,
   sourceHead:head,packages:manifest.nativePackages.length,
   assets:manifest.nativePackages.reduce((n,p)=>n+p.assets.length,0),
   negativeTests:manifest.negativeSecurityTests.summary,stagePath:dest,
   manifestSha256:sha256(manifestPath)}));
}finally {
 if(!completed)fs.rmSync(dest,{recursive:true,force:true});
}
