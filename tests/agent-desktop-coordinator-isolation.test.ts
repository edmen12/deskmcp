import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root=process.cwd();
const source=readFileSync(path.join(root,'test-area','ego-wpf-candidate-coordinator-probe.cs'),'utf8');
const bootstrap=readFileSync(path.join(root,'test-area','ego-wpf-candidate-bootstrap.cs'),'utf8');
const builder=readFileSync(path.join(root,'test-area','build-ego-wpf-hud-candidate.ps1'),'utf8');
const runner=readFileSync(path.join(root,'test-area','ego-wpf-coordinator-live.ps1'),'utf8');

test('candidate WPF ControlCoordinator probe uses private control lock and HUD state, never starts second panel',()=>{
 assert.match(source,/candidate-coordinator-state-/);
 assert.match(source,/Path\.Combine\(isolated,"agent-desktop"\)/);
 assert.match(source,/Path\.Combine\(agentDir,"control\.json"\)/);
 assert.match(source,/Path\.Combine\(agentDir,"hud-state\.json"\)/);
 assert.match(source,/GetMethod\("Tick",BindingFlags\.NonPublic/);
 assert.match(source,/tick\.Invoke\(coordinator,null\)/);
 assert.doesNotMatch(source,/coordinatorType\.GetMethod\("Start"/);
 assert.doesNotMatch(source,/\.Start\(\)\s*;/);
 assert.doesNotMatch(source,/\bRegisterDesktopSwitchHook\s*\(/);
 assert.doesNotMatch(source,/\bGoToDesktopNumber\s*\(/);
});

test('candidate WPF Coordinator requires live production lease but revokes only private synthetic state',()=>{
 assert.match(source,/private static bool StillOwned\(/);
 assert.match(source,/if\(!StillOwned\(realLease,desktop\)\)return 3/);
 assert.match(source,/File\.WriteAllText\(config,/);
 assert.match(source,/File\.WriteAllText\(control,/);
 assert.match(source,/IsCandidateHudFresh\(hud,ownLease\)/);
 assert.match(source,/File\.WriteAllText\(config,"\{\\"schemaVersion/);
 assert.match(source,/local_leases_after_fault/);
 assert.match(source,/Directory\.Delete\(isolated,recursive:true\)/);
 assert.match(bootstrap,/--coordinator-isolated-probe/);
 assert.match(builder,/ego-wpf-candidate-coordinator-probe\.cs/);
 assert.match(runner,/DESKTOP_1_BEFORE_AFTER_UNCHANGED=PASS/);
});
