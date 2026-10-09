import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {terminateOwnedChild} from './owned-process-cleanup.mjs';

function child({exitCode=null,signalCode=null,killResult=true,emitExit=true}={}){
 const instance=new EventEmitter();
 Object.assign(instance,{exitCode,signalCode,killCount:0,
   kill(){instance.killCount++;if(emitExit&&killResult){
     queueMicrotask(()=>{instance.signalCode='SIGTERM';instance.emit('exit',null,'SIGTERM');});
   }return killResult;}});
 return instance;
}
test('no child process requires no cleanup or process discovery',async()=>{
 assert.equal(await terminateOwnedChild(undefined),true);
});
test('already-exited owned child is not signaled again',async()=>{
 const c=child({exitCode:0});
 assert.equal(await terminateOwnedChild(c),true);
 assert.equal(c.killCount,0);
});
test('running owned child is killed exactly once and must emit exit',async()=>{
 const c=child();
 assert.equal(await terminateOwnedChild(c),true);
 assert.equal(c.killCount,1);
 assert.equal(c.listenerCount('exit'),0);
});
test('refused kill returns false and clears event listener',async()=>{
 const c=child({killResult:false});
 assert.equal(await terminateOwnedChild(c),false);
 assert.equal(c.killCount,1);
 assert.equal(c.listenerCount('exit'),0);
});
test('missing exit acknowledgement fails closed after bounded deadline',async()=>{
 const c=child({emitExit:false});
 assert.equal(await terminateOwnedChild(c,{deadlineMs:35}),false);
 assert.equal(c.killCount,1);
 assert.equal(c.listenerCount('exit'),0);
});
test('rejects inconsistent process handle and unbounded deadline',async()=>{
 await assert.rejects(terminateOwnedChild({exitCode:null,signalCode:null}),/HANDLE_INVALID/);
 await assert.rejects(terminateOwnedChild(child(),{deadlineMs:50000}),/DEADLINE_INVALID/);
});
