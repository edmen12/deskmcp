import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
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
    assert.equal(doc.lastMutation,undefined);
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
    assert.equal(latest,undefined);
    const initial = await state(root);
    await manager.init();
    assert.deepEqual(await state(root),initial);
  });
});

test('idle Gateway restart keeps the previous meaningful stop reason and recent history',async()=>{
  await temporaryHarness(async({root,manager})=>{
    const lease=makeControl(10);
    await writeFile(path.join(root,'control.json'),JSON.stringify({
      schemaVersion:2,generation:10,controls:[lease]
    }));
    await manager.stopControl(lease.leaseId);
    const before=await state(root);
    assert.equal(before.lastMutation?.reason,'explicit_stop');
    await manager.init();
    await manager.init();
    assert.deepEqual(await state(root),before);
    const history=await manager.recentControlMutations();
    assert.deepEqual(history,[before.lastMutation]);
  });
});

test('bounded history preserves 32 recent contiguous atomic generations after a stop',async()=>{
  await temporaryHarness(async({root,manager})=>{
    const controls=[makeControl(32)];
    const previous=Array.from({length:32},(_,i)=>{
      const generation=i+1;
      const afterCount=generation%2===0?1:0;
      return {reason:afterCount===0?'explicit_stop':'lease_allocated',
        generation,atUtc:new Date().toISOString(),beforeCount:1-afterCount,
        afterCount,writerPid:process.pid};
    });
    await writeFile(path.join(root,'control.json'),JSON.stringify({
      schemaVersion:2,generation:32,controls,lastMutation:previous[31],
      recentMutations:previous
    }));
    await manager.stopControl(controls[0]!.leaseId);
    const result=await state(root);
    const history=await manager.recentControlMutations();
    assert.equal(result.generation,33);
    assert.equal(history.length,32);
    assert.equal(history[0]!.generation,2);
    assert.equal(history[31]!.generation,33);
    assert.equal(history.at(-1)?.reason,'explicit_stop');
    for(let i=1;i<history.length;i++){
      assert.equal(history[i]!.generation,history[i-1]!.generation+1);
      assert.equal(history[i]!.beforeCount,history[i-1]!.afterCount);
    }
  });
});

test('history split, out-of-order generation, and forged counts all fail closed',async()=>{
  await temporaryHarness(async({root,manager})=>{
    const control=makeControl(9);
    const last={reason:'lease_allocated',generation:9,atUtc:new Date().toISOString(),
      beforeCount:0,afterCount:1,writerPid:process.pid};
    await writeFile(path.join(root,'control.json'),JSON.stringify({
      schemaVersion:2,generation:9,controls:[control],
      lastMutation:last,recentMutations:[last]
    }));
    const valid=JSON.parse(await readFile(path.join(root,'control.json'),'utf8')) as Record<string,unknown>;
    for(const changes of [
      {recentMutations:[]},
      {recentMutations:[{...last,generation:8},last]},
      {recentMutations:[{...last,generation:8,afterCount:2},last]},
      {lastMutation:{...last,reason:'explicit_stop'}},
      {recentMutations:Array.from({length:33},()=>last)}
    ]) {
      await writeFile(path.join(root,'control.json'),JSON.stringify({...valid,...changes}));
      await assert.rejects(manager.recentControlMutations(),/control state is invalid/);
    }
  });
});

test('cross-instance simultaneous explicit stops serialize and preserve both reasons',async()=>{
  await temporaryHarness(async({root,manager})=>{
    const another=new AgentDesktopManager(root,{} as AgentDesktopNativeBridge);
    const first=makeControl(21);
    const second={...makeControl(21),taskId:'tsk_0123456789abcdef'};
    await writeFile(path.join(root,'control.json'),JSON.stringify({
      schemaVersion:2,generation:21,controls:[first,second]
    }));
    const [r1,r2]=await Promise.allSettled([
      manager.stopControl(first.leaseId),
      another.stopControlForTask('tsk_0123456789abcdef')
    ]);
    assert.equal(r1.status,'fulfilled');
    assert.equal(r2.status,'fulfilled');
    const final=await state(root);
    assert.equal(final.generation,23);
    assert.equal(final.controls.length,0);
    const events=await manager.recentControlMutations();
    assert.deepEqual(events.map(e=>e.reason).sort(),['explicit_stop','linked_task_completed']);
    assert.deepEqual(events.map(e=>e.generation),[22,23]);
    assert.equal(events[0]!.beforeCount,2);
    assert.equal(events[0]!.afterCount,1);
    assert.equal(events[1]!.beforeCount,1);
    assert.equal(events[1]!.afterCount,0);
  });
});

