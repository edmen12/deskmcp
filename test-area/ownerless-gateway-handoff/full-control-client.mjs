import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';

const privateRoot=path.resolve('test-area/ownerless-gateway-handoff/data');
const port=Number(process.env.DESKTOP_MCP_PORT);
if(path.resolve(process.env.DESKTOP_MCP_DATA_ROOT||'')!==privateRoot ||
  process.env.DESKTOP_MCP_INSTANCE_NAMESPACE!=='ownerless-handoff-20261024' ||
  process.env.DESKTOP_MCP_PROFILE!=='full-control' ||
  process.env.DESKTOP_MCP_DISABLE_TUNNEL!=='1' ||
  port!==59123)throw Error('ISOLATED_FULL_CONTROL_ENVIRONMENT_REQUIRED');
const result={status:'not_started',toolCount:0,agentToolFound:false,
  allocated:false,authorizationChecks:0,wpfExitObserved:false,
  manualExitJournal:false,postExitLeaseDenied:false,
  hudRemoved:false,otherToolCallsMade:false,fullGatewayProtocol:true,
  controlStoppedByNode:false,error:''};
const client=new Client({name:'isolated-full-gateway-uia-exit',version:'0.9.23'},
 {versionNegotiation:{mode:'auto'}});
let lease;
try{
  const ready=JSON.parse(await readFile(path.join(privateRoot,'coordinator-ready.json'),'utf8'));
  if(!ready.ready||!ready.privateRoot||ready.desktopNumber!==2||
    ready.exitMode!=='own-uia-exit')throw Error('OWN_UIA_CONTROL_PANEL_NOT_READY');
  await client.connect(new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:'+port+'/mcp')));
  const listed=await client.listTools();
  result.toolCount=listed.tools.length;
  result.agentToolFound=listed.tools.some(x=>x.name==='desktop_agent_desktop');
  if(!result.agentToolFound)throw Error('REAL_MCP_AGENT_DESKTOP_TOOL_MISSING');
  async function call(args){
    const r=await client.callTool({name:'desktop_agent_desktop',arguments:args});
    if(r.isError)throw Error('MCP_TOOL_FAILED:'+JSON.stringify(r.content).slice(0,450));
    const t=r.content.find(x=>x.type==='text')?.text;
    if(!t)throw Error('MCP_RESPONSE_EMPTY');
    return JSON.parse(t);
  }
  const before=await call({action:'status'});
  if(!before.configured || before.available_desktops!==1 ||
    before.desktops[0].desktop_number!==2 || before.desktops[0].status!=='free')
    throw Error('LIVE_DESKTOP_OR_TEST_POOL_NOT_FREE');
  const started=await call({action:'start',desktop_number:2,
    task_label:'Full Candidate Gateway + private WPF/UIA Exit acceptance'});
  if(!started.control?.lease_id||!started.control.hud_ready||started.control.hud_visible)
    throw Error('FULL_GATEWAY_AGENT_DESKTOP_HUD_HANDSHAKE_FAILED');
  lease=started.control.lease_id;
  result.allocated=true;
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){
    const s=await call({action:'status',lease_id:lease});
    if(s.control?.lease_id===lease){
      if(s.control.hud_ready!==true || s.control.hud_visible)
        throw Error('FULL_GATEWAY_LIVE_HUD_BROKEN');
      result.authorizationChecks++;
    }else if(s.desktops[0]?.status==='free'){
      result.wpfExitObserved=true;
      const state=JSON.parse(await readFile(path.join(privateRoot,'agent-desktop','control.json'),'utf8'));
      const history=state.recentMutations||[];
      result.manualExitJournal=history.at(-2)?.reason==='lease_allocated'
        && history.at(-1)?.reason==='control_panel_manual_exit';
      if(!result.manualExitJournal)throw Error('WRONG_CONTROL_REVOCATION_REASON');
      // Status without a matching lease proves the MCP presentation is revoked;
      // status alone does not call the Manager's assertLease() implementation.
      result.postExitLeaseDenied=s.control===undefined;
      if(!result.postExitLeaseDenied)throw Error('STALE_MCP_LEASE_STILL_VISIBLE');
      for(let n=0;n<20;n++){
        try{await stat(path.join(privateRoot,'agent-desktop','hud-state.json'))}
        catch{result.hudRemoved=true;break}
        await new Promise(r=>setTimeout(r,150));
      }
      if(!result.hudRemoved)throw Error('HUD_HEARTBEAT_FILE_STILL_EXISTS');
      break;
    }else throw Error('UNKNOWN_POOL_STATE');
    await new Promise(r=>setTimeout(r,250));
  }
  if(!result.wpfExitObserved)throw Error('UIA_EXIT_DEADLINE_EXCEEDED');
  result.status='FULL_CONTROL_GATEWAY_HUD_UIA_EXIT_PASS';
}catch(e){
  result.status='FULL_CONTROL_GATEWAY_HUD_UIA_EXIT_FAIL';
  result.error=String(e?.message||e);
}finally{
  // Deliberately do NOT call the full-control Gateway's Stop() on success:
  // the UIA Exit must be the sole normal revocation actor.
  await client.close().catch(()=>{});
  await writeFile(path.join(privateRoot,'full-control-client-result.json'),JSON.stringify(result,null,2));
}
if(result.status!=='FULL_CONTROL_GATEWAY_HUD_UIA_EXIT_PASS')process.exitCode=2;
