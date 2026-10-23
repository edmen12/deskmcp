import {readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {McpServer,createMcpHandler} from '@modelcontextprotocol/server';
import {toNodeHandler,localhostHostValidation,localhostOriginValidation} from '@modelcontextprotocol/node';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {AgentDesktopManager} from '../../dist/src/agent-desktop-state.js';
import {AgentDesktopNativeBridge} from '../../dist/src/agent-desktop-native.js';
import {DesktopPolicy} from '../../dist/src/desktop-policy.js';
import {AuditLogger} from '../../dist/src/audit.js';
import {registerAgentDesktopTools} from '../../dist/src/agent-desktop-tools.js';

const privateRoot=path.resolve('test-area/ownerless-gateway-handoff/data');
if(path.resolve(process.env.DESKTOP_MCP_DATA_ROOT||'')!==privateRoot ||
  process.env.DESKTOP_MCP_INSTANCE_NAMESPACE!=='ownerless-handoff-20261024' ||
  process.env.DESKTOP_MCP_DISABLE_TUNNEL!=='1' ||
  process.env.DESKTOP_MCP_AGENT_DESKTOP_OWNERLESS_SAFETY_WINDOWS_EXPERIMENT!=='1')
  throw Error('STRICT_PRIVATE_ROOT_OR_FLAGS_MISSING');
const report={status:'not_started',durationMs:0,toolCount:0,
  authorizationChecks:0,mcpStartReady:false,wpfUiExitObserved:false,
  manualExitJournalVerified:false,staleLeaseRejected:false,
  hudHeartbeatFileRemoved:false,managerStopInvokedForNormalExit:false,
  noProductionGatewayCalls:true,error:''};
const began=Date.now();
let server,adapter,client,manager,lease;
const dataDir=path.join(privateRoot,'agent-desktop');
try{
  const ready=JSON.parse(await readFile(path.join(privateRoot,'coordinator-ready.json'),'utf8'));
  if(!ready.ready || !ready.privateRoot || ready.desktopNumber!==2 || ready.exitMode!=='own-uia-exit')
    throw Error('CANDIDATE_UIA_EXIT_CONTROL_PANEL_NOT_READY');
  manager=new AgentDesktopManager(dataDir,new AgentDesktopNativeBridge());
  await manager.init();
  const policy=await DesktopPolicy.create({profile:'full-control',allowedRoots:[privateRoot]});
  const audit=new AuditLogger(path.join(privateRoot,'mcp-uia-exit-audit.jsonl'));
  await audit.init();
  adapter=createMcpHandler(()=>{
    const mcp=new McpServer({name:'isolated-agent-desktop-uia-exit',version:'0.9.23'});
    registerAgentDesktopTools(mcp,policy,audit,manager);
    return mcp;
  });
  const node=toNodeHandler(adapter,{onerror(e){report.error+=' protocol:'+String(e)}});
  const hostGuard=localhostHostValidation(),originGuard=localhostOriginValidation();
  server=http.createServer((req,res)=>{
    if(req.url?.split('?')[0]!=='/mcp'){res.writeHead(404).end();return}
    if(!hostGuard(req,res)||!originGuard(req,res))return;
    void node(req,res);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const addr=server.address();
  if(!addr||typeof addr==='string')throw Error('MCP_TEST_LOOPBACK_UNRESOLVED');
  client=new Client({name:'private-ui-hud-exit-verification',version:'0.1'},
    {versionNegotiation:{mode:'auto'}});
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+addr.port+'/mcp')));
  const tools=await client.listTools();
  report.toolCount=tools.tools.length;
  if(report.toolCount!==1 || tools.tools[0].name!=='desktop_agent_desktop')
    throw Error('EXCESS_NETWORK_TOOL_SURFACE');
  async function call(input){
    const resp=await client.callTool({name:'desktop_agent_desktop',arguments:input});
    if(resp.isError)throw Error('MCP_AGENT_TOOL_FAILED:'+JSON.stringify(resp.content).slice(0,360));
    return JSON.parse(resp.content.find(x=>x.type==='text')?.text||'null');
  }
  const before=await call({action:'status'});
  if(before.available_desktops!==1||before.desktops[0].status!=='free')
    throw Error('PREEXISTING_CONTROL_OR_UNAVAILABLE_D2');
  const start=await call({action:'start',desktop_number:2,
    task_label:'Owned UIA Exit, private MCP lease only'});
  if(!start.control?.hud_ready||start.control.hud_visible||!start.control.lease_id)
    throw Error('AGENT_DESKTOP_HUD_NOT_READY_ON_ALLOCATION');
  lease=start.control.lease_id;
  report.mcpStartReady=true;
  const startAt=Date.now(),deadline=startAt+63000;
  let completed=false;
  while(Date.now()<deadline){
    const live=await call({action:'status',lease_id:lease});
    if(live.control?.lease_id===lease){
      if(live.control.hud_ready!==true || live.control.hud_visible!==false)
        throw Error('HUD_HEARTBEAT_LOST_BEFORE_OWN_UIA_EXIT');
      await manager.assertLease(lease);
      report.authorizationChecks++;
    }else if(live.desktops[0]?.status==='free'){
      const journal=await manager.recentControlMutations();
      report.manualExitJournalVerified=journal.at(-2)?.reason==='lease_allocated'
        && journal.at(-1)?.reason==='control_panel_manual_exit';
      if(!report.manualExitJournalVerified)
        throw Error('UIA_EXIT_DID_NOT_PRODUCE_MANUAL_JOURNAL');
      report.wpfUiExitObserved=true;
      try{await manager.assertLease(lease)}catch{report.staleLeaseRejected=true}
      if(!report.staleLeaseRejected)throw Error('REVOKED_CONTROL_STILL_AUTHORIZED');
      for(let attempt=0;attempt<15;attempt++){
        try{await stat(path.join(dataDir,'hud-state.json'));await new Promise(r=>setTimeout(r,150))}
        catch{report.hudHeartbeatFileRemoved=true;break}
      }
      if(!report.hudHeartbeatFileRemoved)throw Error('HUD_NOT_CLEARED_AFTER_UIA_EXIT');
      completed=true;
      break;
    }else{
      throw Error('UNEXPECTED_POOL_STATE_DURING_OWN_UIA_EXIT');
    }
    await new Promise(r=>setTimeout(r,225));
  }
  if(!completed)throw Error('OWN_HUD_UIA_EXIT_EXPIRED_WITHOUT_SIGNAL');
  report.status='MCP_LEASE_OWN_HUD_UIA_EXIT_PASS';
}catch(e){
  report.status='MCP_LEASE_OWN_HUD_UIA_EXIT_FAIL';
  report.error=String(e?.message||e);
}finally{
  // Failsafe only. A successful run must be revoked by WPF Exit, never Node Stop.
  if(lease&&manager){
    try{
      if(await manager.isLeaseActive(lease))await manager.stopControl(lease);
    }catch{}
  }
  if(client)await client.close().catch(()=>{});
  if(adapter)await adapter.close().catch(()=>{});
  if(server)await new Promise(r=>server.close(()=>r()));
  report.durationMs=Date.now()-began;
  await writeFile(path.join(privateRoot,'mcp-hud-uia-exit-result.json'),JSON.stringify(report,null,2));
}
if(report.status!=='MCP_LEASE_OWN_HUD_UIA_EXIT_PASS')process.exitCode=2;
