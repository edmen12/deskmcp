# DeskMCP — Desktop 2 continuous desktop monitoring and offline WPF compile
Date: 2026-10-22 MYT. Candidate branch: review/ego-lite-session-gate-20261022.
Release status: CANDIDATE ONLY. No production install, restart, main merge or push.

## New continuous read-only desktop monitor
- Source: test-area/ego-d2-switch-monitor.cpp; standalone Windows MSVC C++17 native tool.
- The monitor dynamically loads the installed, read-only VirtualDesktopAccessor.dll, calls ONLY GetCurrentDesktopNumber(), never GoToDesktopNumber(), and performs no mouse, keyboard, clipboard, focus, Desktop switching or GUI operations.
- VirtualDesktopAccessor returns ZERO-BASED desktop numbers (0 means DeskMCP Desktop 1). This was verified against the current deployed AgentDesktopHost current-desktop command which reports the same desktop as user-facing number 1.
- Samples at Sleep(10) (~15-18 ms observed), tracks number of samples, value transitions, samples away from Desktop 1, invalid responses, maximum sample gap and duration. It produces an explicit result=PASS/FAIL with fail-closed bounds. The DeskMCP PowerShell-owned child Process.ExitCode property was null even when the child produced a result; the runner deliberately checks the native monitor's complete result field instead and requires a successful actual tool round and >=40 samples, max gap <=100 ms.
- Script: test-area/ego-d2-tool-continuous.ps1. It launches the monitor and fixture within a real DeskMCP Desktop 2 job lease, calls the real candidate Computer Use MCP handler acceptance suite, and validates actual fixture callback and user's Desktop 1 ID before/after. It always signals and joins the monitor and removes the test-owned fixture. The lease is released by the owner caller.

## REAL Windows Desktop 2 evidence
- Round 1: real MCP WinForms set_value+invoke callback PASSED. 395 samples over 6134 ms, 0 transitions, 0 samples away from Desktop 1, 0 invalid readings; maximum sample gap 17 ms. Wrong lease refused. Desktop 1 ID and number before/after equal. Lease stopped, pool free. Runner exit 0.
- Round 2: real MCP WinForms set_value+invoke callback PASSED. 412 samples over 6397 ms, 0 transitions, 0 samples away from Desktop 1, 0 invalid readings; maximum sample gap 18 ms. Wrong lease refused. Desktop 1 ID and number before/after equal. Lease stopped, pool free. Runner exit 0.
- Combined final two successful rounds: 807 sampled observations spanning about 12.5 seconds of actual operations, without a detected Desktop 1 switch.
- Earlier diagnostic round had 487 consistent samples but the wrapper returned failure due to a null PowerShell process exit property. Fixed and repeated as above; do not include that round in pass counts.
- Sampling cannot PROVE that a transient switch shorter than the sampling period did not occur. For an absolute guarantee, instrument native shell Desktop switching at event source plus user-visible foreground feedback.
- The standalone monitor starts AFTER lease creation inside the controlled test job, so the two sampling results do not cover the lease-start or lease-stop interval. Test before/after desktop identity does not cover these intervals either. These remain distinct coverage gaps.

## Additional real lease lifecycle monitor: PASS
- An independent monitor was started on the normal user Desktop BEFORE Desktop 2 lease creation, remained active through the real candidate MCP WinForms set_value/invoke test, Desktop 2 lease shutdown and return to free, and was signaled to stop AFTER lease release.
- Read-only VirtualDesktopAccessor global current-desktop sampling: 2626 samples across 40804 ms, 0 transitions, 0 samples away from Desktop 1, 0 invalid readings, maximum polling gap 31 ms, result=PASS, monitor process exit 0.
- Actual MCP handler Windows test also passed real WinForms callback and wrong-lease rejection during the monitored interval. Lease stopped successfully.
- This additional lifecycle test closes the earlier coverage gap for sampling during lease start and stop. It is distinct from the two successful object-job monitors noted above.
- Because this is polling, changes entirely between adjacent samples cannot be excluded. No Windows shell switch event callback/ETW monitor was used.

## WPF C# source compile
- New test-area/build-ego-wpf-source-candidate.ps1 uses installed Visual Studio 2022 MSBuild Roslyn csc.exe and read-only, installed self-contained .NET 10 and Windows Desktop assemblies.
- It invokes /noconfig directly on Roslyn to avoid implicit .NET Framework 4.0 references, and excludes native DLLs from the 227 managed reference set.
- All 10 WPF Control Panel C# files compiled successfully with zero source errors and output candidate DLL in ignored runtime/csharp-check.
- This is a C# SOURCE build, not an SDK WPF/XAML/BAML/packaging build and NOT a runnable Control Panel install. No window was opened or foreground focus affected.
- The previously committed HUD top-level Window.Opacity stabilization is included in the compiled source, but live HUD-ownership stability for newly packaged WPF remains UNVERIFIED.

## Remaining gates
1. Build WPF XAML resources and isolated runnable Control Panel, carefully avoid a second Control Panel competing for the production control lock or HUD; re-validate the NEW WPF HUD using full lifecycle Desktop 1 sampled monitoring. The installed old panel already passed a 40.8s monitored lifecycle round.
2. Expand native Computer Use coverage beyond classic WinForms edit/button to app-level supported scroll and WPF/Electron/WinUI; preserve fail-closed for unsupported input.
3. Full live Gateway MCP transport (not just in-process registered candidate tool handlers) and installed executable integration remain unverified.
4. Human Takeover Windows Hello enrollment/native trusted HUD remains separate and RED.

Safety: This experiment did not alter production, merge, push, restart a service, or intentionally switch Desktop 1. Exact observed tests and limits are reported above.