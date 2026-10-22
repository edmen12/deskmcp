import assert from 'node:assert/strict';
import path from 'node:path';
import { WinAppComputerBackend } from '../dist/src/computer-use-backend.js';

const lease=process.argv[2];
if (!/^[0-9a-f-]{36}$/i.test(lease??'')) throw new Error('An owned test lease is required.');
const install=process.env.LOCALAPPDATA+'\\Programs\\DesktopMCP';
process.env.DESKTOP_MCP_WINAPP_PATH=install+'\\gateway\\winapp\\winapp.exe';
process.env.DESKTOP_MCP_PROCESS_HOST=install+'\\DeskMCP.ProcessHost.exe';
// This is a candidate-only native adapter for the patched C# ObjectWindows behavior.
// It is never installed over the production AgentDesktopHost executable.
process.env.DESKTOP_MCP_AGENT_DESKTOP_HOST=path.join(process.cwd(),'runtime','ego-d2-object-host-shim.exe');
const object='DeskMCP-Agent-'+lease.replaceAll('-','');
const backend=new WinAppComputerBackend();
let target;
for(let attempt=0;attempt<9;attempt++) {
  const windows=await backend.listWindows(undefined,object);
  console.log('D2_INVENTORY_ATTEMPT='+attempt+' '+JSON.stringify(windows.map(w=>w.title)));
  target=windows.find(w=>w.title?.includes('DeskMCP D2 Acceptance Fixture'));
  if(target)break;
  await new Promise(resolve=>setTimeout(resolve,1600));
}
if(!target) throw new Error('D2 fixture not discovered after repeated native object enumeration');
const inspect=await backend.inspect(target.hwnd,true,120,object);
console.log('INSPECTION_ELEMENTS='+JSON.stringify(inspect.elements.slice(0,35)));
const result=await backend.act(target.hwnd,{type:'set_value',selector:'AgentInput',value:'D2_AGENT_LIVE_PASS'},object);
console.log('INPUT='+JSON.stringify(result));
const click=await backend.act(target.hwnd,{type:'invoke',selector:'ApplyButton'},object);
console.log('APPLY='+JSON.stringify(click));
const verified=await backend.inspect(target.hwnd,true,120,object);
console.log('POST_INSPECT='+JSON.stringify(verified.elements.slice(0,35)));
console.log('D2_PRIVATE_COMPUTER_USE_LIVE_PASS');
