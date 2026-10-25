import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ComputerObservationRegistry } from '../dist/src/computer-use-observation.js';
import { ComputerUseCoordinator, ComputerWindowRegistry } from '../dist/src/computer-use-registry.js';
import { registerComputerUseTools } from '../dist/src/computer-use-tools.js';
import { AgentDesktopManager } from '../dist/src/agent-desktop-state.js';
import { AgentDesktopNativeBridge } from '../dist/src/agent-desktop-native.js';
import { WinAppComputerBackend } from '../dist/src/computer-use-backend.js';

const lease = process.argv[2];
assert.match(lease??'',/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i);
const candidateHost=path.join(process.cwd(),'runtime','csharp-check','candidate-host','DeskMCP.AgentDesktopHost.exe');
const install=path.join(process.env.LOCALAPPDATA,'Programs','DesktopMCP');
process.env.DESKTOP_MCP_AGENT_DESKTOP_HOST=candidateHost;
process.env.DESKTOP_MCP_WINAPP_PATH=path.join(install,'gateway','winapp','winapp.exe');
process.env.DESKTOP_MCP_PROCESS_HOST=path.join(install,'DeskMCP.ProcessHost.exe');
const native=new AgentDesktopNativeBridge(()=>candidateHost);
const root=path.join(process.env.LOCALAPPDATA,'DesktopMCP','agent-desktop');
// IMPORTANT: do NOT call manager.init() here! init() clears active leases.
const manager=new AgentDesktopManager(root,native);
await manager.assertLease(lease);
const runtime={
  backend:new WinAppComputerBackend(),windows:new ComputerWindowRegistry(),
  observations:new ComputerObservationRegistry(),coordinator:new ComputerUseCoordinator()
};
const handlers=new Map();
const server={registerTool(name,desc,handler){handlers.set(name,handler);}};
const policy={profile:'Full Control',assertCanUseComputer(){},isFullyUnlocked(){return false;}};
const audit={async begin(){return{};},async finish(){}};
registerComputerUseTools(server,policy,audit,runtime,manager);
async function invoke(tool,args){
  const handler=handlers.get(tool);assert.ok(handler,tool);
  const r=await handler(args);
  assert.ok(!r.isError,tool+': '+JSON.stringify(r).slice(0,600));
  const payload=r.content.find(c=>c.type==='text');
  assert.ok(payload,'missing tool result');
  return JSON.parse(payload.text);
}
const windows=await invoke('desktop_ui_windows',{agent_desktop_lease_id:lease,include_untitled:false});
assert.ok(!windows.some(w=>w.title?.includes('Desktop 1')),'Desktop 1 must not be listed');
const target=windows.find(w=>w.title?.includes('DeskMCP D2 Acceptance Fixture'));
assert.ok(target,'WinForms window missing from real Desktop 2 MCP inventory');
console.log('MCP_WINDOW='+JSON.stringify(target).slice(0,250));
const wrongLease='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const rejected=await handlers.get('desktop_ui_snapshot')({
  window_id:target.window_id,agent_desktop_lease_id:wrongLease,include_screenshot:false
});
assert.equal(rejected.isError,true,'wrong lease must be rejected before reading the isolated GUI');
console.log('WRONG_LEASE_MCP_SNAPSHOT_REJECTED=PASS');
const snap=await invoke('desktop_ui_snapshot',{
  window_id:target.window_id,agent_desktop_lease_id:lease,include_tree:true,include_screenshot:false
});
const edits=snap.elements.filter(e=>e.type==='Edit'&&e.selector?.startsWith('native:edit:'));
const buttons=snap.elements.filter(e=>e.type==='Button'&&e.name==='Apply Input'&&e.selector?.startsWith('native:button:'));
assert.equal(edits.length,1,'missing native textbox in real MCP snapshot');
assert.equal(buttons.length,1,'missing native button in real MCP snapshot');
assert.ok(snap.computer_observation_id);
console.log('MCP_NATIVE_CHILDREN=Edit+Button');
const next=await invoke('desktop_ui_action',{
  agent_desktop_lease_id:lease,window_id:target.window_id,
  computer_observation_id:snap.computer_observation_id,
  action:'set_value',selector:edits[0].selector,value:'D2_MCP_END_TO_END_PASS',
  settle_ms:0,observe_after:'tree'
});
assert.equal(next.succeeded,true);
assert.ok(next.state?.computer_observation_id,'second tool action requires new observation');
const clicked=await invoke('desktop_ui_action',{
  agent_desktop_lease_id:lease,window_id:target.window_id,
  computer_observation_id:next.state.computer_observation_id,
  action:'invoke',selector:buttons[0].selector,settle_ms:0,observe_after:'tree'
});
assert.equal(clicked.succeeded,true);
let actual='';
const expected='Applied: D2_MCP_END_TO_END_PASS';
for(let i=0;i<12;i++){
  try{actual=(await readFile(path.join(process.cwd(),'runtime','ego-d2-fixture-event.txt'),'utf8')).trim();}catch{}
  if(actual===expected)break;
  await new Promise(resolve=>setTimeout(resolve,150));
}
assert.equal(actual,expected);
await manager.assertLease(lease);
console.log('REAL_MCP_D2_TOOL_E2E_PASS '+actual);
