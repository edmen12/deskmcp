import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const get=p=>readFile(path.join(root,p),'utf8');
const [server,readOnly,runner,mover,browser]=await Promise.all([
 get('src/mcp-server.ts'),
 get('src/desktop2-real-inventory-tools.ts'),
 get('test-area/desktop2-real-acceptance/run-real-chrome-readonly-tool-once.mjs'),
 get('agent-desktop-host/Program.cs'),
 get('src/browser-runtime.ts')
]);
test('source-only real D2 VDA MCP tool is never registered in default production',()=>{
 assert.match(server,/process\.env\.DESKTOP_MCP_REAL_D2_INVENTORY_EXPERIMENT === '1'/);
 assert.match(server,/registerRealVirtualDesktop2InventoryTool/);
 assert.match(readOnly,/Desktop2WindowInventory/);
 assert.match(readOnly,/actionable: false/);
 assert.doesNotMatch(readOnly,/SendInput|SetForegroundWindow|SwitchDesktop/);
});
test('real Chrome functional acceptance requires native foreground PID/HWND attribution before any CDP input',()=>{
 const identities=runner.indexOf('OWNED_CHROME_NATIVE_WINDOW_IDENTITIES');
 const guard=runner.indexOf('OWNED_CHROME_STARTUP_STOLE_DESKTOP1_FOREGROUND');
 const firstInput=runner.indexOf("await act(b,{type:'virtual_copy'");
 assert.ok(identities>0&&guard>identities&&firstInput>guard);
 assert.match(runner,/ownedChromePids\.has\(e\.processId\)\|\|ownedChromeHwnds\.has\(e\.hwnd\)/);
 assert.match(runner,/result\.noTargetForeground/);
 assert.match(runner,/requireSafeNativeGuiMemory\(\)/);
 assert.match(runner,/await agent\.stopControl\(lease\)/);
});
test('real D2 browser source uses no-startup-window plus CDP nofocus and requires an independently started watcher',()=>{
 assert.match(browser,/--no-startup-window/);
 assert.match(browser,/const launchStyle = visibleDesktop2 \? ' -WindowStyle Hidden' : ''/);
 assert.match(browser,/cdp\.createPageWithoutFocus/);
 assert.match(browser,/Visible real Desktop2 requires a live independent Windows foreground\/desktop observer/);
 assert.match(browser,/this\.visibleDesktop2Observer\.assertHealthy/);
 assert.match(mover,/if \(!IsWindowVisible\(hwnd\)\) return true/);
});
