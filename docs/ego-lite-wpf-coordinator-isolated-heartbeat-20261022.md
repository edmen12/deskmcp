# DeskMCP candidate — WPF ControlCoordinator isolated heartbeat and revoke acceptance
Date: 2026-10-22 MYT. Branch review/ego-lite-session-gate-20261022.
STATUS: ONE LIVE INTEGRATION PASS; candidate only, no install, no main merge or push.

## New isolated ControlCoordinator integration harness
New test-area/ego-wpf-candidate-coordinator-probe.cs is compiled into the same standalone test-only WPF runtime as existing HUD component probe. It calls the REAL AgentDesktopControlCoordinator constructor and its private Tick() method via reflection, on a WPF Dispatcher STA, without starting the real Control Panel/Gateway/tunnel.
VERY IMPORTANT: The harness deliberately DOES NOT call Coordinator.Start() since Start() registers a process-global VirtualDesktopAccessor switch-event hook and might displace the installed Control Panel's hook. No second instance shares installed Control Panel state or its locks.
All test coordinator config.json, control.json, hud-state.json, control-error.log, and control.lock live under an independently randomized candidate-coordinator-state-<UUID>/agent-desktop directory in ignored runtime/csharp-check/wpf-candidate. The harness creates a synthetic candidate lease ID separate from the real Desktop 2 lease, uses the genuine Desktop 2 GUID, and checks a REAL DeskMCP control lease throughout the test. It destroys the private directory in finally.
The harness deliberately removes ONLY the private test binding after validating a live overlay and heartbeats. It verifies real Coordinator safety rejection and terminal removal of the private synthetic lease. The installed control.json/config.json and production process are never changed.
Wrapper: test-area/ego-wpf-coordinator-live.ps1 accepts only a real Desktop 2 lease and verifies Desktop 1 current number and Desktop GUID before/after; the test does not create or stop production leases.

## Actual 2026-10-22 Windows verification
- Full offline WPF C# compile and standalone test bootstrap/Panel.xaml render: PASS.
- Invalid real lease: exit 3 before any WPF overlay, PASS.
- One live real Desktop 2 Coordinator.Tick test: 19 true COM overlay placement checks, 19 fresh HUD heartbeat reads, zero placement mismatches, deliberately broken private binding revoked its private synthetic lease (remaining=0), real private control-error.log captured safety revoke, one coordinator notification, process exit 0, Desktop 1 GUID and number unchanged before/after.
- Real Desktop 2 lease used to gate testing stopped normally and returned free. No production restart, deployment or desktop switch was performed.
- Two attempted repetitions of the Coordinator run failed to START because the production Gateway reached the 32 active process sessions limit. These are NOT execution/test failures or passes; test never ran. Both test leases were released.
- An independent read-only desktop sampler during the blocked repetition attempts saw 1,786 samples over 28.193 seconds, 0 desktop transitions, 0 non-Desktop1 samples, max sample gap 32 ms, monitor exit 0. This sampler DID NOT overlap a successful Coordinator.Tick execution, and must NOT be presented as such.
- Fast regressions: 179/179 PASS, including new static isolate/revoke policy tests. Browser regression unchanged code, last known 87/87 PASS from previous turn; re-run if process session limit allows.

## Remaining release blockers
1. Running the real full candidate WPF Control Panel (Start(), its own periodic timer, desktop-switch event hook, singleton and real UI) against a separately secured instance namespace remains UNVERIFIED. Starting a second live panel next to production is deliberately avoided to prevent interference.
2. Extended real candidate Coordinator repetitions and an independent switch monitor overlapping actual Coordinator execution are still incomplete due to Gateway process-session saturation.
3. Full candidate Gateway MCP transport+native installed Host integration, other GUI toolkits, real human takeover trust, production install/signature and long uptime are still not release-approved.
4. All changes stay isolated to review branch. The existing production DeskMCP installation and main remain unchanged.

Conclusion: Candidate WPF ControlCoordinator Heartbeat and fail-closed revocation have one real positive live result. This is meaningful integration evidence, not general production readiness.