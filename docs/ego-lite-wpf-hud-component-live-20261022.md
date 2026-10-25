# DeskMCP candidate WPF HUD — real isolated Desktop 2 acceptance
Date: 2026-10-22 (MYT). Candidate worktree review/ego-lite-session-gate-20261022.
Status: CANDIDATE COMPONENT VERIFIED; NOT PRODUCTION-INSTALLED; FULL PANEL INTEGRATION UNVERIFIED.

## Offline runnable WPF candidate without installing SDK
- New test-area/build-ego-wpf-hud-candidate.ps1 compiles ALL 10 WPF panel C# source files (including the proposed HUD top-level opacity fix), using the preinstalled MSBuild Roslyn compiler and read-only installed .NET10/WPF assemblies.
- It creates a separate test-only executable by reusing an installed self-contained .NET apphost and runtime files copied only into ignored runtime/csharp-check/wpf-candidate. The managed test bootstrap loads the compiled candidate WPF code by reflection. No installed program or data is modified.
- Candidate launch allowlist accepts ONLY self-tests, offscreen XAML capture and the --hud-placement-probe test mode. It does not start a second full Control Panel, singleton, gateway, tunnel or real lease coordinator.
- Actual executed selftest: AGENT_DESKTOP_BINDING_SELF_TEST=PASS (exit 0). Actual XAML offscreen render: Panel.xaml loaded successfully, PNG 76,581 bytes, exit 0. Invalid lease HUD probe: HUD_TEST_LEASE_NOT_ACTIVE, exit 3, no visible overlay.
- WPF candidate compile/bootstrap test-mode is NOT a full dotnet SDK publish, BAML build, code signed package or production application startup.

## Actual WPF overlay placement
- The isolated test bootstrap invokes the REAL AgentDesktopOverlay class from candidate control-panel/wpf/AgentDesktopControl.cs, including its genuine edge/HUD WPF Windows and AgentDesktopWindowMover COM MoveWindowToDesktop path. It does not use synthetic WPF windows.
- The user was on Desktop 1; DeskMCP granted a real Desktop 2 lease; a read-only control.json check verified the lease and target GUID before the extra candidate HUD was shown. Test probe verifies the lease remains live while examining true COM GetWindowDesktopId for BOTH edge and HUD, and disposes both WPF windows on test completion.
- Live round 1: 30 placement checks across ~4.12 seconds, 0 mismatches. Both window Desktop GUIDs matched the signed target GUID d81244e4-e0c5-456f-a707-2b685a00662c, process exit 0.
- Live round 2: 27 checks across ~3.62 seconds, 0 mismatches, process exit 0.
- Live round 3: 27 checks across ~3.60 seconds, 0 mismatches, process exit 0.
- Live round 4 through reproducible test-area/ego-wpf-hud-live.ps1: 20 placement checks across ~2.62 seconds, 0 mismatches, exit 0; Desktop 1 GUID and number identical before and after. No concurrent continuous monitor in this specific round.
- Aggregate 4 HUD runs: 104 real COM desktop ownership checks, 0 mismatches. Three of the rounds had independent continuous desktop-number monitoring.
- Every Desktop 2 lease was explicitly stopped and pool returned to free.

## Desktop 1 noninterference monitoring
- One independent read-only desktop monitor spanning round 1 and full lease lifecycle: 1,245 samples / 19,508 ms, zero observed desktop changes, zero observations away from Desktop 1, zero invalid results, maximum sample gap 53 ms, result PASS, monitor exit 0.
- A separate independent read-only monitor spanning rounds 2 & 3 and their lease lifecycles: 2,829 samples / 44,025 ms, zero observed desktop changes, zero observations away from Desktop 1, zero invalid results, maximum sampling gap 33 ms, result PASS, monitor exit 0.
- Total: 4,074 sampled checks over 63.5 seconds with no detected virtual-desktop switch. A sampler CANNOT rule out every sub-sampling-interval switch; no event-source shell hook was used.

## Important limits
- This proves the proposed HUD component can create/move its own WPF windows and keep their desktop ownership for several seconds in an isolated candidate executable. It does not prove existing production ControlPanel Coordinator with timers/safety reaper will remain stable for hours.
- Full installed ControlPanel/production Gateway were NOT updated or restarted. The native WPF installation build and code signing remain unreleased; production main was not merged.
- The test-only callback for the candidate HUD's Exit Agent Control button does not operate real leases and is never exposed through production.
- The new test script test-area/ego-wpf-hud-live.ps1 requires a preapproved active lease and verifies Desktop 1 ID before and after, and never starts/stops any lease itself. It has now passed one independent live replay.
- Human Takeover (native trusted consent and real Windows Hello enrollment) is a separate release RED gate.

## Next engineering acceptance
1. Long-running and repeated WPF coordinator safety HUD placement under an isolated FULL Control Panel in its own state/lock namespace, not a second process competing for production leases.
2. Add an event-driven independent Windows shell desktop-switch listener to reduce the remaining sampling blind spot.
3. Validate WPF, Electron and WinUI Computer Use functionality beyond WinForms text/button; retain fail-closed behavior where background operations unsupported.
4. Full production release requires explicit user approval; no auto-upgrade or restart.