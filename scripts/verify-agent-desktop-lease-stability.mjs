// Passive bounded HUD/lease/owner desktop stability check on a live lease.
// NEVER calls init(), stopControl(), listWindows(), WinApp or sends any UI input.
import path from 'node:path';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {AgentDesktopNativeBridge} from '../dist/src/agent-desktop-native.js';
import {AgentDesktopManager} from '../dist/src/agent-desktop-state.js';
import {resolveDeskMcpStateRoot} from '../dist/src/data-root.js';
import {classifyAgentDesktopLeaseFailure,assessObservedLeaseLoss}
  from '../dist/src/agent-desktop-lease-diagnostics.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const host=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows',
  'DeskMCP.AgentDesktopHost.exe');
const [lease,token,profile]=process.argv.slice(2);
const samples=profile==='extended_read_only_60s'?72:18;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
if((process.argv.length!==4 && process.argv.length!==5)
  || (profile!==undefined && profile!=='extended_read_only_60s')
  || !UUID.test(lease??'')
  || token!=='OWNED_AGENT_DESKTOP_HUD_STABILITY_READ_ONLY'
  || !existsSync(host) || process.platform!=='win32')
  throw Error('EXACT_LEASE_AND_PASSIVE_STABILITY_SENTINEL_REQUIRED');

const native=new AgentDesktopNativeBridge(()=>host);
const manager=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
const summary={
  status:'PASSIVE_STABILITY_NOT_STARTED',duration_ms:0,polls:0,
  owner_desktop_first:null,owner_desktop_last:null,
  initial_generation:null,final_generation:null,
  hud_heartbeat_checks_ok:0,lease_unchanged:false,
  process_mutation_attribution:'not_claimed',
  production_action_authorized:false
};
let baseline;
try{
  const before=await manager.assertLease(lease);
  if(before.control.desktopNumber!==2)
    throw Error('STABILITY_REQUIRES_DESKTOP2_HUD_LEASE');
  baseline=before.control;
  const first=await native.info();
  if(first.virtualDesktopAccessor!==true||first.currentDesktopNumber!==1)
    throw Error('STABILITY_OWNER_NOT_DESKTOP1');
  summary.owner_desktop_first=1;
  summary.initial_generation=baseline.generation;
  const started=Date.now();
  for(let i=0;i<samples;i++){
    const exact=await manager.assertLease(lease);
    const info=await native.info();
    if(info.virtualDesktopAccessor!==true||info.currentDesktopNumber!==1)
      throw Error('STABILITY_OWNER_DESKTOP_CHANGED');
    if(exact.control.generation!==baseline.generation
      || exact.control.desktopId?.toLowerCase()!==baseline.desktopId?.toLowerCase()
      || exact.control.leaseId?.toLowerCase()!==baseline.leaseId?.toLowerCase())
      throw Error('STABILITY_LEASE_IDENTITY_CHANGED');
    summary.polls++;
    summary.hud_heartbeat_checks_ok++;
    summary.owner_desktop_last=1;
    summary.final_generation=exact.control.generation;
    if(i<samples-1) await new Promise(resolve=>setTimeout(resolve,850));
  }
  summary.duration_ms=Date.now()-started;
  summary.lease_unchanged=true;
  summary.status='PASSIVE_HUD_LEASE_OWNER_DESKTOP_STABLE';
  console.log(JSON.stringify(summary));
}catch(e){
  summary.status='PASSIVE_STABILITY_FAILED';
  const reason=e instanceof Error?e.message:'UNKNOWN';
  const recent=await manager.lastControlMutation().catch(()=>undefined);
  const document=await readFile(path.join(manager.root,'control.json'),'utf8')
    .then(text=>JSON.parse(text)).catch(()=>null);
  const current=await native.info().catch(()=>null);
  const lastGeneration=Number.isSafeInteger(document?.generation)
    ? document.generation:null;
  const active=Array.isArray(document?.controls)
    ? document.controls.some(control=>control.leaseId?.toLowerCase()===lease.toLowerCase())
    : null;
  const observed=assessObservedLeaseLoss({
    initialGeneration:summary.initial_generation,
    finalGeneration:lastGeneration,stillActive:active,
    currentDesktopNumber:Number.isSafeInteger(current?.currentDesktopNumber)
      ?current.currentDesktopNumber:null,
    mutationReason:recent?.reason
  });
  // Fail closed, return only sanitized category/generations; no lease ID, HWND or title.
  console.error(JSON.stringify({status:summary.status,
    failure:classifyAgentDesktopLeaseFailure(reason),
    polls:summary.polls,hud_heartbeat_checks_ok:summary.hud_heartbeat_checks_ok,
    observed,production_action_authorized:false}));
  process.exitCode=1;
}
