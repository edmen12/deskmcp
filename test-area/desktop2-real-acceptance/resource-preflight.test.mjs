import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {requireSafeNativeGuiMemory,MIN_NATIVE_GUI_FREE_MB,
  requireSafePassiveObserverMemory,MIN_PASSIVE_OBSERVER_FREE_MB} from './resource-preflight.mjs';

const mb = value => value * 1024 * 1024;
test('real Desktop2 fixture memory preflight rejects low-memory host before GUI',async()=>{
  let calls=0;
  await assert.rejects(requireSafeNativeGuiMemory({
    freeBytes:()=>{calls++;return mb(507);}, pause:async()=>{}
  }),/NATIVE_GUI_INSUFFICIENT_HOST_MEMORY/);
  assert.equal(calls,1);
});

test('memory preflight rejects falling or invalid memory instead of trusting one lucky sample',async()=>{
  let pos=0;
  await assert.rejects(requireSafeNativeGuiMemory({
    freeBytes:()=>[mb(1500),mb(980),mb(1500)][pos++],pause:async()=>{}
  }),/NATIVE_GUI_INSUFFICIENT_HOST_MEMORY/);
  assert.equal(pos,2);
  await assert.rejects(requireSafeNativeGuiMemory({
    freeBytes:()=>Number.NaN,pause:async()=>{}
  }),/NATIVE_GUI_FREE_MEMORY_UNAVAILABLE/);
});

test('memory preflight requires consecutive stable samples at/above fixed threshold',async()=>{
  let calls=0;
  const result=await requireSafeNativeGuiMemory({
    freeBytes:()=>{calls++;return mb(1400);},pause:async()=>{}
  });
  assert.equal(calls,3);
  assert.deepEqual(result,{minMb:MIN_NATIVE_GUI_FREE_MB,seenMb:[1400,1400,1400]});
});

test('resource preflight is mandatory before observer startup and immediately before fixture spawn',()=>{
 const source=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'run-native-edit-once.mjs'),'utf8');
 const first=source.indexOf("await requireSafeNativeGuiMemory()");
 const session=source.indexOf("await session.start()");
 const second=source.indexOf("await requireSafeNativeGuiMemory()",first+1);
 const fixture=source.indexOf("child=spawn(dotnet,");
 assert.ok(first>0&&first<session, 'No observer launch before RAM gate');
 assert.ok(second>session&&second<fixture, 'No GUI fixture launch before RAM recheck');
 assert.doesNotMatch(source,/NATIVE_GUI_SKIP_MEMORY_GATE|MEMORY_GATE_BYPASS/);
});

test('passive observer has a separate bounded gate, without reducing 1200MiB GUI threshold',async()=>{
 assert.equal(MIN_PASSIVE_OBSERVER_FREE_MB,768);
 assert.equal(MIN_NATIVE_GUI_FREE_MB,1200);
 const sampled=await requireSafePassiveObserverMemory({
  freeBytes:()=>mb(850),pause:async()=>{}
 });
 assert.deepEqual(sampled,{minMb:768,seenMb:[850,850,850]});
 await assert.rejects(requireSafeNativeGuiMemory({
  freeBytes:()=>mb(850),pause:async()=>{}
 }),/NATIVE_GUI_INSUFFICIENT_HOST_MEMORY/);
});
test('passive observer gate rejects low, falling and invalid samples',async()=>{
 for(const series of [[800,767,900],[700,900,900]]){
  let index=0;
  await assert.rejects(requireSafePassiveObserverMemory({
    freeBytes:()=>mb(series[index++]),pause:async()=>{}
  }),/PASSIVE_OBSERVER_INSUFFICIENT_HOST_MEMORY/);
 }
 await assert.rejects(requireSafePassiveObserverMemory({
  freeBytes:()=>NaN,pause:async()=>{}
 }),/PASSIVE_OBSERVER_FREE_MEMORY_UNAVAILABLE/);
 await assert.rejects(requireSafePassiveObserverMemory({samples:1}),
   /PASSIVE_OBSERVER_SAMPLE_COUNT_INVALID/);
});
test('monitor-only entrypoint may use passive gate, but Winver and WinForms must retain full GUI gate',()=>{
 const here=path.dirname(fileURLToPath(import.meta.url));
 const watcher=fs.readFileSync(path.join(here,'strict-prelaunch-watch-once.mjs'),'utf8');
 const winver=fs.readFileSync(path.join(here,'winver-hidden-move-once.mjs'),'utf8');
 const fixture=fs.readFileSync(path.join(here,'run-native-edit-once.mjs'),'utf8');
 assert.match(watcher,/await requireSafePassiveObserverMemory\(\)/);
 assert.doesNotMatch(watcher,/\bspawn\s*\(|\.moveWindow\s*\(|\.moveProcessTreeWindows\s*\(/);
 for(const source of [winver,fixture]){
  assert.match(source,/await requireSafeNativeGuiMemory\(\)/);
  assert.doesNotMatch(source,/requireSafePassiveObserverMemory/);
 }
});
