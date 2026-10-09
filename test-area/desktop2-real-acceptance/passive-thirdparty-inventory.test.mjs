import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {censusDesktop2} from './passive-thirdparty-inventory.mjs';

const desktopId='d81244e4-e0c5-456f-a707-2b685a00662c';
const row={hwnd:17,processId:22,processName:'notepad.exe',
  className:'Notepad',title:'PRIVATE_TITLE_NEVER_OUTPUT',desktopId,
  desktopNumber:2,onCurrentDesktop:false,isForeground:false};

function fixture(patch={}) {
 let reads=0;
 const binding={desktopId,desktopNumber:2};
 const original={
  info:async()=>{reads++;return {currentDesktopNumber:1,virtualDesktopAccessor:true};},
  status:async()=>({bindings:[binding],controls:[]}),
  listVirtualWindows:async()=>({desktopId,desktopNumber:2,
    currentDesktopNumber:1,windows:[row]})
 };
 return {inputs:{...original,...patch},get reads(){return reads;}};
}
test('read-only system Notepad census preserves Desktop1 and redacts title/HWND/PID',async()=>{
 const f=fixture();
 const actual=await censusDesktop2(f.inputs);
 assert.deepEqual(actual,{pass:true,ownerDesktopBefore:1,ownerDesktopAfter:1,
   totalWindows:1,allowlistedProcessNames:['notepad.exe'],
   signatureVerified:false,authorizedForInput:false});
 assert.ok(!JSON.stringify(actual).includes('PRIVATE_TITLE'));
 assert.ok(!JSON.stringify(actual).includes('17'));
 assert.equal(f.reads,2);
});
test('census fails closed if user leaves Desktop1 between observations',async()=>{
 let reads=0;
 const f=fixture({info:async()=>({currentDesktopNumber:++reads===1?1:2,
   virtualDesktopAccessor:true})});
 await assert.rejects(censusDesktop2(f.inputs),/CENSUS_DESKTOP_CHANGED/);
});
test('census denies Desktop2 lease contention and changed binding',async()=>{
 const occupied=fixture({status:async()=>({bindings:[{desktopId,desktopNumber:2}],
   controls:[{active:true,desktopNumber:2}]})});
 await assert.rejects(censusDesktop2(occupied.inputs),/OCCUPIED/);
 let calls=0;
 const changed=fixture({status:async()=>({bindings:[{desktopId:calls++===0?desktopId:
   '00000000-0000-4000-8000-000000000001',desktopNumber:2}],controls:[]})});
 await assert.rejects(censusDesktop2(changed.inputs),/CENSUS_DESKTOP_CHANGED/);
});
test('census rejects foreign, pinned, foreground, duplicated, malformed desktop identity',async()=>{
 for(const w of [
   {...row,onCurrentDesktop:true},{...row,isForeground:true},
   {...row,desktopNumber:1},{...row,desktopId:'00000000-0000-4000-8000-000000000001'},
   {...row,processId:-1},{...row,hwnd:0}
 ]) {
  const f=fixture({listVirtualWindows:async()=>({desktopId,desktopNumber:2,
    currentDesktopNumber:1,windows:[w]})});
  await assert.rejects(censusDesktop2(f.inputs),/WINDOW_IDENTITY_MISMATCH/);
 }
 const repeat=fixture({listVirtualWindows:async()=>({desktopId,desktopNumber:2,
   currentDesktopNumber:1,windows:[row,row]})});
 await assert.rejects(censusDesktop2(repeat.inputs),/WINDOW_IDENTITY_MISMATCH/);
});
test('census never discloses unlisted process names or private GUI titles',async()=>{
 const f=fixture({listVirtualWindows:async()=>({desktopId,desktopNumber:2,
  currentDesktopNumber:1,windows:[{...row,processName:'PrivateAQP.exe'}]})});
 const result=await censusDesktop2(f.inputs);
 assert.deepEqual(result.allowlistedProcessNames,[]);
 assert.equal(result.authorizedForInput,false);
 assert.equal(result.totalWindows,1);
});
test('filename matching does not imply trusted system identity or input authorization',async()=>{
 const f=fixture({listVirtualWindows:async()=>({desktopId,desktopNumber:2,
  currentDesktopNumber:1,windows:[{...row,processName:'notepad.exe',className:'SPOOF_CLASS'}]})});
 const x=await censusDesktop2(f.inputs);
 assert.deepEqual(x.allowlistedProcessNames,['notepad.exe']);
 assert.equal(x.signatureVerified,false);
 assert.equal(x.authorizedForInput,false);
});

test('census denies malformed authority records',async()=>{
 for(const bad of [{bindings:[{desktopId,desktopNumber:2}]},
   {bindings:[{desktopId,desktopNumber:2}],controls:'bad'}]){
   const f=fixture({status:async()=>bad});
   await assert.rejects(censusDesktop2(f.inputs),/BINDING_MISSING_OR_OCCUPIED/);
 }
});

test('census source does not start, move, activate or interact with GUI applications',()=>{
 const source=readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
 'passive-thirdparty-inventory.mjs'),'utf8');
 for(const forbidden of [
  /\.moveWindow\s*\(/,/\.moveProcessTreeWindows\s*\(/,/\.backgroundWindowMessage\s*\(/,
  /\.init\s*\(/,/\.start\s*\(/,/\.dispatch\s*\(/,/\.snapshot\s*\(/,
  /\bspawn\s*\(/,/\bexecFile\s*\(/,/\bSendInput\s*\(/,/\bSetForegroundWindow\s*\(/
 ]) assert.doesNotMatch(source,forbidden);
});
