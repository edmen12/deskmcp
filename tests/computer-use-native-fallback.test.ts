import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const host=readFileSync(path.join(process.cwd(),'agent-desktop-host','ObjectUi.cs'),'utf8');
const dispatcher=readFileSync(path.join(process.cwd(),'agent-desktop-host','Program.cs'),'utf8');
const gateway=readFileSync(path.join(process.cwd(),'src','computer-use-backend.ts'),'utf8');

test('private WinForms native fallback is restricted to lease-owned top-level windows',()=>{
 assert.match(host,/OpenDesktop\(desktopName, 0, false, DesktopReadObjects \| DesktopEnumerate\)/);
 assert.match(host,/EnumDesktopWindows\(desktop,/);
 assert.match(host,/Target HWND belongs to a different Win32 Desktop Object/);
 assert.match(host,/GetWindowThreadProcessId\(root, out uint owner\)/);
 assert.match(host,/childOwner != owner/);
 assert.match(dispatcher,/"object-controls" => ObjectUi\.Inspect/);
 assert.match(dispatcher,/"object-act" => ObjectUi\.Act/);
});
test('native WinForms fallback never injects global mouse keyboard, clipboard or arbitrary selector',()=>{
 assert.ok(host.includes('native:(edit|button):'), 'Only explicitly scoped native EDIT/BUTTON selectors are permitted');
 assert.match(host,/WmSetText/);
 assert.match(host,/BmClick/);
 assert.match(host,/Password fields require human takeover/);
 assert.match(host,/Only WinForms EDIT set_value and BUTTON invoke are allowed/);
 assert.doesNotMatch(host, /\bSendInput\s*\(|\bSwitchDesktop\s*\(|\bSetForegroundWindow\s*\(|\bClipboard\./);
});
test('WinApp isolated snapshot only adds bounded native child observations while native action is scoped',()=>{
 assert.match(gateway,/'object-controls', '--desktop-object', desktopObjectName/);
 assert.match(gateway,/'--hwnd', String\(hwnd\)/);
 assert.match(gateway,/flattenUiElementsForMcp\(data\.elements, maxElements\)/);
 assert.match(gateway,/\.slice\(0, maxElements\)/);
 assert.match(gateway,/action\.type !== 'set_value' && action\.type !== 'invoke'/);
 assert.match(gateway,/'object-act', '--desktop-object', desktopObjectName/);
 assert.match(gateway,/'--value64', encodeUtf8\(action\.value\)/);
});
