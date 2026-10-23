import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AgentDesktopManager } from '../../dist/src/agent-desktop-state.js';
import { AgentDesktopNativeBridge } from '../../dist/src/agent-desktop-native.js';
import { DesktopPolicy } from '../../dist/src/desktop-policy.js';
import { AuditLogger } from '../../dist/src/audit.js';
import { registerAgentDesktopTools } from '../../dist/src/agent-desktop-tools.js';

// Specialized isolated single-tool MCP transport. No full Gateway index.js,
// no bridge, browser, Computer Use, task manager, backend or external listeners.
const root=path.resolve('test-area/ownerless-gateway-handoff/data');
if (process.env.DESKTOP_MCP_INSTANCE_NAMESPACE!=='ownerless-handoff-20261024' ||
    process.env.DESKTOP_MCP_DISABLE_TUNNEL!=='1' ||
    process.env.DESKTOP_MCP_AGENT_DESKTOP_OWNERLESS_SAFETY_WINDOWS_EXPERIMENT!=='1' ||
    path.resolve(process.env.DESKTOP_MCP_DATA_ROOT||'')!==root)
  throw Error('PRIVATE_HANDOFF_MCP_GUARD');
const seconds=Number(process.argv[2]||0);
if(!Number.isInteger(seconds)||seconds<30||seconds>120)throw Error('BOUNDED_MCP_DURATION');
const out=path.join(root,'mcp-network-result.json');
let endpoint, handler, client, manager, lease;
const record={status:'not_started',elapsed_ms:0,tool_count:0,authorization_checks:0,
  allocation:true,stop:true,post_stop_rejected:false,realMcpTool:true,
  fullProductionGateway:false,otherToolsExposed:false,error:''};
const clock=Date.now();
try{
  const ready=JSON.parse(await readFile(path.join(root,'coordinator-ready.json'),'utf8'));
  if(!ready.ready || !ready.privateRoot || ready.desktopNumber!==2)
    throw Error('ISOLATED_CANDIDATE_PANEL_NOT_READY');
  manager=new AgentDesktopManager(path.join(root,'agent-desktop'),new AgentDesktopNativeBridge());
  await manager.init();
  const policy=await DesktopPolicy.create({profile:'full-control',allowedRoots:[root]});
  const audit=new AuditLogger(path.join(root,'mcp-transport-audit.jsonl'));
  await audit.init();
  handler=createMcpHandler(()=>{
    const server=new McpServer({name:'deskmcp-isolated-agent-desktop-only',version:'0.9.23'});
    registerAgentDesktopTools(server,policy,audit,manager);
    return server;
  });
  const nodeHandler=toNodeHandler(handler,{onerror(error){record.error+=' /transport:'+String(error)}});
  const checkHost=localhostHostValidation(),checkOrigin=localhostOriginValidation();
  endpoint=http.createServer((req,res)=>{
    if(req.url?.split('?')[0]!=='/mcp'){res.writeHead(404).end();return}
    if(!checkHost(req,res)||!checkOrigin(req,res))return;
    void nodeHandler(req,res);
  });
  await new Promise((ok,fail)=>{
    endpoint.once('error',fail);
    endpoint.listen(0,'127.0.0.1',ok);
  });
  const bound=endpoint.address();
  if(!bound||typeof bound==='string')throw Error('HTTP_BIND_MISSING');
  client=new Client({name:'isolated-agent-desktop-handoff',version:'0.0.1'},
    {versionNegotiation:{mode:'auto'}});
  await client.connect(new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:'+bound.port+'/mcp')));
  const listed=await client.listTools();
  record.tool_count=listed.tools.length;
  record.otherToolsExposed=listed.tools.some(x=>x.name!=='desktop_agent_desktop');
  if(record.tool_count!==1 || record.otherToolsExposed)
    throw Error('ISOLATED_MCP_TOOL_SET_INVALID');
  async function call(arguments_){
    const value=await client.callTool({name:'desktop_agent_desktop',arguments:arguments_});
    if(value.isError)throw Error('MCP_TOOL_DENIED:'+JSON.stringify(value.content).slice(0,500));
    const text=value.content.find(c=>c.type==='text')?.text;
    if(typeof text!=='string')throw Error('MCP_REPLY_MISSING');
    return JSON.parse(text);
  }
  const initially=await call({action:'status'});
  if(!initially.configured||initially.available_desktops!==1||
    initially.desktops[0].desktop_number!==2||initially.desktops[0].status!=='free')
    throw Error('MCP_INITIAL_POOL_NOT_FREE');
  const started=await call({action:'start',desktop_number:2,
    task_label:'Isolated MCP Tool Handoff — no production lease'});
  if(!started.control?.lease_id||!started.control.hud_ready ||
    started.control.hud_visible || started.desktops[0].status!=='occupied')
    throw Error('MCP_START_NOT_READY');
  lease=started.control.lease_id;
  const until=Date.now()+seconds*1000;
  while(Date.now()<until){
    const live=await call({action:'status',lease_id:lease});
    if(live.control?.lease_id!==lease || !live.control.hud_ready ||
       live.control.hud_visible || live.desktops[0].status!=='occupied')
       throw Error('MCP_LEASE_CHANGED_OR_HUD_STALE');
    record.authorization_checks++;
    await new Promise(ok=>setTimeout(ok,220));
  }
  const stopped=await call({action:'stop',lease_id:lease});
  record.stop=stopped.stopped===true && stopped.desktops[0].status==='free';
  record.post_stop_rejected=false;
  try{await manager.assertLease(lease)}catch{record.post_stop_rejected=true}
  const history=await manager.recentControlMutations();
  if(history.at(-2)?.reason!=='lease_allocated' ||
     history.at(-1)?.reason!=='explicit_stop' ||
     !record.stop || !record.post_stop_rejected)
    throw Error('MCP_STOP_MUTATION_PROVENANCE_FAILED');
  record.status='MCP_TOOL_ALLOCATION_HANDOFF_PASS';
}catch(err){
  record.status='MCP_TOOL_HANDOFF_FAIL';record.error=String(err?.message||err);
}finally{
  if(lease && manager)try{await manager.stopControl(lease)}catch{}
  if(client)try{await client.close()}catch{}
  if(handler)try{await handler.close()}catch{}
  if(endpoint)await new Promise(ok=>endpoint.close(()=>ok()));
  record.elapsed_ms=Date.now()-clock;
  await writeFile(out,JSON.stringify(record,null,2));
}
if(record.status!=='MCP_TOOL_ALLOCATION_HANDOFF_PASS')process.exitCode=2;
