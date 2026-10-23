import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('test-area/ownerless-gateway-handoff/data');
const expected = path.resolve(process.env.DESKTOP_MCP_DATA_ROOT || '');
const port = Number(process.env.DESKTOP_MCP_PORT);
if(expected!==root || process.env.DESKTOP_MCP_PROFILE !== 'read-only' ||
   process.env.DESKTOP_MCP_DISABLE_TUNNEL!=='1' ||
   process.env.DESKTOP_MCP_INSTANCE_NAMESPACE!=='ownerless-readonly-runtime-20261024' ||
   port !== 59123) throw Error('READONLY_GATEWAY_ENV_NOT_ISOLATED');
const report={status:'not_started',mcpProtocol:false,agentToolRegistered:false,
  readOnlyComputerUseDenied:false, unauthorizedLeaseAllocationDenied:false,
  zeroNetworkListenerExposure:false, error:''};
const client=new Client({name:'isolated-full-gateway-readonly',version:'0.0.1'},
  {versionNegotiation:{mode:'auto'}});
try{
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp')));
  report.mcpProtocol=true;
  const listed=await client.listTools();
  report.agentToolRegistered=listed.tools.some(x=>x.name==='desktop_agent_desktop');
  if(!report.agentToolRegistered)throw Error('DESKTOP_AGENT_TOOL_ABSENT');
  // The real full Gateway is running in read-only mode. Both status and
  // start must refuse the computer-control policy; NO lease is allocated.
  const status=await client.callTool({name:'desktop_agent_desktop',arguments:{action:'status'}});
  report.readOnlyComputerUseDenied=status.isError===true;
  const start=await client.callTool({
    name:'desktop_agent_desktop',
    arguments:{action:'start',desktop_number:2,task_label:'MUST_BE_DENIED_READONLY'}
  });
  report.unauthorizedLeaseAllocationDenied=start.isError===true;
  if(!report.readOnlyComputerUseDenied || !report.unauthorizedLeaseAllocationDenied)
    throw Error('READONLY_POLICY_DID_NOT_FAIL_CLOSED');
  report.zeroNetworkListenerExposure=true; // host bind is separately verified by shell.
  report.status='ISOLATED_FULL_GATEWAY_READONLY_PASS';
}catch(err){ report.error=String(err?.message||err);report.status='ISOLATED_FULL_GATEWAY_READONLY_FAIL'; }
finally{
  await client.close().catch(()=>{});
  await writeFile(path.join(root,'full-readonly-client-result.json'),JSON.stringify(report,null,2));
}
if(report.status!=='ISOLATED_FULL_GATEWAY_READONLY_PASS')process.exitCode=2;
