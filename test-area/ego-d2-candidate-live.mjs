import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
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
const edits=inspect.elements.filter(e=>e.type==='Edit'&&e.selector?.startsWith('native:edit:'));
const buttons=inspect.elements.filter(e=>e.type==='Button'&&e.name==='Apply Input'&&e.selector?.startsWith('native:button:'));
assert.equal(edits.length,1,'one native WinForms text box discovered');
assert.equal(buttons.length,1,'one native WinForms Apply button discovered');
console.log('D2_NATIVE_CONTROLS='+JSON.stringify({edit:edits[0].selector,button:buttons[0].selector}));
const set=await backend.act(target.hwnd,{type:'set_value',selector:edits[0].selector,value:'D2_AGENT_LIVE_PASS'},object);
assert.equal(set.readback_verified,true,'actual Win32 textbox value was confirmed');
const invoked=await backend.act(target.hwnd,{type:'invoke',selector:buttons[0].selector},object);
assert.equal(invoked.acknowledged,true);
const expected='Applied: D2_AGENT_LIVE_PASS';
let actual='';
for(let i=0;i<8;i++) {
  try {actual=(await readFile(path.join(process.cwd(),'runtime','ego-d2-fixture-event.txt'),'utf8')).trim();} catch {}
  if(actual===expected)break;
  await new Promise(resolve=>setTimeout(resolve,150));
}
assert.equal(actual,expected,'actual WinForms button-click callback was verified');
console.log('D2_PRIVATE_COMPUTER_USE_LIVE_PASS CALLBACK='+actual);
