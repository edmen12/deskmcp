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

test('ownerless safety HWNDs are default and preserve fail-closed checks',()=>{
  assert.doesNotMatch(source,/DESKTOP_MCP_AGENT_DESKTOP_OWNERLESS_SAFETY_WINDOWS_EXPERIMENT/);
  assert.match(source,/ownerlessShellWindows = true;/);
  assert.equal((source.match(/ShowInTaskbar = ownerlessShellWindows/g) ?? []).length,2);
  assert.match(source,/if \(!safetyOverlay\.IsOnDesktop\(desktopId\)\)/);
  assert.match(source,/TryRevokeAfterSafetyFailure\(checkedLeaseId, error\.Message\)/);
  assert.match(source,/ShowActivated = false/);
  assert.match(source,/StartEdgePulse\(edgeWindow\)/);
});

test('isolated native-overlay acceptance does not create a Gateway or lease',()=>{
  const src=readFileSync(path.join(PROJECT_ROOT,'control-panel','wpf',
    'AgentDesktopOverlayIsolatedProbe.cs'),'utf8');
  const host=readFileSync(path.join(PROJECT_ROOT,'control-panel','wpf',
    'DeskMCPControlPanel.cs'),'utf8');
  assert.match(host,/--agent-desktop-overlay-isolated-probe/);
  assert.match(src,/new AgentDesktopOverlay\(/);
  assert.match(src,/DESKTOP_MCP_DATA_ROOT/);
  assert.match(src,/EXACT_CANDIDATE_DATA_ROOT_REQUIRED/);
  assert.match(src,/DESKTOP_MCP_INSTANCE_NAMESPACE/);
  assert.match(src,/SYNTHETIC_HUD_BUTTON_EVENT/);
  assert.match(src,/ForegroundWatcher/);
  assert.match(src,/DwmGetWindowAttribute/);
  assert.match(src,/edge_dwm_cloaked != 2/);
  assert.match(src,/hud_dwm_cloaked != 2/);
  assert.match(src,/GetWindow\(windows\.edge,4\)/);
  assert.match(src,/GetWindow\(windows\.hud,4\)/);
  assert.doesNotMatch(src,/GoToDesktopNumber\(|StartGateway\(|new AgentDesktopControlCoordinator\(/);
  assert.doesNotMatch(src,/WriteAllText\(.*control\.json|RevokeControl\(/);
});

test('isolated Coordinator drives the real HUD heartbeat without touching the live Gateway',()=>{
  const src=readFileSync(path.join(PROJECT_ROOT,'control-panel','wpf',
    'AgentDesktopCoordinatorIsolatedProbe.cs'),'utf8');
  const host=readFileSync(path.join(PROJECT_ROOT,'control-panel','wpf',
    'DeskMCPControlPanel.cs'),'utf8');
  assert.match(host,/--agent-desktop-coordinator-isolated-probe/);
  assert.match(src,/new AgentDesktopControlCoordinator\(/);
  assert.match(src,/GetMethod\("Tick"/);
  assert.match(src,/DESKTOP_MCP_DATA_ROOT/);
  assert.match(src,/EXACT_PRIVATE_TEST_ROOT_REQUIRED/);
  assert.match(src,/ISOLATED_ROOT_HAS_ACTIVE_CONTROL/);
  assert.match(src,/Heartbeat\(hudPath,lease,generation/);
  assert.match(src,/control_panel_manual_exit/);
  assert.match(src,/ButtonBase\.ClickEvent/);
  assert.match(src,/Shutdown\(true\)/);
  assert.doesNotMatch(src,/RegisterDesktopSwitchNotifications\(\)|GoToDesktopNumber\(|StartGateway\(/);
  assert.doesNotMatch(src,/new ControlPanelRuntime\(/);
});

test('cross-process Manager and single-tool MCP proof remain confined to a private test root',()=>{
  const probe=readFileSync(path.join(PROJECT_ROOT,'control-panel','wpf',
    'AgentDesktopManagerHandoffIsolatedProbe.cs'),'utf8');
  const manager=readFileSync(path.join(PROJECT_ROOT,'test-area','ownerless-gateway-handoff',
    'manager-handoff.mjs'),'utf8');
  const mcp=readFileSync(path.join(PROJECT_ROOT,'test-area','ownerless-gateway-handoff',
    'mcp-handoff.mjs'),'utf8');
  const source=readFileSync(path.join(PROJECT_ROOT,'control-panel','wpf',
    'DeskMCPControlPanel.cs'),'utf8');
  assert.match(source,/--agent-desktop-manager-handoff-isolated-probe/);
  assert.match(probe,/EXACT_TEST_DATA_ROOT_REQUIRED/);
  assert.match(probe,/NATIVE_DESKTOP_SWITCH_HOOK_NOT_REGISTERED/);
  assert.match(probe,/coordinator\.Start\(\)/);
  assert.match(probe,/HUD_HEARTBEAT_INVARIANT_FAILED/);
  assert.match(manager,/new AgentDesktopManager\(/);
  assert.match(manager,/startControl\(/);
  assert.match(manager,/stopControl\(/);
  assert.match(mcp,/registerAgentDesktopTools\(/);
  assert.match(mcp,/tools\.length/);
  assert.match(mcp,/127\.0\.0\.1/);
  assert.match(mcp,/otherToolsExposed/);
  assert.match(mcp,/callTool\(/);
  assert.doesNotMatch(mcp,/createDesktopMcpServer\(|DesktopBackendBridge\(|GoToDesktopNumber\(/);
});
test('unsafe taskbar DeleteTab experiment stays absent from safety overlays',()=>{
  assert.doesNotMatch(source,/ITaskbarList|HideOnlyOwnSafetyTaskbarButton|TASKBAR_HIDE_EXPERIMENT/);
  const observer=readFileSync(path.join(PROJECT_ROOT,'test-area','ownerless-gateway-handoff',
    'taskbar-privacy-observer.ps1'),'utf8');
  assert.match(observer,/GrabOnlyCenterTaskbar/);
  assert.match(observer,/changedPixels/);
  assert.match(observer,/screenshotsSaved=0/);
});

test('real HUD Exit via UIA Invoke provider is scoped and waits for its dispatcher callback',()=>{
  const src=readFileSync(path.join(PROJECT_ROOT,'control-panel','wpf',
    'AgentDesktopOverlayIsolatedProbe.cs'),'utf8');
  assert.match(src,/OWN_HUD_UIA_PROVIDER_INVOKE/);
  assert.match(src,/new ButtonAutomationPeer\(exit\)/);
  assert.match(src,/PatternInterface\.Invoke/);
  assert.match(src,/IInvokeProvider/);
  assert.match(src,/awaitingUiaExit=true/);
  assert.match(src,/HUD_UIA_CALLBACK_TIMED_OUT/);
  assert.match(src,/owner_desktop1/);
  assert.match(src,/own_foreground_events/);
  assert.doesNotMatch(src,/SetForegroundWindow\(|SendInput\(|SwitchDesktop\(/);
});
test('full candidate Gateway smoke uses strict read-only loopback and private audit',()=>{
  const ps1=readFileSync(path.join(PROJECT_ROOT,'test-area',
    'ownerless-gateway-handoff','full-readonly-runtime.ps1'),'utf8');
  const js=readFileSync(path.join(PROJECT_ROOT,'test-area',
    'ownerless-gateway-handoff','full-readonly-client.mjs'),'utf8');
  const visual=readFileSync(path.join(PROJECT_ROOT,'test-area',
    'ownerless-gateway-handoff','taskbar-all-observer.ps1'),'utf8');
  assert.match(ps1,/DESKTOP_MCP_PROFILE='read-only'/);
  assert.match(ps1,/DESKTOP_MCP_DATA_ROOT/);
  assert.match(ps1,/DESKTOP_MCP_ALLOWED_ROOTS/);
  assert.match(ps1,/DESKTOP_MCP_AUDIT_LOG/);
  assert.match(ps1,/127\.0\.0\.1/);
  assert.match(ps1,/Get-NetTCPConnection/);
  assert.match(ps1,/dist\/src\/stop\.js/);
  assert.match(js,/readOnlyComputerUseDenied/);
  assert.match(js,/unauthorizedLeaseAllocationDenied/);
  assert.match(visual,/imagesSaved=0/);
  assert.match(visual,/privateOnly/);
  assert.doesNotMatch(visual,/\.Save\(|WriteAllBytes|Copy-Item.*\.png/);
});

test('MCP-issued lease can be revoked by own WPF UIA Exit without global input or an explicit Node stop',()=>{
  const wpf=readFileSync(path.join(PROJECT_ROOT,'control-panel','wpf',
    'AgentDesktopManagerHandoffIsolatedProbe.cs'),'utf8');
  const node=readFileSync(path.join(PROJECT_ROOT,'test-area','ownerless-gateway-handoff',
    'mcp-hud-uia-exit.mjs'),'utf8');
  assert.match(wpf,/OWN_HUD_UIA_EXIT/);
  assert.match(wpf,/new ButtonAutomationPeer\(exit\)/);
  assert.match(wpf,/PatternInterface\.Invoke/);
  assert.match(wpf,/UIA_EXIT_DESKTOP2_PRECONDITION_FAILED/);
  assert.match(wpf,/control_panel_manual_exit/);
  assert.match(wpf,/uia_exit_mutation_confirmed/);
  assert.match(node,/registerAgentDesktopTools\(/);
  assert.match(node,/toolCount!==1/);
  assert.match(node,/MCP_LEASE_OWN_HUD_UIA_EXIT_PASS/);
  assert.match(node,/manualExitJournalVerified/);
  assert.match(node,/staleLeaseRejected/);
  assert.match(node,/hudHeartbeatFileRemoved/);
  assert.match(node,/if\(await manager\.isLeaseActive\(lease\)\)await manager\.stopControl\(lease\)/);
  assert.doesNotMatch(wpf,/SendInput\(|SetForegroundWindow\(|GoToDesktopNumber\(/);
});

test('full candidate Gateway Full Control proof remains private and preserves the installed program',()=>{
  const runner=readFileSync(path.join(PROJECT_ROOT,'test-area','ownerless-gateway-handoff',
    'full-control-runtime.ps1'),'utf8');
  const client=readFileSync(path.join(PROJECT_ROOT,'test-area','ownerless-gateway-handoff',
    'full-control-client.mjs'),'utf8');
  assert.match(runner,/DESKTOP_MCP_PROFILE='full-control'/);
  assert.match(runner,/DESKTOP_MCP_ALLOWED_ROOTS/);
  assert.match(runner,/DESKTOP_MCP_AUDIT_LOG/);
  assert.match(runner,/FULL_CONTROL_GATEWAY_MCP_HUD_UIA_EXIT_PASS/);
  assert.match(runner,/Get-FileHash/);
  assert.match(runner,/productionControlUnchanged/);
  assert.match(runner,/installedControlPanelUnchanged/);
  assert.match(runner,/Get-NetTCPConnection/);
  assert.match(runner,/dist\/src\/stop\.js/);
  assert.match(runner,/wpfRealCoordinatorStarted/);
  assert.match(runner,/wpfExitedCleanly/);
  assert.match(client,/desktop_agent_desktop/);
  assert.match(client,/control_panel_manual_exit/);
  assert.match(client,/otherToolCallsMade:false/);
  assert.match(client,/controlStoppedByNode:false/);
  assert.doesNotMatch(runner,/Stop-Process -Name DeskMCP|GoToDesktopNumber\(|SwitchDesktop\(/);
});
test('exact installed rollback snapshot and isolated installer failure tests cannot overwrite production',()=>{
  const recovery=readFileSync(path.join(PROJECT_ROOT,'test-area','ownerless-gateway-handoff',
    'prepare-exact-rollback.ps1'),'utf8');
  const regression=readFileSync(path.join(PROJECT_ROOT,'test-area','ownerless-gateway-handoff',
    'verify-isolated-installer-rollback.ps1'),'utf8');
  assert.match(recovery,/RECOVERY_SNAPSHOT_ALREADY_EXISTS_REFUSE_OVERWRITE/);
  assert.match(recovery,/Assert-Manifest/);
  assert.match(recovery,/Get-FileHash/);
  assert.match(recovery,/robocopy\.exe/);
  assert.match(recovery,/fileNamesAndSizesEqual/);
  assert.match(recovery,/snapshotManifestChecked/);
  assert.match(regression,/--install-test-fail-after-backup/);
  assert.match(regression,/--recover-test/);
  assert.match(regression,/Simulated sudden power loss/);
  assert.match(regression,/WindowStyle Hidden/);
  assert.match(regression,/productionStateUnchanged/);
  assert.match(regression,/productionProcessPreserved/);
  assert.match(regression,/sourceReleaseIsNotCandidate/);
  assert.doesNotMatch(regression,/--install-current-user|Stop-Process -Name DeskMCP/);
});

test('patched Zod4 retains the vendored Desktop Commander V3 MCP argument schemas',async()=>{
  const pkg=JSON.parse(readFileSync(path.join(PROJECT_ROOT,'package.json'),'utf8'));
  const vendorPkg=JSON.parse(readFileSync(path.join(PROJECT_ROOT,'vendor',
    'desktop-commander','package.json'),'utf8'));
  const lock=JSON.parse(readFileSync(path.join(PROJECT_ROOT,'package-lock.json'),'utf8'));
  assert.equal(pkg.dependencies.zod,'4.6.7');
  assert.equal(vendorPkg.dependencies.zod,'^4.6.7');
  assert.equal(lock.packages['node_modules/zod']?.version,'4.6.7');
  assert.equal(lock.packages['vendor/desktop-commander/node_modules/zod'],undefined);
  const {pathToFileURL}=await import('node:url');
  const src=path.join(PROJECT_ROOT,'vendor','desktop-commander','dist','tools','schemas.js');
  assert.match(readFileSync(src,'utf8'),/from "zod\/v3"/);
  const mod=await import(pathToFileURL(src).href);
  const {zodToJsonSchema}=await import('zod-to-json-schema');
  assert.equal(mod.ReadFileArgsSchema.safeParse({path:'test-only.txt'}).success,true);
  assert.equal(mod.ReadFileArgsSchema.safeParse({path:123}).success,false);
  assert.equal(mod.StartProcessArgsSchema.safeParse({command:'echo demo',timeout_ms:1000}).success,true);
  assert.equal(mod.StartProcessArgsSchema.safeParse({command:'echo demo'}).success,false);
  const file=JSON.parse(JSON.stringify(zodToJsonSchema(mod.ReadFileArgsSchema)));
  const process=JSON.parse(JSON.stringify(zodToJsonSchema(mod.StartProcessArgsSchema)));
  assert.equal(file.type,'object');
  assert.equal(file.properties.path.type,'string');
  assert.ok(file.required.includes('path'));
  assert.equal(process.properties.command.type,'string');
  assert.ok(process.required.includes('command'));
  assert.ok(process.required.includes('timeout_ms'));
});

test('unsigned candidate PackageOnly is explicitly opted in and cannot claim installer smoke success',()=>{
  const script=readFileSync(path.join(PROJECT_ROOT,'scripts','build-installer.ps1'),'utf8');
  const smoke=readFileSync(path.join(PROJECT_ROOT,'scripts','test-release-stage.ps1'),'utf8');
  assert.match(script,/\[switch\]\$PackageOnly/);
  assert.match(script,/\$PackageOnly -and -not \$SkipStage/);
  assert.match(script,/DESKMCP_PACKAGE_ONLY_ACK/);
  assert.match(script,/UNQUALIFIED_NO_GUI_ARTIFACT/);
  assert.match(script,/SETUP_PACKAGE_ONLY_UNQUALIFIED=TRUE/);
  assert.match(script,/PUBLIC_RELEASE_READY=FALSE/);
  assert.match(script,/INSTALLER_GUI_SMOKE=NOT_RUN/);
  const gate=script.indexOf("if ($PackageOnly) {");
  const normalSmoke=script.indexOf("Write-Output 'STEP=installer-smoke-single-instance'");
  assert.ok(gate>0 && normalSmoke>gate);
  assert.match(script.slice(gate,normalSmoke),/return/);
  assert.doesNotMatch(script.slice(gate,normalSmoke),/--startup|--install-current-user/);
  assert.equal((smoke.match(/TOOLS=29/g)||[]).length,2);
  assert.doesNotMatch(smoke,/TOOLS=27/);
});
