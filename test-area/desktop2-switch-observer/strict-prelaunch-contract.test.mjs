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
 assert.match(lifecycle,/ready\.strictForegroundArmed!==true/);
 assert.match(lifecycle,/!this\.strictPrelaunch && ready\.strictForegroundArmed===true/);
});

test('real Windows monitoring smoke cannot spawn GUI, move window or send global input',()=>{
 for(const bad of [/\bspawn\s*\(/,/\.moveWindow\s*\(/,
  /\.moveProcessTreeWindows\s*\(/,/\.dispatch\s*\(/,
  /\bSetForegroundWindow\s*\(/,/\bSendInput\s*\(/]) {
    assert.doesNotMatch(runner,bad);
 }
 assert.match(runner,/requireSafePassiveObserverMemory/);
 assert.match(runner,/await watcher\.start\(lease\)/);
 assert.match(runner,/strictArmed/);
 assert.match(runner,/await watcher\.stop\(\)/);
});

test('ready marker is emitted only after first pumped native heartbeat and verified by lease',()=>{
 const heart=source.indexOf('private void Heartbeat()');
 const ready=source.indexOf('File.WriteAllText(readyFile, JsonSerializer.Serialize(');
 const published=source.indexOf('messagePumpRunning = true');
 const constructor=source.indexOf('public DesktopEventListener(');
 assert.ok(constructor>0&&heart>constructor&&ready>heart&&published>ready);
 assert.equal(source.indexOf('File.WriteAllText(readyFile,'),ready);
 assert.match(source,/!readyPublished && !policy.Aborted/);
 assert.match(source,/STRICT_READY_FOREGROUND_RECHECK_ABORT/);
 assert.match(source,/Log\("READY_AFTER_MESSAGE_PUMP"/);
 assert.match(lifecycle,/ready.messagePumpRunning!==true/);
});

test('strict mode latches top-level SHOW before HWND identity is known',()=>{
 assert.match(source,/WindowShowEvent = 0x8002/);
 assert.match(source,/SetWinEventHook\(WindowShowEvent, WindowShowEvent/);
 assert.match(source,/GetAncestor\(hwnd, 2\) != hwnd/);
 assert.match(source,/PRELAUNCH_VISIBLE_ROOT/);
 assert.match(source,/strictWindowShowArmed = strictPrelaunch && windowShowHook != IntPtr.Zero/);
 assert.match(lifecycle,/ready.strictWindowShowArmed!==true/);
});

test('external Winver one-shot does not show windows, use system input, or operate user files',()=>{
 const winver=readFileSync(path.join(root,'test-area','desktop2-real-acceptance',
   'winver-hidden-move-once.mjs'),'utf8');
 for(const re of [/\.showNoActivate\s*\(/,/\bSetForegroundWindow\s*\(/,
  /\bSendInput\s*\(/,/\.dispatch\s*\(/,/\bSetClipboardData\s*\(/,
  /\bexecSync\s*\(/,/\bkillall\s*\(/]) assert.doesNotMatch(winver,re);
 assert.match(winver,/await watcher.start\(lease\)/);
 assert.match(winver,/await requireSafeNativeGuiMemory\(\)/);
 assert.match(winver,/probe-hidden-winver/);
 assert.match(winver,/windowsHide:true/);
 assert.match(winver,/native.moveWindow\(discovered.hwnd,state.binding.desktopId\)/);
 assert.match(winver,/settled.isVisible!==false/);
 assert.match(winver,/result.focusEvents===0/);
});

test('native window placement publishes a visibility readback without displaying GUI',()=>{
 const app=readFileSync(path.join(root,'agent-desktop-host','Program.cs'),'utf8');
 const section=app.slice(app.indexOf('private static object WindowInfo('),
   app.indexOf('private static object MoveProcess('));
 assert.match(section,/isVisible = IsWindowVisible\(hwnd\)/);
 assert.match(section,/MoveWindowCore\(hwnd, desktopId, desktopNumber.Value, restore, showNoActivate, vda\)/);
 assert.match(app,/if \(restore\)/);
 assert.match(app,/else if \(showNoActivate\)/);
});

test('native launcher captures the child handle before PID validation to prevent orphan observers',()=>{
 const lifecycleSource=readFileSync(path.join(root,'src','desktop2-observer-lifecycle.ts'),'utf8');
 const begin=lifecycleSource.indexOf('const child=this.launcher(this.observerExe,');
 const store=lifecycleSource.indexOf('this.child=child;',begin);
 const reject=lifecycleSource.indexOf('Passive observer did not return a native process ID.',begin);
 const catchCleanup=lifecycleSource.indexOf('try{await this.stop();}',begin);
 assert.ok(begin>=0&&store>begin&&reject>store&&catchCleanup>reject,
  'a child process without a PID must still be owned and explicitly stopped');
});
