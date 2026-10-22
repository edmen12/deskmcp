# DeskMCP Desktop 2 compiled C# Host / real MCP tool-handlers acceptance
2026-10-22 (Asia/Kuala_Lumpur). Branch review/ego-lite-session-gate-20261022.
CANDIDATE ONLY. NO production binary replacement, restart, merge or push.

## Offline compilation without installing an SDK
Both agent-desktop-host/Program.cs and agent-desktop-host/ObjectUi.cs compiled using the existing Visual Studio MSBuild Roslyn csc.exe and reference .NET 10 assemblies in the installed, self-contained DeskMCP runtime. Exit 0. An isolated candidate apphost and copied runtime dependencies run from runtime/csharp-check/candidate-host/DeskMCP.AgentDesktopHost.exe. It returned valid current-desktop data and exit 0. Installed files were read-only.
Rebuild: test-area/build-ego-d2-csharp-host-candidate.ps1 (-CompileOnly for a faster compile without creating runnable copy). This does not compile the WPF Control Panel.

## Three live end-to-end Windows acceptance cycles
Files: test-area/ego-d2-tool-live.mjs and test-area/ego-d2-tool-combined.ps1.
Each cycle used REAL desktop_ui_windows, desktop_ui_snapshot, desktop_ui_action handler functions registered in an in-process test MCP registry (not the installed MCP transport), real live AgentDesktopManager and lease/HUD files (without calling manager.init, which revokes leases), live WinAppComputerBackend, independently compiled candidate C# Host, and a genuine PowerShell WinForms fixture launched by installed ProcessHost inside lease-owned Win32 Desktop Object.
Per cycle: (1) live D2 lease with HUD ready; (2) fixture launched into isolated desktop; (3) real UI windows found; (4) Snapshot returned native textbox/button selectors; (5) set_value writes D2_MCP_END_TO_END_PASS and issues fresh observation; (6) invoke clicks Apply Input; (7) actual fixture callback file confirms Applied: D2_MCP_END_TO_END_PASS; (8) before/after current Windows Desktop ID and number remain Desktop 1; (9) fixture exits; (10) D2 lease explicitly stops and pool returns free. All three cycles returned exit code 0.
Last two cycles additionally verified WRONG lease UUID passed to real MCP snapshot is denied. No global SendInput or system clipboard used.

## Regression
- Reproducible offline candidate compiled Host with -CompileOnly: PASS.
- npm run test:fast: 177/177 PASS.
- npm run test:browser: 87/87 PASS in previous HUD fix round; rerun at final closeout.

## Remaining release gates (do not overclaim)
- Registered candidate MCP handlers were called IN PROCESS; not a production Gateway MCP transport/integration test.
- Desktop 1 before/after identity stayed identical, but an independent continuous desktop-switch event monitor is still missing, so no full proof of zero transient switches.
- WinForms edit and button have passed; not generalized scroll, drag, WPF, WinUI or Electron.
- Existing installed WPF Control Panel still has intermittent HUD ownership errors. Candidate WPF opacity patch was code-tested, but new WPF GUI build and live new-HUD acceptance have not passed.
- Not installed, no production restart/merge/push. Human Takeover RED.