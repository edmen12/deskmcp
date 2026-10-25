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
test('real virtual Desktop2 enumeration never mixes in private Win32 Desktop Object handles',()=>{
 const ordinary=block("server.registerTool(\n    'desktop_ui_windows'","server.registerTool(\n    'desktop_ui_snapshot'");
 assert.match(ordinary,/filterWindowsForLease\(windows, agent_desktop_lease_id\)/u);
 assert.match(ordinary,/runtime\.backend\.listWindows\(app\)/u);
 assert.doesNotMatch(ordinary,/desktopObjectNameForLease|objectScopeForWindow|desktopObjectName/u);
 const isolated=block("server.registerTool(\n    'desktop_ui_object_windows'","server.registerTool(\n    'desktop_ui_object_snapshot'");
 assert.match(isolated,/requireWin32ReadScope\(agent_desktop_lease_id\)/u);
 assert.match(isolated,/runtime\.backend\.listWindows\(app, objectName\)/u);
 assert.match(isolated,/action_authorized: false/u);
});
test('virtual Desktop2 snapshot retains exact lease and target window verification',()=>{
 const snap=block("server.registerTool(\n    'desktop_ui_snapshot'","server.registerTool(\n    'desktop_ui_action'");
 assert.match(snap,/runtime\.windows\.resolve\(window_id, scopedWindows\)/u);
 assert.match(snap,/assertWindowOnLease\(target\.hwnd, effectiveAgentDesktopLeaseId\)/u);
 assert.match(snap,/assertLease\(effectiveAgentDesktopLeaseId\)/u);
 assert.doesNotMatch(snap,/desktopObjectName \?|resolveScopedComputerWindow/u);
});
test('virtual Desktop2 action forbids private-object dispatch and checks lease post-action',()=>{
 const action=block("server.registerTool(\n    'desktop_ui_action'","server.registerTool(");
 assert.match(action,/runtime\.windows\.resolve\(input\.window_id, scopedWindows\)/u);
 assert.match(action,/runtime\.backend\.act\(target\.hwnd, action\)/u);
 assert.match(action,/assertWindowOnLease\(target\.hwnd, effectiveAgentDesktopLeaseId\)/u);
 assert.match(action,/prepareAgentDesktopAction\(parsedAction\)/u);
 assert.doesNotMatch(action,/desktopObjectName|objectScopeForWindow/u);
});
