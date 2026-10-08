import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { buildDesktop2BackgroundInputArgs } from '../src/desktop2-background-input.js';

const desktop2 = 'd81244e4-e0c5-456f-a707-2b685a00662c';
const hwnd = 125476;
const pid = 2158;

test('background input always requires explicit Desktop2 GUID + verified HWND owner PID', () => {
  assert.deepEqual(buildDesktop2BackgroundInputArgs(hwnd,pid,desktop2,{type:'click',x:50,y:60}),[
    'background-input','--hwnd',String(hwnd),'--pid',String(pid),'--desktop-id',desktop2,'--action','click','--x','50','--y','60'
  ]);
  for(const invalid of [
    {hwnd:0,pid,desktopId:desktop2},
    {hwnd,pid:0,desktopId:desktop2},
    {hwnd,pid,desktopId:'invalid'},
  ]) {
    assert.throws(()=>buildDesktop2BackgroundInputArgs(invalid.hwnd,invalid.pid,invalid.desktopId,{type:'click',x:1,y:2}));
  }
});

test('desktop2 input rejects malformed coordinates, wheel, text, key and drag before invoking any native code',()=>{
  const bad = [
    {type:'click',x:-1,y:1},
    {type:'click',x:1.2,y:1},
    {type:'move',x:99999,y:1},
    {type:'drag',x:1,y:1,toX:2,toY:3,steps:120},
    {type:'wheel',x:1,y:1,delta:0},
    {type:'wheel',x:1,y:1,delta:6000},
    {type:'text',text:''},
    {type:'text',text:'A\u0000'},
    {type:'key',vk:-1},
    {type:'key',vk:300},
  ];
  for(const action of bad) {
    assert.throws(()=>buildDesktop2BackgroundInputArgs(hwnd,pid,desktop2,action as Parameters<typeof buildDesktop2BackgroundInputArgs>[3]));
  }
});

test('background message input supports guest-independent coordinates, double/right click, drag, wheel, keyboard',()=>{
  const actions = [
    {type:'move',x:13,y:17},
    {type:'right-click',x:13,y:17},
    {type:'double-click',x:13,y:17},
    {type:'drag',x:10,y:12,toX:80,toY:90,steps:6},
    {type:'wheel',x:100,y:150,delta:-120},
    {type:'key',vk:65},
    {type:'text',text:'中文 Hello!'}
  ] as const;
  const encoded = actions.map(a=>buildDesktop2BackgroundInputArgs(hwnd,pid,desktop2,a));
  assert.deepEqual(encoded.map(row=>row[row.indexOf('--action')+1]),actions.map(a=>a.type));
  assert.ok(encoded.every(row=>row[0]==='background-input'&&!row.includes('send-input')));
  assert.deepEqual(encoded[3]?.slice(-4),['--to-y','90','--steps','6']);
});

test('native implementation checks Desktop2 and pinned-window exposure before any bounded input',async()=>{
  const root=process.cwd();
  const cs=await readFile(path.join(root,'agent-desktop-host','BackgroundWindowInput.cs'),'utf8');
  const program=await readFile(path.join(root,'agent-desktop-host','Program.cs'),'utf8');
  assert.match(program,/"background-input" => BackgroundWindowInput\.Apply/);
  assert.match(cs,/targetDesktop\.Value < 1/);
  assert.match(cs,/manager\.GetWindowDesktopId\(root\) != desktopId/);
  assert.match(cs,/manager\.IsWindowOnCurrentVirtualDesktop\(root\)/);
  assert.match(cs,/childPid != unchecked\(\(uint\)expectedProcessId\)/);
  assert.match(cs,/GetAncestor\(hwnd, GaRoot\)/);
  assert.match(cs,/SendMessageTimeoutW\(/);
  assert.match(cs,/confirmedAppState = false/);
  for(const forbidden of ['SendInput(','SwitchDesktop(','SetCursorPos(','SetForegroundWindow(','GoToDesktopNumber(']){
    assert.equal(cs.includes(forbidden),false,'native input must not call host-input/desktop-switch API: '+forbidden);
  }
});

test('agent bridge refuses current-desktop pinned windows and does not expose source-only route via MCP',async()=>{
  const root=process.cwd();
  const bridge=await readFile(path.join(root,'src','agent-desktop-native.ts'),'utf8');
  const tools=await readFile(path.join(root,'src','computer-use-tools.ts'),'utf8');
  assert.match(bridge,/state\.currentDesktopNumber !== 1/);
  assert.match(bridge,/info\.onCurrentDesktop === true/);
  assert.match(bridge,/Pinned\/shared window is visible on Desktop 1/);
  assert.match(bridge,/after\.currentDesktopNumber !== 1/);
  assert.match(bridge,/Owner desktop changed or could not be checked after background input/);
  assert.doesNotMatch(tools,/backgroundWindowMessage\(/);
});

test('background invoke-button uses only strict Win32/WinForms Button HWND and never physical click',async()=>{
  assert.deepEqual(buildDesktop2BackgroundInputArgs(hwnd,pid,desktop2,{type:'invoke-button'}),[
    'background-input','--hwnd',String(hwnd),'--pid',String(pid),'--desktop-id',desktop2,'--action','invoke-button'
  ]);
  const cs=await readFile(path.join(process.cwd(),'agent-desktop-host','BackgroundWindowInput.cs'),'utf8');
  assert.match(cs,/const uint BmClick = 0x00F5/);
  assert.match(cs,/GetClassNameW\(hwnd/);
  assert.match(cs,/WindowsForms10\.BUTTON/);
  assert.match(cs,/hwnd == root \|\| !IsWindowEnabled\(hwnd\)/);
  assert.match(cs,/Deliver\(hwnd, BmClick, 0, IntPtr.Zero\)/);
});
