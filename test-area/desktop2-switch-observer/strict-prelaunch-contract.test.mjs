import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..');
const source=readFileSync(path.join(here,'Program.cs'),'utf8');
const lifecycle=readFileSync(path.join(root,'src','desktop2-observer-lifecycle.ts'),'utf8');
const runner=readFileSync(path.join(root,'test-area','desktop2-real-acceptance',
  'strict-prelaunch-watch-once.mjs'),'utf8');

test('external launch watchdog sets strict WinEvent foreground hook before readiness',()=>{
 const hook=source.indexOf('foregroundHook = SetWinEventHook(');
 const mark=source.indexOf('strictForegroundArmed = strictPrelaunch');
 const baseline=source.indexOf('baselineForeground = GetForegroundWindow()');
 const verify=source.indexOf('STRICT_LAUNCH_FOREGROUND_CHANGED_BEFORE_READY');
 assert.ok(baseline>0&&hook>baseline&&verify>hook&&mark>verify);
 assert.match(source,/STRICT_PRELAUNCH_FOREGROUND_EARLY_ABORT/);
 assert.match(source,/STRICT_PRELAUNCH_FOREGROUND_POLL_ABORT/);
 assert.match(source,/strictLaunch = args.Length == 6 && args\[0\] == "--observe-strict-launch"/);
 assert.match(source,/strictPrelaunch && !policy.Aborted/);
});

test('strict observer ready cannot be faked by legacy target-mode watcher',()=>{
 assert.match(lifecycle,/this\.strictPrelaunch \? '--observe-strict-launch' : '--observe-target'/);
 assert.match(lifecycle,/this\.strictPrelaunch && ready\.strictForegroundArmed!==true/);
 assert.match(lifecycle,/!this\.strictPrelaunch && ready\.strictForegroundArmed===true/);
});

test('real Windows monitoring smoke cannot spawn GUI, move window or send global input',()=>{
 for(const bad of [/\bspawn\s*\(/,/\.moveWindow\s*\(/,
  /\.moveProcessTreeWindows\s*\(/,/\.dispatch\s*\(/,
  /\bSetForegroundWindow\s*\(/,/\bSendInput\s*\(/]) {
    assert.doesNotMatch(runner,bad);
 }
 assert.match(runner,/requireSafeNativeGuiMemory/);
 assert.match(runner,/await watcher\.start\(lease\)/);
 assert.match(runner,/strictArmed/);
 assert.match(runner,/await watcher\.stop\(\)/);
});
