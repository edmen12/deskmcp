import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const app=await readFile(path.join(here,'../desktop2-wpf-probe/Program.cs'),'utf8');
const policy=await readFile(path.join(here,'../desktop2-wpf-probe/OwnedWpfCommandPolicy.cs'),'utf8');
const runner=await readFile(path.join(here,'run-wpf-app-owned-once.mjs'),'utf8');

test('WPF actions execute on the owned Dispatcher and not through UIAutomation',()=>{
 assert.match(app,/Dispatcher\.InvokeAsync/);
 assert.match(app,/PipeOptions\.CurrentUserOnly/);
 assert.match(app,/OwnedWpfCommandPolicy\.Authorize/);
 assert.match(policy,/CryptographicOperations\.FixedTimeEquals/);
 assert.match(policy,/STALE_OR_REPLAYED_COMMAND/);
 assert.match(policy,/STALE_OR_INVALID_EDIT/);
 assert.match(app,/Native\.GetForegroundWindow\(\)==rootHwnd/);
 assert.doesNotMatch(app,/ValuePattern\.SetValue|SendInput\(|SetForegroundWindow\(|SwitchDesktop\(/);
});
test('WPF fixture starts nonactivating and cloaked, reports exact identity',()=>{
 assert.match(app,/Native\.MakeNonActivating\(rootHwnd\)/);
 assert.match(app,/DwmSetWindowAttribute\(rootHwnd,13,ref cloak,4\)/);
 assert.match(app,/rootNoActivate=Native\.HasNoActivate\(rootHwnd\)/);
 assert.match(runner,/first\.rootNoActivate!==true/);
 assert.match(runner,/first\.pid!==child\.pid/);
});
test('WPF orchestrator guards lease, watcher, memory and teardown',()=>{
 assert.match(runner,/requireSafeNativeGuiMemory\(\)/);
 assert.match(runner,/await session\.start\(\)/);
 assert.match(runner,/session\.dispatch\(\{phase:'arm'/);
 assert.match(runner,/await guard\('BEFORE_'\+sequence\)/);
 assert.match(runner,/await guard\('AFTER_'\+sequence\)/);
 assert.match(runner,/await terminateOwnedChild\(child/);
 assert.match(runner,/await session\.stop\(\)/);
 assert.match(runner,/leaseHeldThroughTeardown/);
 assert.doesNotMatch(runner,/sendInput\(|SendInput\(|SwitchDesktop\(/);
});
test('App callbacks and stale-write rejection are required, not pipe ack alone',()=>{
 assert.match(runner,/STALE_WPF_EDIT_NOT_REJECTED/);
 assert.match(runner,/APP_EDIT=D2_WPF_DISPATCHER_OK/);
 assert.match(runner,/APP_CLICK=1/);
 assert.match(runner,/APP_SCROLLED=/);
 assert.match(runner,/WPF_APP_CALLBACK_OR_FOCUS_WITNESS_FAILED/);
 assert.match(runner,/result\.pass=Boolean\(result\.pass/);
});
