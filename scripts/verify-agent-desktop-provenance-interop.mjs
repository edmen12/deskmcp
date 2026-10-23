// Strictly offline C# <-> TypeScript data-contract test.
// Loads a candidate Control Panel assembly via reflection; never starts its GUI,
// touches live control.json or grants an Agent Desktop lease.
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {AgentDesktopManager} from '../dist/src/agent-desktop-state.js';
const run=promisify(execFile);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const probe=path.join(root,'test-area','agent-desktop-provenance-interop',
 'bin','Release','net10.0-windows','Interop.exe');
const assembly=path.join(root,'control-panel','wpf','bin','Release','net10.0-windows',
 'win-x64','DeskMCP.dll');
const dotnetRoot=process.env.DOTNET_ROOT||process.env.DOTNET_ROOT_X64
 ||path.join(path.dirname(root),'DeskMCP','runtime','dotnet-sdk');
const env={...process.env,DOTNET_ROOT:process.env.DOTNET_ROOT||dotnetRoot,
 DOTNET_ROOT_X64:process.env.DOTNET_ROOT_X64||dotnetRoot};
const temp=await mkdtemp(path.join(tmpdir(),'deskmcp-control-interop-'));
try{
  const emitted=JSON.parse((await run(probe,['emit',assembly],{
    cwd:temp,env,windowsHide:true,timeout:9000,maxBuffer:64*1024
  })).stdout);
  const manager=new AgentDesktopManager(temp,{});
  await writeFile(path.join(temp,'control.json'),JSON.stringify(emitted));
  const history=await manager.recentControlMutations();
  if(history.length!==1||history[0].reason!=='control_panel_safety_revocation'
     ||history[0].generation!==21||history[0].beforeCount!==1
     ||history[0].afterCount!==0)throw Error('C_SHARP_TO_GATEWAY_INTEROP_FAILED');

  const entry={reason:'control_panel_shutdown',generation:32,
    atUtc:new Date().toISOString(),beforeCount:1,afterCount:0,writerPid:process.pid};
  const fromGateway={schemaVersion:2,generation:32,controls:[],
    lastMutation:entry,recentMutations:[entry]};
  const input=path.join(temp,'candidate-gateway-control.json');
  await writeFile(input,JSON.stringify(fromGateway));
  const roundtripped=JSON.parse((await run(probe,['roundtrip',assembly,input],{
    cwd:temp,env,windowsHide:true,timeout:9000,maxBuffer:64*1024
  })).stdout);
  await writeFile(path.join(temp,'control.json'),JSON.stringify(roundtripped));
  const back=await manager.recentControlMutations();
  if(back.length!==1||back[0].reason!=='control_panel_shutdown'
    ||back[0].generation!==32||back[0].beforeCount!==1||back[0].afterCount!==0)
    throw Error('GATEWAY_TO_C_SHARP_INTEROP_FAILED');
  console.log(JSON.stringify({status:'C_SHARP_TYPESCRIPT_BIDIRECTIONAL_INTEROP_PASS',
    native_control_panel_model_loaded:true,
    control_panel_safety_mutation_round_trip:true,
    gateway_shutdown_mutation_round_trip:true,
    real_gui_started:false,production_control_file_touched:false}));
}catch(e){console.error(e instanceof Error?e.message:'CROSS_LANGUAGE_INTEROP_FAILED');
  process.exitCode=1;
}finally{await rm(temp,{recursive:true,force:true});}
