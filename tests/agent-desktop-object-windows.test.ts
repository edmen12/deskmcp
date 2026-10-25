import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const native=readFileSync(path.join(process.cwd(),'agent-desktop-host','Program.cs'),'utf8');
const start=native.indexOf('private static object ObjectWindows(string desktopObject)');
const end=native.indexOf('private static object SelfTest(',start);
const method=native.slice(start,end);

test('isolated Win32 Desktop Object enumeration must not discard non-input desktop HWNDs via IsWindowVisible',()=>{
 assert.ok(start>0&&end>start,'private desktop native enumerator exists');
 assert.match(method,/OpenDesktopW\(desktopObject,/u);
 assert.match(method,/EnumDesktopWindows\(desktop,/u);
 assert.match(method,/if \(!IsWindow\(hwnd\)\) return true/u);
 assert.doesNotMatch(method,/IsWindowVisible\(hwnd\)/u);
 assert.match(method,/GetWindowThreadProcessId\(hwnd, out uint processId\)/u);
 assert.match(method,/GetWindowRect\(hwnd, out Rect rect\)/u);
 assert.match(method,/isForeground = false/u);
});
