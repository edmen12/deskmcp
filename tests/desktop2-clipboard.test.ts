import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {AgentClipboardStore,assertNoSystemClipboardChord} from '../src/desktop2-clipboard.js';

const a='11111111-1111-4111-8111-111111111111';
const b='22222222-2222-4222-8222-222222222222';

test('separate Agent leases never share clipboard contents',()=>{
  const clip=new AgentClipboardStore();
  clip.put(a,'Agent One 中文');
  assert.throws(()=>clip.read(b),/empty or expired/);
  clip.put(b,'Agent Two');
  assert.equal(clip.read(a),'Agent One 中文');
  assert.equal(clip.read(b),'Agent Two');
  clip.clearLease(a);
  assert.throws(()=>clip.read(a),/empty or expired/);
  assert.equal(clip.read(b),'Agent Two');
  clip.clearAll();
  assert.throws(()=>clip.read(b),/empty or expired/);
});

test('Agent clipboard validates size/identity and expires without disk',()=>{
  let now=1000;
  const clip=new AgentClipboardStore(()=>now);
  assert.throws(()=>clip.put('wrong','data'),/valid bound desktop lease/);
  assert.throws(()=>clip.put(a,'x'.repeat(4097)),/4096/);
  clip.put(a,'hello');
  now+=15*60*1000;
  assert.throws(()=>clip.read(a),/expired/);
});

test('Agent browser blocks OS clipboard shortcuts but allows ordinary shortcuts',()=>{
  for(const key of [
    'Control+C','Control+V','Control+X','ControlOrMeta+V','Meta+C',
    'Cmd+X','Shift+Insert','Ctrl+Insert','Ctrl+Shift+V',' Control + v '
  ]) assert.throws(()=>assertNoSystemClipboardChord(key),/clipboard shortcuts are blocked/,key);
  for(const key of ['Control+A','Control+Z','Alt+ArrowLeft','Shift+ArrowRight','Enter','Tab'])
    assert.doesNotThrow(()=>assertNoSystemClipboardChord(key),key);
});

test('clipboard implementation has no OS clipboard access or native input commands',async()=>{
  const text=await readFile(path.join(process.cwd(),'src','desktop2-clipboard.ts'),'utf8');
  const play=await readFile(path.join(process.cwd(),'src','browser-playwright.ts'),'utf8');
  assert.ok(play.includes('locator.fill(expected'));
  assert.ok(play.includes('locator.inputValue('));
  assert.ok(play.includes('Agent paste did not reach the target input'));
  assert.ok(play.includes('copyElementText'));
  for(const forbidden of ['OpenClipboard(', 'SetClipboardData(', 'GetClipboardData(', 'Clipboard.SetText(', 'navigator.clipboard.', 'SendInput('])
    assert.equal(text.includes(forbidden),false,forbidden);
});
