// Offline native release guard. No target window exists or is created.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../..');
const sdk='C:\\Users\\User\\Desktop\\DeskMCP\\runtime\\dotnet-sdk';
const dotnet=path.join(sdk,'dotnet.exe');
const vda='C:\\Users\\User\\Desktop\\DeskMCP\\runtime\\agent-desktop-runtime\\win-x64\\virtual-desktop-accessor\\VirtualDesktopAccessor.dll';
const direct=path.join(here,'bin','Release','net10.0-windows','DeskMCP.Desktop2DirectUia.dll');
const observer=path.join(repo,'test-area','desktop2-switch-observer','bin','Release','net10.0-windows','DeskMCP.Desktop2SwitchObserver.dll');
const gone=path.join(here,'never-created-observer-'+process.pid+'.json');
const desktopId='d81244e4-e0c5-456f-a707-2b685a00662c';
const env={...process.env,DOTNET_ROOT:sdk,DOTNET_ROOT_X64:sdk};
const run=(module,args)=>spawnSync(dotnet,[module,...args],{env,cwd:repo,windowsHide:true,encoding:'utf8',shell:false,timeout:15000,maxBuffer:524288});
test('native helpers are rebuilt inside current branch and not loading previous build',()=>{
 for(const f of [dotnet,vda,direct,observer])assert.ok(fs.existsSync(f),f);
 assert.ok(direct.startsWith(repo)&&observer.startsWith(repo));
 assert.equal(fs.existsSync(gone),false,'This test never authorizes a live HWND');
});
test('UIA semantic policy self-test never grants D2 or Invoke',()=>{
 const r=run(direct,['--self-test']);
 assert.equal(r.status,0,String(r.stderr));
 const a=JSON.parse(r.stdout);
 assert.deepEqual([a.pass,a.desktop1,a.desktop2,a.unreadable,a.invokeIsDisabled],[true,true,false,false,true]);
});
test('WinEvent foreground tripwire self-test rejects owner desktop or wrong target',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'d2-negative-'));
 const out=path.join(temp,'foreground.json');
 try{
  const r=run(observer,['--self-test-foreground',out]);
  assert.equal(r.status,0,String(r.stderr));
  const a=JSON.parse(fs.readFileSync(out,'utf8'));
  assert.deepEqual([a.pass,a.target,a.otherPid,a.otherHwnd,a.ownerIsDesktop2,a.targetNotDesktop2,a.stillBlockedAfterReturn],
   [true,true,false,false,false,false,true]);
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
test('NO observer => all native Edit/Button/List inspect+write transports fail closed',()=>{
 const cases=[
  {action:'inspect-native-edits',automationId:'__native_edit_snapshot__'},
  {action:'set-native-edit',automationId:'native-edit:55',value:'NEW',expectedPreviousValue:''},
  {action:'inspect-native-buttons',automationId:'__native_button_snapshot__'},
  {action:'click-native-button',automationId:'native-button:55'},
  {action:'inspect-native-lists',automationId:'__native_list_snapshot__'},
  {action:'scroll-native-list',automationId:'native-list:55',topIndex:20,expectedPreviousTopIndex:0}
 ];
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'d2-native-deny-'));
 try{
  for(const [i,x] of cases.entries()){
   const file=path.join(temp,'case'+i+'.json');
   fs.writeFileSync(file,JSON.stringify({...x,hwnd:1,processId:1234,desktopId,observerReady:gone}));
   const r=run(direct,['--request',file,'--vda',vda]);
   assert.equal(r.status,3,'Unsafe native action '+x.action+' unexpectedly accepted: '+r.stderr);
   assert.match(r.stderr,/PASSIVE_OBSERVER_NOT_READY/,x.action);
  }
 }finally {fs.rmSync(temp,{recursive:true,force:true});}
});
test('known UIA focus-stealing ValuePattern and Invoke are quarantined',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'d2-uia-deny-'));
 try{
  for(const [action,phrase] of [
   ['set-value','DIRECT_UIA_VALUEPATTERN_QUARANTINED_AFTER_FOREGROUND_THEFT'],
   ['invoke','INVOKE_DISABLED_UNTIL_DESKTOP2_POPUP_ACTIVATION_ACCEPTANCE']
  ]){
   const filename=path.join(temp,action+'.json');
   fs.writeFileSync(filename,JSON.stringify({action,hwnd:1,processId:1234,
    desktopId,automationId:'WpfEdit',value:'NEVER_SEND',observerReady:gone}));
   const r=run(direct,['--request',filename,'--vda',vda]);
   assert.equal(r.status,3,action);
   assert.match(r.stderr,new RegExp(phrase),action);
  }
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
