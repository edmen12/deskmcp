import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Desktop2HandoffController } from '../src/desktop2-handoff.js';

const lease='11111111-1111-4111-8111-111111111111';
const desktop='22222222-2222-4222-8222-222222222222';
function controller() {return new Desktop2HandoffController(lease, desktop, 2);}

test('handoff refuses Desktop1 or invalid/non-lease desktop identities',()=>{
  assert.throws(()=>new Desktop2HandoffController(lease,desktop,1),/real Windows virtual Desktop 2/);
  assert.throws(()=>new Desktop2HandoffController('bad',desktop,2),/valid Agent lease/);
  assert.throws(()=>new Desktop2HandoffController(lease,'bad',2),/real Windows virtual Desktop 2/);
});

test('normal autonomous mode only allows exact lease and Desktop2 identity',()=>{
  const c=controller();
  assert.doesNotThrow(()=>c.assertAutonomous(lease,desktop));
  assert.throws(()=>c.assertAutonomous('33333333-3333-4333-8333-333333333333',desktop),/different/);
  assert.throws(()=>c.assertAutonomous(lease,'44444444-4444-4444-8444-444444444444'),/different/);
});

test('requesting login handoff immediately pauses Agent UI, never switches desktops',()=>{
  const c=controller();
  const req=c.requestHandoff('login','Please enter your account password on Desktop 2.');
  assert.equal(req.desktopNumber,2);
  assert.equal(req.leaseId,lease);
  assert.equal(c.status().phase,'handoff_requested');
  assert.throws(()=>c.assertAutonomous(lease,desktop),/paused/);
  assert.throws(()=>c.requestHandoff('permission','Approve authorization'),/already pending/);
  assert.throws(()=>c.ownerCompleteHandoff(req.requestId),/unauthorized/);
});

test('only owner acceptance enters human_control; agent cannot run until owner completes',()=>{
  const c=controller();
  const req=c.requestHandoff('verification','Complete the verification challenge.');
  assert.throws(()=>c.ownerAcceptHandoff('55555555-5555-4555-8555-555555555555'),/unauthorized/);
  assert.equal(c.ownerAcceptHandoff(req.requestId).phase,'human_control');
  assert.throws(()=>c.assertAutonomous(lease,desktop),/paused/);
  assert.throws(()=>c.ownerDismissHandoff(req.requestId),/unauthorized/);
  assert.equal(c.ownerCompleteHandoff(req.requestId).phase,'autonomous');
  assert.doesNotThrow(()=>c.assertAutonomous(lease,desktop));
  assert.throws(()=>c.ownerCompleteHandoff(req.requestId),/unauthorized/);
});

test('user can dismiss a pending request and cannot duplicate stale actions',()=>{
  const c=controller();
  const req=c.requestHandoff('manual_action','Please check application details.');
  assert.equal(c.ownerDismissHandoff(req.requestId).phase,'autonomous');
  assert.throws(()=>c.ownerAcceptHandoff(req.requestId),/unauthorized/);
  assert.doesNotThrow(()=>c.assertAutonomous(lease,desktop));
});

test('revoked lease permanently prevents GUI operations and all pending handoffs',()=>{
  const c=controller();
  const req=c.requestHandoff('permission','Please approve the connection.');
  assert.equal(c.revokeLease().phase,'revoked');
  assert.throws(()=>c.assertAutonomous(lease,desktop),/paused/);
  assert.throws(()=>c.ownerAcceptHandoff(req.requestId),/unauthorized/);
  assert.throws(()=>c.requestHandoff('login','Password required.'),/already pending or active/);
});

test('handoff reason, description and transition validation is bounded',()=>{
  const c=controller();
  assert.throws(()=>c.requestHandoff('other' as 'login','A valid description'),/Unsupported/);
  assert.throws(()=>c.requestHandoff('login','x'),/description/);
  assert.throws(()=>c.requestHandoff('login','line\nbreak'),/description/);
  assert.equal(c.status().phase,'autonomous');
});

test('candidate has no automatic switch or global input APIs',async()=>{
  const src=await readFile(path.join(process.cwd(),'src','desktop2-handoff.ts'),'utf8');
  for(const forbidden of ['SendInput(', 'SetCursorPos(', 'GoToDesktopNumber(', 'SwitchDesktop(', 'SetForegroundWindow(']) {
    assert.equal(src.includes(forbidden),false,'no OS/user-side switching or input from handoff state');
  }
  const code=await readFile(path.join(process.cwd(),'src','computer-use-tools.ts'),'utf8');
  assert.doesNotMatch(code,/ownerAcceptHandoff\(/);
  assert.doesNotMatch(code,/ownerCompleteHandoff\(/);
});
