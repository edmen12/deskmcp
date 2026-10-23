import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {PROJECT_ROOT} from '../src/paths.js';
import {AgentDesktopManager} from '../src/agent-desktop-state.js';
import type {AgentDesktopNativeBridge} from '../src/agent-desktop-native.js';

const source=readFileSync(path.join(PROJECT_ROOT,'control-panel','wpf',
  'AgentDesktopControl.cs'),'utf8');
test('Control Panel is an independent writer and all its mutating paths record provenance',()=>{
  assert.match(source,/private void TryRevokeAfterSafetyFailure/);
  assert.match(source,/RevokeControl\(leaseId, "control_panel_safety_revocation"\)/);
  assert.match(source,/RevokeAllControls\("control_panel_safety_revocation"\)/);
  assert.match(source,/RevokeAllControls\("control_panel_startup_reset"\)/);
  assert.match(source,/RevokeAllControls\("control_panel_shutdown"\)/);
  assert.match(source,/private void RevokeControl\(string leaseId, string reason = "control_panel_manual_exit"\)/);
  assert.match(source,/RecordMutation\(live, "control_panel_desktop_renumber", live\.Controls\.Count\)/);
  assert.match(source,/RecordMutation\(state, reason, before\)/);
  assert.match(source,/history\.Count > 32/);
  assert.match(source,/\[JsonPropertyName\("recentMutations"\)\]/);
  assert.match(source,/\[JsonPropertyName\("lastMutation"\)\]/);
});
test('safety checks never ignore HUD mismatch and supply edge/HUD identity diagnostics',()=>{
  assert.match(source,/safetyOverlay\.DescribeEdgeDesktop\(desktopId\)/);
  assert.match(source,/safetyOverlay\.DescribeHudDesktop\(desktopId\)/);
  assert.match(source,/DescribeOwnWindowDesktop\(Window window, Guid expectedDesktop\)/);
  assert.match(source,/desktop_id_unresolved/);
  assert.match(source,/wrong_desktop/);
  assert.match(source,/com_hresult_0x/);
  assert.match(source,/if \(!safetyOverlay\.IsOnDesktop\(desktopId\)\)/);
  assert.match(source,/TryRevokeAfterSafetyFailure\(checkedLeaseId, error\.Message\)/);
  const heartbeatBlock=source.slice(source.indexOf('private async void Tick()'),source.indexOf('private async Task EnsureSafetyOverlayAsync'));
  assert.doesNotMatch(heartbeatBlock,/GoToDesktopNumber\(/);
});
test('Gateway reads a Control Panel origin safety-revoke event chain without confusing it for its own init',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'deskmcp-controlpanel-history-'));
  try {
    const history=[
      {reason:'lease_allocated',generation:25,atUtc:new Date().toISOString(),
        beforeCount:0,afterCount:1,writerPid:345},
      {reason:'control_panel_safety_revocation',generation:26,
        atUtc:new Date().toISOString(),beforeCount:1,afterCount:0,writerPid:678}
    ];
    await writeFile(path.join(temp,'control.json'),JSON.stringify({
      schemaVersion:2,generation:26,controls:[],
      lastMutation:history[1],recentMutations:history
    }));
    const manager=new AgentDesktopManager(temp,{} as AgentDesktopNativeBridge);
    assert.deepEqual((await manager.recentControlMutations()).map(x=>x.reason),
      ['lease_allocated','control_panel_safety_revocation']);
    await manager.init();
    const again=JSON.parse(await readFile(path.join(temp,'control.json'),'utf8'));
    assert.equal(again.generation,26);
    assert.deepEqual(again.recentMutations,history);
  } finally {await rm(temp,{recursive:true,force:true});}
});
test('Control Panel emitted reason fields remain part of the candidate Gateway enum',async()=>{
  const sourceTs=readFileSync(path.join(PROJECT_ROOT,'src','agent-desktop-state.ts'),'utf8');
  for(const reason of ['control_panel_safety_revocation','control_panel_manual_exit',
    'control_panel_shutdown','control_panel_startup_reset','control_panel_desktop_renumber'])
    assert.match(sourceTs,new RegExp(reason));
});
