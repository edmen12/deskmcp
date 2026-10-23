import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentDesktopManager} from '../src/agent-desktop-state.js';
import type {AgentDesktopNativeBridge} from '../src/agent-desktop-native.js';

async function temporaryHarness(testBody:(context:{root:string;manager:AgentDesktopManager})=>Promise<void>) {
  const root=await mkdtemp(path.join(os.tmpdir(),'deskmcp-agent-desktop-mutation-'));
  try {
    await mkdir(root,{recursive:true});
    const manager=new AgentDesktopManager(root,{} as AgentDesktopNativeBridge);
    await testBody({root,manager});
  } finally {
    await rm(root,{recursive:true,force:true});
  }
}
function makeControl(generation:number,taskId?:string) {
  return {schemaVersion:1,generation,active:true,
    leaseId:randomUUID(),desktopId:randomUUID(),desktopNumber:2,
    startedAtUtc:new Date().toISOString(),
    ...(taskId?{taskId}:{})};
}
async function state(root:string) {
  return JSON.parse(await readFile(path.join(root,'control.json'),'utf8')) as {
    generation:number;controls:Array<{leaseId:string}>;lastMutation?:{
      reason:string;generation:number;beforeCount:number;afterCount:number;
      writerPid:number;atUtc:string;
    }};
}
test('Gateway bootstrap reset of an active lease saves the cause atomically',async()=>{
  await temporaryHarness(async({root,manager})=>{
    const active=makeControl(7);
    await writeFile(path.join(root,'control.json'),JSON.stringify({
      schemaVersion:2,generation:7,controls:[active]
    }));
    await manager.init();
    const doc=await state(root);
    assert.equal(doc.generation,8);
    assert.equal(doc.controls.length,0);
    assert.equal(doc.lastMutation?.reason,'gateway_initialization');
    assert.equal(doc.lastMutation?.generation,8);
    assert.equal(doc.lastMutation?.beforeCount,1);
    assert.equal(doc.lastMutation?.afterCount,0);
    assert.equal(doc.lastMutation?.writerPid,process.pid);
    assert.ok(Number.isFinite(Date.parse(doc.lastMutation!.atUtc)));
    assert.deepEqual(await manager.lastControlMutation(),doc.lastMutation);
  });
});
test('explicit stop and linked task close have separate authoritative reasons',async()=>{
  await temporaryHarness(async({root,manager})=>{
    await manager.init();
    const a=makeControl(4);
    const b=makeControl(4,'tsk_0123456789abcdef');
    await writeFile(path.join(root,'control.json'),JSON.stringify({
      schemaVersion:2,generation:4,controls:[a,b]
    }));
    await manager.stopControl(a.leaseId);
    const stopped=await state(root);
    assert.equal(stopped.lastMutation?.reason,'explicit_stop');
    assert.equal(stopped.lastMutation?.beforeCount,2);
    assert.equal(stopped.lastMutation?.afterCount,1);
    const linked=await manager.stopControlForTask('tsk_0123456789abcdef');
    assert.equal(linked.stopped,true);
    const final=await state(root);
    assert.equal(final.lastMutation?.reason,'linked_task_completed');
    assert.equal(final.lastMutation?.beforeCount,1);
    assert.equal(final.lastMutation?.afterCount,0);
  });
});
test('legacy controls and idempotent stop remain compatible without false provenance',async()=>{
  await temporaryHarness(async({root,manager})=>{
    await manager.init();
    const doc=await state(root);
    assert.equal(doc.lastMutation?.reason,'gateway_initialization');
    await manager.stopControl(randomUUID());
    const after=await state(root);
    assert.deepEqual(after,doc);
    await writeFile(path.join(root,'control.json'),JSON.stringify({
      schemaVersion:2,generation:5,controls:[]
    }));
    assert.equal(await manager.lastControlMutation(),undefined);
  });
});

test('malformed last mutation provenance cannot masquerade as a valid control document',async()=>{
  await temporaryHarness(async({root,manager})=>{
    await manager.init();
    const valid=await state(root);
    for(const corrupt of [
      {...valid,lastMutation:{...valid.lastMutation,reason:'user_selected_other_desktop'}},
      {...valid,lastMutation:{...valid.lastMutation,generation:999}},
      {...valid,lastMutation:{...valid.lastMutation,writerPid:-1}},
      {...valid,lastMutation:{...valid.lastMutation,afterCount:2}}
    ]) {
      await writeFile(path.join(root,'control.json'),JSON.stringify(corrupt));
      await assert.rejects(manager.lastControlMutation(),/invalid|control/i);
    }
  });
});
test('bootstrap init with no prior active control does not invent a revocation',async()=>{
  await temporaryHarness(async({root,manager})=>{
    await manager.init();
    const latest=await manager.lastControlMutation();
    assert.equal(latest?.reason,'gateway_initialization');
    assert.equal(latest?.beforeCount,0);
    assert.equal(latest?.afterCount,0);
  });
});
