# DeskMCP Desktop 2 Win32 Object discovery / background input acceptance
Date: 2026-10-22 MYT
Candidate branch: review/ego-lite-session-gate-20261022
Status: VERIFIED PARTIAL, NOT INSTALLED.

## Root cause verified on Windows 11
The installed native AgentDesktopHost.ObjectWindows uses EnumDesktopWindows then IsWindowVisible(hwnd). An actually displayed WinForms test form on an isolated NON-INPUT Win32 Desktop Object returns IsWindowVisible=false. Independent native read-only Win32 enumeration saw seven HWNDs, including the test form; the old endpoint returned an empty list. The source patch removes the incorrect IsWindowVisible filter but retains EnumDesktopWindows object scope and IsWindow/GetWindowRect/process validation.

## Candidate Gateway changes
- src/computer-use-tools.ts now merges GUID-verified Windows virtual desktop windows with windows explicitly enumerated on the lease-owned Win32 Desktop Object.
- src/computer-use-registry.ts binds opaque window IDs to the Win32 Desktop Object name; it rejects cross-scope reuse and stale capabilities.
- Snapshot / Action / observe-after route the identified isolated HWND back through the same backend Win32 Desktop Object, and keep the lease checks. Ordinary Desktop 1 windows never enter the leased inventory. Global keyboard/mouse injection remains blocked.
- Added tests for scoped inventory, snapshot, value operation routing, wrong lease and aliasing, plus regression proving native ObjectWindows no longer checks IsWindowVisible.

## Verified tests
- TypeScript build PASS.
- npm run test:fast: 171/171 PASS.
- npm run test:browser: 87/87 PASS.
- Real Windows Desktop 2 short lease: Desktop 1 remained current before/after, and lease was stopped/released.
- Candidate-only MSVC Win32 shim replicating the corrected native object enumeration discovered the real WinForms test window and its process (old C# host executable was NOT replaced).
- Real isolated WinForms test: native background WM_SETTEXT wrote D2_NATIVE_BACKGROUND_PASS to a textbox; BM_CLICK caused the actual Apply Input callback; UI label returned 'Applied: D2_NATIVE_BACKGROUND_PASS' while current virtual desktop remained 1. No global keyboard/mouse event or clipboard.
- WinApp UIA on the private object enumerated the window/titlebar but NOT native WinForms children. set_value('AgentInput') returned element_not_found. This is a separate remaining Computer Use capability gap.
- The native WinForms control test uses an isolated test helper; it is NOT yet registered as a DeskMCP UI tool or general GUI fallback.

## Remaining required work
1. Wire restricted native child-element enumeration / window-targeted UI operations into Candidate Computer Use; ensure private-object ownership, process ID, lease and per-action observation validation.
2. Build the modified net10.0-windows AgentDesktopHost; full .NET SDK is absent locally, so actual replacement binary has NOT been built. No production install/restart.
3. End-to-end verify via Candidate MCP desktop_ui_windows -> snapshot -> set_value -> invoke -> readback, and show Desktop 1 unchanged with real Windows instrumentation.
4. Human Takeover trust/WPF integration still unreleased; prioritize desktop GUI operation and no Desktop 1 interference.

## Follow-up implementation: native WinForms Computer Use fallback (candidate only)
- agent-desktop-host/ObjectUi.cs now defines restricted object-controls and object-act operations, accepting only WinForms EDIT set_value or BUTTON invoke. It enumerates a specifically named lease-owned Win32 Desktop Object, verifies target HWND and same-process descendants, and rechecks child root/PID/class immediately before action.
- src/computer-use-backend.ts detects WinApp's titlebar-only WinForms inspection, adds bounded native EDIT/BUTTON selectors, and routes those native selectors to the isolated host. Password fields are denied; no value is returned in native edit readback. No SendInput, global pointer/keyboard, foreground switch or clipboard.
- Program.cs registers both native host commands. tests/computer-use-native-fallback.test.ts adds three source-contract regression checks.
- Candidate-only native C++ test shim was built with MSVC to exercise the updated protocol without overwriting the installed C# host binary.
- npm run test:fast: 175/175 PASS. npm run test:browser: 87/87 PASS.
- The live scoped native BACKGROUND input+button callback PASS above remains verified. However a later attempt to run the full candidate WinAppBackend inspect+act flow was blocked before fixture creation because the Agent Desktop lease became revoked or replaced. TWO candidate E2E attempts were refused. This is NOT an E2E PASS.
- WPF/native host C# source remains UNCOMPILED because .NET 10 SDK is not installed. Do not merge, install or claim ready until compiled and tested against the full Desktop 2 lease.
