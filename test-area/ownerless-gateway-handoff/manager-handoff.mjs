import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentDesktopManager } from '../../dist/src/agent-desktop-state.js';
import { AgentDesktopNativeBridge } from '../../dist/src/agent-desktop-native.js';

const allowed=path.resolve('test-area/ownerless-gateway-handoff/data');
const actual=path.resolve(process.env.DESKTOP_MCP_DATA_ROOT || '');
if(process.cwd()!==path.resolve('.') || actual!==allowed ||
   process.env.DESKTOP_MCP_INSTANCE_NAMESPACE!=='ownerless-handoff-20261024' ||
   process.env.DESKTOP_MCP_DISABLE_TUNNEL!=='1' ||
   process.env.DESKTOP_MCP_AGENT_DESKTOP_OWNERLESS_SAFETY_WINDOWS_EXPERIMENT!=='1')
    throw Error('HANDOFF_ISOLATION_GUARD_REFUSED');
const seconds=Number(process.argv[2]||0);
if(!Number.isInteger(seconds)||seconds<30||seconds>180)throw Error('HANDOFF_TIME_BOUND_REQUIRED');
const state=path.join(actual,'agent-desktop');
const readyPath=path.join(actual,'coordinator-ready.json');
const output=path.join(actual,'allocator-handoff-result.json');
const report={status:'not_started',active_checks:0,elapsed_ms:0,live_hud_start:false,
    desktop2_only:true,readiness_pass:false,explicit_stop:false,stale_rejected:false,
    no_production_gateway_requested:true,error:''};
let manager,ownLease;
const start=Date.now();
try {
  const ready=JSON.parse(await readFile(readyPath,'utf8'));
  if(ready.ready!==true||ready.privateRoot!==true||ready.desktopNumber!==2||!ready.owner)
    throw Error('ISOLATED_WPF_COORDINATOR_NOT_READY');
  manager=new AgentDesktopManager(state,new AgentDesktopNativeBridge());
  await manager.init();
  const before=await manager.status();
  if(!before.configured || before.controls.length!==0 ||
      before.desktops.length!==1 || before.desktops[0].desktopNumber!==2 ||
      before.desktops[0].status!=='free')throw Error('CANDIDATE_GATEWAY_PRECHECK_FAILED');
  const started=await manager.startControl('Cross-process isolated Manager allocation',undefined,2);
  const c=started.control;
  if(!c.active||!c.leaseId||!started.hud_ready||started.hud_visible ||
    started.desktops[0].status!=='occupied')
    throw Error('MANAGER_ALLOCATION_NO_VALID_NATIVE_HUD');
  ownLease=c.leaseId;
  report.readiness_pass=true;
  report.live_hud_start=true;
  const deadline=Date.now()+seconds*1000;
  while(Date.now()<deadline) {
    await manager.assertLease(ownLease);
    report.active_checks++;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  const released=await manager.stopControl(ownLease);
  report.explicit_stop=released.controls.length===0 && released.desktops[0].status==='free';
  const reason=await manager.lastControlMutation();
  if(reason?.reason!=='explicit_stop')throw Error('WRONG_EXIT_REASON');
  let rejected=false;
  try {await manager.assertLease(ownLease)}catch{rejected=true}
  report.stale_rejected=rejected;
  if(!report.explicit_stop||!report.stale_rejected)throw Error('LEASE_STOP_NO_REJECTION');
  report.status='REAL_MANAGER_HANDOFF_PASS';
} catch(ex) {
  report.status='REAL_MANAGER_HANDOFF_FAIL';
  report.error=String(ex?.message||ex);
} finally {
  if(ownLease && manager) {
     try{await manager.stopControl(ownLease)}catch{}
  }
  report.elapsed_ms=Date.now()-start;
  await writeFile(output,JSON.stringify(report,null,2));
}
if(report.status!=='REAL_MANAGER_HANDOFF_PASS')process.exitCode=2;
