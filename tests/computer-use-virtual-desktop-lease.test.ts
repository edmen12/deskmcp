import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const src=readFileSync(path.join(process.cwd(),'src','computer-use-tools.ts'),'utf8').replaceAll('\r\n','\n');
function block(start:string,end:string) {
 const part=src.split(start)[1]?.split(end)[0];
 assert.ok(part,'expected Computer Use block: '+start);
 return part;
}
test('Desktop 2 inventory includes both verified virtual windows and lease-isolated Win32 desktop windows',()=>{
 const helper=block('async function listScopedComputerWindows(', 'function objectScopeForWindow(');
 assert.match(helper,/desktopObjectNameForLease\(agentDesktopLeaseId\)/u);
 assert.match(helper,/filterWindowsForLease\(regular, agentDesktopLeaseId\)/u);
 assert.match(helper,/runtime\.backend\.listWindows\(app, desktopObjectName\)/u);
 assert.match(helper,/await agentDesktop\.assertLease\(agentDesktopLeaseId\)/u);
 const list=block("server.registerTool(\n    'desktop_ui_windows'","server.registerTool(\n    'desktop_ui_snapshot'");
 assert.match(list,/listScopedComputerWindows\(runtime, agentDesktop, agent_desktop_lease_id, app\)/u);
 assert.match(list,/objectScopeForWindow\(inventory, window\)/u);
});
test('Desktop 2 snapshot maintains exact native object scope and virtual-desktop HWND check',()=>{
 const snap=block("server.registerTool(\n    'desktop_ui_snapshot'","server.registerTool(\n    'desktop_ui_action'");
 assert.match(snap,/resolveScopedComputerWindow\(runtime, inventory, window_id\)/u);
 assert.match(snap,/desktopObjectName \? \{ desktopObjectName \}/u);
 assert.match(snap,/assertWindowOnLease\(target\.hwnd, effectiveAgentDesktopLeaseId\)/u);
 assert.match(snap,/assertLease\(effectiveAgentDesktopLeaseId\)/u);
});
test('Desktop 2 actions revalidate exact native scope while blocking global input',()=>{
 const action=block("server.registerTool(\n    'desktop_ui_action'","server.registerTool(");
 assert.match(action,/resolveScopedComputerWindow\(runtime, inventory, input.window_id\)/u);
 assert.match(action,/runtime\.backend\.act\(target\.hwnd, action, desktopObjectName\)/u);
 assert.match(action,/listScopedComputerWindows\(runtime, agentDesktop,/u);
 assert.match(action,/assertWindowOnLease\(target\.hwnd, effectiveAgentDesktopLeaseId\)/u);
 assert.match(action,/assertWindowOnLease\(refreshed\.hwnd, effectiveAgentDesktopLeaseId\)/u);
 assert.match(action,/prepareAgentDesktopAction\(parsedAction\)/u);
});
