// Actual Node <-> .NET 10 named-pipe round-trip. Neither side starts Windows GUI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {sendOwnedWpfPipeCommand} from './wpf-app-owned-pipe.mjs';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..');
const main=path.resolve(root,'../DeskMCP');
const dotnet=path.join(main,'runtime','dotnet-sdk','dotnet.exe');
const dll=path.join(root,'test-area','desktop2-wpf-probe','bin','Release','net10.0-windows','DeskMCP.Desktop2WpfProbe.dll');
const pipe='deskmcp-d2-wpf-'+randomUUID();
const token=randomBytes(32).toString('hex');

// This exercises the SAME bounded transport as the real WPF D2 candidate.
function roundTrip({token:capability,sequence,action,...extra}){
 return sendOwnedWpfPipeCommand({
  pipe,token:capability,sequence,action,extra
 });
}
test('Windows headless WPF named pipe, auth/replay, rejection, framing, no GUI',async()=>{
 if(process.platform!=='win32')return;
 const proc=spawn(dotnet,[dll,'--self-test-pipe',pipe,token],{
  cwd:root,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']
 });
 let stdout='',stderr='';
 const exit=new Promise((resolve,reject)=>{
  proc.once('error',reject);
  proc.once('exit',(code,signal)=>resolve({code,signal}));
 });
 proc.stdout.on('data',b=>{stdout+=b.toString('utf8');});
 proc.stderr.on('data',b=>{stderr+=b.toString('utf8').slice(0,1000);});
 try{
  const deadline=Date.now()+7000;
  while(!stdout.includes('WPF_OWNED_PIPE_HEADLESS_READY')){
   assert.equal(proc.exitCode,null,'C# server stopped before ready: '+stderr);
   assert.ok(Date.now()<deadline,'C# named pipe startup timed out: '+stderr);
   await new Promise(resolve=>setTimeout(resolve,35));
  }
  assert.deepEqual(await roundTrip({token,sequence:1,action:'edit',expected:'',value:'SAFE'}),
    {ok:true,sequence:1,action:'edit'});
  const invalidToken=await roundTrip({token:'b'.repeat(64),sequence:2,action:'button'});
  assert.equal(invalidToken.ok,false);
  assert.equal(invalidToken.error,'INVALID_FIXTURE_CAPABILITY');
  const invalidPayload=await roundTrip({token,sequence:2,action:'button',value:'UNEXPECTED'});
  assert.equal(invalidPayload.ok,false);
  assert.equal(invalidPayload.error,'UNEXPECTED_NONEDIT_PAYLOAD');
  assert.deepEqual(await roundTrip({token,sequence:2,action:'button'}),
    {ok:true,sequence:2,action:'button'});
  const replay=await roundTrip({token,sequence:2,action:'button'});
  assert.equal(replay.ok,false);
  assert.equal(replay.error,'STALE_OR_REPLAYED_COMMAND');
  assert.deepEqual(await roundTrip({token,sequence:3,action:'scroll'}),
    {ok:true,sequence:3,action:'scroll'});
  const ended=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('PIPE_CHILD_EXIT_TIMEOUT')),6000);
   exit.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
  assert.equal(ended.code,0,'C# server: '+stderr);
  assert.match(stdout,/WPF_OWNED_PIPE_HEADLESS_PASS accepted=3 denied=3/);
 }finally{
  if(proc.exitCode===null && proc.signalCode===null)proc.kill();
 }
});
