import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/paths.js';
import {
  inspectPassiveDesktop2,
  type PassiveDesktop2Dependencies
} from '../src/computer-use-passive-d2.js';

const desktopId='d81244e4-e0c5-456f-a707-2b685a00662c';
const otherId='00000000-0000-4000-8000-000000000001';
const windowRow={ hwnd:123,processId:456,processName:'notepad.exe',
  className:'Notepad',title:'PRIVATE_APP_TEXT_NEVER_LOG',
  desktopId,desktopNumber:2,onCurrentDesktop:false,isForeground:false };

function fixture(override: Partial<PassiveDesktop2Dependencies>={}, windows: unknown[]=[windowRow]) {
  const base={
    info:async()=>({officialApi:true,virtualDesktopAccessor:true,currentDesktopNumber:1,desktopCount:2}),
    status:async()=>({
      bindings:[{desktopId,desktopNumber:2}],
      controls:[]
    }),
    listVirtualWindows:async()=>({desktopId,desktopNumber:2,
      currentDesktopNumber:1,windows})
  };
  return {...base,...override} as PassiveDesktop2Dependencies;
}

test('empty true Desktop2 returns safe no-candidates rather than compatibility PASS',async()=>{
  const result=await inspectPassiveDesktop2(fixture({},[]));
  assert.equal(result.pass,true);
  assert.equal(result.status,'no_candidate_windows');
  assert.equal(result.total_windows,0);
  assert.equal(result.general_native_compatibility_verified,false);
  assert.equal(result.authorized_for_input,false);
});
test('read-only census redacts HWND/PID and private window titles and unknown process names',async()=>{
  const result=await inspectPassiveDesktop2(fixture({},[
    windowRow,
    {...windowRow,hwnd:124,processId:457,processName:'PrivateAQP.exe',title:'SECRET_PROJECT'}
  ]));
  assert.equal(result.total_windows,2);
  assert.deepEqual(result.allowlisted_process_names,['notepad.exe']);
  const raw=JSON.stringify(result);
  for(const privateText of ['SECRET_PROJECT','PRIVATE_APP_TEXT_NEVER_LOG','PrivateAQP','123','456','124','457']) {
    assert.ok(!raw.includes(privateText),privateText);
  }
  assert.equal(result.signature_verified,false);
});
test('missing VDA is distinct from a real Desktop2 input-desktop mismatch',async()=>{
  await assert.rejects(inspectPassiveDesktop2(fixture({
    info:async()=>({officialApi:true,virtualDesktopAccessor:false,
      currentDesktopNumber:null,desktopCount:null})
  })),/PASSIVE_D2_VDA_UNAVAILABLE/);
  await assert.rejects(inspectPassiveDesktop2(fixture({
    info:async()=>({officialApi:true,virtualDesktopAccessor:true,
      currentDesktopNumber:2,desktopCount:2})
  })),/PASSIVE_D2_OWNER_NOT_DESKTOP1/);
});
test('active lease or changed binding fails closed without revealing windows',async()=>{
  await assert.rejects(inspectPassiveDesktop2(fixture({
    status:async()=>({bindings:[{desktopId,desktopNumber:2}],
      controls:[{active:true,desktopNumber:2}]})
  } as unknown as Partial<PassiveDesktop2Dependencies>)),/PASSIVE_D2_LEASE_OCCUPIED/);
  let calls=0;
  await assert.rejects(inspectPassiveDesktop2(fixture({
    status:async()=>({bindings:[{desktopId:calls++===0?desktopId:otherId,desktopNumber:2}],controls:[]})
  } as unknown as Partial<PassiveDesktop2Dependencies>)),/PASSIVE_D2_DESKTOP_OR_LEASE_CHANGED/);
});
test('scope mismatch, shared or foreground windows and duplicate HWND are rejected',async()=>{
  for(const bad of [
    {...windowRow,onCurrentDesktop:true},
    {...windowRow,isForeground:true},
    {...windowRow,desktopNumber:1},
    {...windowRow,desktopId:otherId},
    {...windowRow,hwnd:0},
    {...windowRow,processId:0}
  ]) {
    await assert.rejects(inspectPassiveDesktop2(fixture({},[bad])),
      /PASSIVE_D2_WINDOW_IDENTITY_UNVERIFIED/);
  }
  await assert.rejects(inspectPassiveDesktop2(fixture({},[windowRow,windowRow])),
    /PASSIVE_D2_WINDOW_IDENTITY_UNVERIFIED/);
});
test('changed current virtual desktop after enumeration is always rejected',async()=>{
  let calls=0;
  await assert.rejects(inspectPassiveDesktop2(fixture({
    info:async()=>({officialApi:true,virtualDesktopAccessor:true,
      currentDesktopNumber:++calls===1?1:2,desktopCount:2})
  })),/PASSIVE_D2_DESKTOP_OR_LEASE_CHANGED/);
});
test('native inventory runner cannot move windows, start GUI or grant input authorization',()=>{
  const runner=readFileSync(path.join(PROJECT_ROOT,'scripts',
    'passive-desktop2-thirdparty-inventory.mjs'),'utf8')
      .split(/\r?\n/).filter(line=>!line.trim().startsWith('//')).join('\n');
  const native=readFileSync(path.join(PROJECT_ROOT,'agent-desktop-host',
    'Program.Inventory.cs'),'utf8');
  for(const bad of [
    /\.startControl\s*\(/,/\.init\s*\(/,/\.moveWindow\s*\(/,
    /\.moveProcessWindows\s*\(/,/\.act\s*\(/,
    /\bspawn\s*\(/,/\bSendInput\s*\(/,/\bSetForegroundWindow\s*\(/
  ]) assert.doesNotMatch(runner,bad);
  for(const bad of ['SendInput(', 'SetForegroundWindow(', 'SwitchDesktop(',
    'ShowWindow(', 'SendMessage(', 'PostMessage(']) {
    assert.ok(!native.includes(bad),bad);
  }
});

test('native host discards private titles before serializing passive window results',()=>{
  const native=readFileSync(path.join(PROJECT_ROOT,'agent-desktop-host',
    'Program.Inventory.cs'),'utf8');
  assert.match(native,/title = String\.Empty/);
  assert.doesNotMatch(native,/title = title\.ToString\(\)/);
  assert.match(native,/if \(!vda\.Available \|\| vda\.CurrentDesktopNumber\(\) != 0/);
  assert.match(native,/manager\.GetWindowDesktopId\(hwnd\) != desktopId/);
  assert.match(native,/manager\.IsWindowOnCurrentVirtualDesktop\(hwnd\)/);
});
