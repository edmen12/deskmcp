import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const read=rel=>readFile(path.join(root,rel),'utf8');
const [processTools,uiTools,virtualInventory,bridge,matrix]=await Promise.all([
 read('src/process-tools.ts'),
 read('src/computer-use-tools.ts'),
 read('src/desktop2-window-inventory.ts'),
 read('src/agent-desktop-native.ts'),
 read('docs/desktop2-control-capability-matrix.md')
]);

test('the lease-bound launcher clearly identifies PRIVATE Win32 Desktop Object instead of real Win+Tab Desktop2',()=>{
 assert.match(processTools,/NOT the real Windows Win\+Tab virtual Desktop 2/);
 assert.match(processTools,/desktopObjectNameForLease\(agent_desktop_lease_id\)/);
 assert.match(processTools,/desktopObjectName\s*\)/);
});
test('lease-scoped UI window inventory and snapshots never claim real virtual Desktop2',()=>{
 assert.match(uiTools,/desktop_ui_windows[\s\S]*?private Win32 Desktop Object, NOT the real Win\+Tab virtual Desktop 2/);
 assert.match(uiTools,/desktop_ui_snapshot[\s\S]*?NOT the real Windows virtual Desktop 2/);
 assert.match(uiTools,/desktopObjectNameForLease\(agent_desktop_lease_id\)/);
});
test('actual Win+Tab Desktop2 enumerator validates native VDA membership, not private Win32 Desktop Object windows',()=>{
 assert.match(virtualInventory,/this\.native\.listVirtualWindows\(desktopId\)/);
 assert.match(virtualInventory,/item\.desktopNumber !== 2 \|\| item\.onCurrentDesktop !== false/);
 assert.match(virtualInventory,/item\.isForeground !== false/);
 assert.match(virtualInventory,/end\.currentDesktopNumber !== 1/);
 assert.match(bridge,/'list-virtual-windows'/);
});
test('live third-party Notepad private-object evidence must remain a non-PASS for real virtual D2',()=>{
 assert.match(matrix,/Third-party Windows 11 Notepad via/);
 assert.match(matrix,/PRIVATE OBJECT VERIFIED \/ REAL D2 NOT PRESENT/);
 assert.match(matrix,/native VDA Windows virtual Desktop2 inventory independently had \*\*0 HWNDs\*\*/);
});
