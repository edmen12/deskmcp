# DeskMCP — Desktop 2 private window Computer Use real validation
Date: 2026-10-22 MYT
Branch: review/ego-lite-session-gate-20261022
Status: CANDIDATE PARTIAL. NO MERGE / NO INSTALL / NO RESTART.

## Confirmed Windows root cause
- The production desktop_start_process with an Agent Desktop lease launches inside Win32 Desktop Object DeskMCP-Agent-<lease-without-hyphens>.
- Original desktop_ui_windows only enumerated the ordinary WinApp virtual desktop HWND list, then filtered by Windows Virtual Desktop GUID. It did not look inside the owned Win32 Desktop Object.
- Native agent-desktop-host/Program.cs ObjectWindows opened the correct private desktop but discarded any HWND where IsWindowVisible(hwnd) was false.
- An actual WinForms form confirmed its thread desktop matched the lease object and Form.Shown fired, with real HWND. Win32 EnumDesktopWindows saw seven top-level HWNDs including the test form (IsWindow=1, IsWindowVisible=0). The old ObjectWindows returned an empty array.
- Candidate native source now does NOT filter private desktop HWNDs using IsWindowVisible. UI endpoints still filter bad size, safety HUD and untitled windows before exposing window IDs.
- Candidate MSVC read-only native object enumerator produced seven records including the actual WinForms fixture; using this temporary enumerator, candidate WinAppComputerBackend.listWindows found the fixture in the private object.

## Candidate code changes
- src/computer-use-tools.ts gathers verified ordinary Windows Virtual Desktop 2 HWNDs plus lease-named private Win32 Desktop Object HWNDs.
- Window inventory carries native object provenance, so snapshot, actions and re-observations route to the SAME object rather than accidentally acting on Desktop 1.
- src/computer-use-registry.ts binds opaque window capabilities to their native Win32 Desktop Object. Cross-object, wrong lease, unscoped reuse fail closed.
- agent-desktop-host/Program.cs ObjectWindows removes the incorrect IsWindowVisible filter (source-level patch; NOT compiled into the installed .NET native host).
- Five simulated end-to-end UI handlers tests cover both inventory modes, private snapshot, set_value routing, Desktop 1 filtering and wrong lease denial; native source rule has an additional test.

## Actual verification
- Current virtual desktop number before and after initial lease startup: Desktop 1, unchanged. An additional isolated native test also reported Desktop 1 remained current.
- Actual isolated WinForms control process window: PID and HWND captured, correct DeskMCP-Agent desktop object, GUI Shown=true.
- Candidate standalone Windows native enumeration: 7 HWNDs including actual WinForms app, despite IsWindowVisible=0.
- Candidate live Window inventory and top-level UIA snapshot: PASS, captured test form and TitleBar buttons.
- Child WinForms UI Automation: NOT PASS. Only TitleBar controls surfaced; set_value AgentInput failed element_not_found.
- Separate test-only SendMessageTimeout WM_SETTEXT/BM_CLICK probe compiles but cannot claim real action PASS: subsequent attempts suffered Agent Desktop leases being revoked before the test launch.
- npm run test:fast: 172/172 PASS, npm run test:browser: 87/87 PASS.
- MSVC build-ego-d2-probes.cmd builds the standalone test helper binaries with no .NET installation.
- Native agent-desktop-host/WPF .NET integration build remains blocked by the missing dotnet SDK, so the installed gateway behavior has NOT changed.
- All test fixture processes either self-exited or were stopped explicitly; latest Agent Desktop status free; no test browser profile created for this investigation.

## What is actually next
1. Fix WinApp/UI Automation for child controls in inactive private Desktop Objects, or introduce a strict HWND-targeted Win32 control message fallback for classic WinForms Edit/Button only. Never global SendInput or Desktop1 switching. Validate app callbacks on a real fixture.
2. Find why Agent Desktop safety lease occasionally disappears immediately between start and desktop_start_process; do not weaken HUD fail-closed checks.
3. Get a build-verified native .NET AgentDesktopHost candidate and real Computer Use tool E2E before any merge/install.
4. Keep Human Takeover and Windows Hello on hold until basic Desktop 2 read/write/scroll/no-switch works reliably.

Result: native HWND discovery root cause VERIFIED and CANDIDATE source fixed; full Desktop2 operation NOT VERIFIED. Release remains RED.