test('isolated Gateway-style init commits revoke reason before the owner process exits abnormally',async()=>{
  await temporaryHarness(async({root,manager})=>{
    const active=makeControl(40);
    await writeFile(path.join(root,'control.json'),JSON.stringify({
      schemaVersion:2,generation:40,controls:[active]
    }));
    const moduleUrl=new URL('../src/agent-desktop-state.js',import.meta.url).href;
    const worker=[
      'const mod=await import(process.argv[1]);',
      'const manager=new mod.AgentDesktopManager(process.argv[2],{});',
      'await manager.init();',
      'process.exit(73);'
    ].join('');
    const child=spawn(process.execPath,['--input-type=module','-e',worker,moduleUrl,root],{
      windowsHide:true,stdio:'ignore'
    });
    const code=await new Promise<number|null>((resolve,reject)=>{
      child.once('error',reject);
      child.once('exit',code=>resolve(code));
    });
    assert.equal(code,73);
    const after=await state(root);
    assert.equal(after.generation,41);
    assert.equal(after.controls.length,0);
    assert.equal(after.lastMutation?.reason,'gateway_initialization');
    assert.ok(after.lastMutation!.writerPid>0);
    assert.notEqual(after.lastMutation!.writerPid,process.pid);
    const recovered=new AgentDesktopManager(root,{} as AgentDesktopNativeBridge);
    await recovered.init();
    assert.deepEqual(await state(root),after);
    const history=await recovered.recentControlMutations();
    assert.equal(history.length,1);
    assert.equal(history[0]!.reason,'gateway_initialization');
  });
});

test('stop racing Gateway init cannot leave an orphan active control or discontinuous mutation history',async()=>{
  await temporaryHarness(async({root,manager})=>{
    const second=new AgentDesktopManager(root,{} as AgentDesktopNativeBridge);
    const control=makeControl(54);
    await writeFile(path.join(root,'control.json'),JSON.stringify({
      schemaVersion:2,generation:54,controls:[control]
    }));
    await Promise.all([manager.stopControl(control.leaseId),second.init()]);
    const done=await state(root);
    assert.equal(done.controls.length,0);
    assert.equal(done.generation,55);
    const history=await manager.recentControlMutations();
    assert.equal(history.length,1);
    assert.ok(['explicit_stop','gateway_initialization'].includes(history[0]!.reason));
    assert.equal(history[0]!.beforeCount,1);
    assert.equal(history[0]!.afterCount,0);
    const stable=await state(root);
    await manager.init();
    assert.deepEqual(await state(root),stable);
  });
});

test('equivalent journal metadata with reordered JSON keys remains valid',async()=>{
  await temporaryHarness(async({root,manager})=>{
    const control=makeControl(8);
    const last={reason:'lease_allocated',generation:8,atUtc:new Date().toISOString(),
      beforeCount:0,afterCount:1,writerPid:process.pid};
    const same={writerPid:last.writerPid,afterCount:1,beforeCount:0,
      atUtc:last.atUtc,generation:8,reason:'lease_allocated'};
    await writeFile(path.join(root,'control.json'),JSON.stringify({
      schemaVersion:2,generation:8,controls:[control],lastMutation:same,
      recentMutations:[last]
    }));
    assert.equal((await manager.recentControlMutations()).length,1);
    assert.equal((await manager.lastControlMutation())?.reason,'lease_allocated');
  });
});
