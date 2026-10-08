# Windows virtual Desktop 2 — background Computer Use candidate

2026-10-08. Candidate `agent/native-desktop2-background-input-20261008`. The installed DeskMCP 0.9.23 and `main@94082fc` are unchanged. **Not merged, not installed, not MCP-exposed.**

## Owner contract

Same local Windows, *real Win+Tab virtual Desktop 2*, no VM/Hyper-V or separate hidden Win32 desktop object. Agent may not switch the human's desktop, use global SendInput or steal Desktop1 focus. Manual user switching remains unrestricted. All native Computer Use functionality must work before upgrade, not merely fail closed.

## Completed actual Windows host experiments

- A hidden-only WinForms HWND was not registered with the virtual desktop manager and couldn't move. A zero-opacity toolwindow moved but reported `onCurrentDesktop=true` from Desktop1: rejected.
- **Successful bootstrap**: `WS_EX_NOACTIVATE`, `ShowWithoutActivation`, normal taskbar-style WinForms window, and DWM `DWMWA_CLOAK=1` before `Show()`. Native host then moved it to the actual Windows Desktop2 GUID; `desktopNumber=2`, `onCurrentDesktop=false` from Desktop1. The initial foreground HWND stayed identical. The window was never uncloaked on Desktop1.
- Real `SendMessageTimeoutW` scoped to the child TextBox entered `TEXT_IN_BOX`. App `TextBox.TextChanged` and `KeyPress` logs confirmed exact text; no system keyboard injection.
- Generic WM left mouse down/up triggered `MouseDown` and `MouseUp` but **NOT** WinForms `Button.Click`. New whitelisted `invoke-button` requires actual child Button window class, matching owner PID, enabled state, exact Desktop2 GUID and non-pinned window. It sends `BM_CLICK`; app-level **`APP_BUTTON_CLICK` fired**.
- Real right-button down/up reached WinForms. Wheel `-120` produced **`OnMouseWheel(-120)`**. Drag's WM move/down/up sequence was received, but **app-level drag/MouseMove with held left button was not reliably observed**. `WM_LBUTTONDBLCLK` was received, but **app-level MouseDoubleClick did not occur**. Do not mark generic drag/double click passed.
- After reconfirming Desktop2-only membership, program removed DWM cloak. Installed WinApp `ui screenshot -w <HWND>` with **no focus option** returned an authentic single-window **436×253 PNG (7275 bytes; 35 distinct sampled colors)** from inactive Desktop2. Desktop1 remained current, and desktop-switch log **stayed at 8**. This is not a whole Desktop2 screen stream.
- Every test WinForms process was time-bound and cleaned in finally; no installed Gateway/service/browser was upgraded, moved or restarted.
- **Existing .NET SDK found** at `runtime/dotnet-sdk/dotnet.exe` (10.0.400). Compiled native Host and WinForms fixture using the local SDK, both **0 errors / 0 warnings**; no SDK installation. Node/TS build passed. E2E test harness source in `test-area/desktop2-gui-probe/`.

## Candidate implementation

- `agent-desktop-host/BackgroundWindowInput.cs` + `Program.cs`: HWND-targeted bounded `SendMessageTimeoutW`, Windows Desktop2 GUID + PID + root HWND + pinned/shared-window checks; strict enabled Win32/WinForms Button `BM_CLICK`. **Never calls SendInput, SetCursorPos, SetForegroundWindow, SwitchDesktop**.
- `src/desktop2-background-input.ts`: typed and validated message actions including `invoke-button`.
- `src/agent-desktop-native.ts`: guarded source-only bridge. **Not registered with MCP Computer Use**.
- `tests/desktop2-background-input.test.ts`: argument and static safety regressions. Real fixture: `test-area/desktop2-gui-probe/Program.cs`, `run-joined-test.ps1`.

## Release blockers

- [ ] WinForms/generic coordinate click, double-click, drag/drop, shortcuts and Unicode text across frameworks (only strict semantic Button, TextBox, basic right/wheel validated).
- [ ] Full Desktop2 visible workspace / live stream, popup/process placement, window flash/taskbar checks, user manual Desktop2 takeover.
- [ ] Win32, WPF, Chrome/Electron, WinUI/UWP, native file dialogs and performance under load.
- [ ] MCP integration with an **Agent-owned process/window lease** and one-time observation; current CLI PID/HWND + desktop checks do NOT prove ownership and must not be advertised as production security.
- [ ] Full clean regression, installed-candidate E2E, owner permission before upgrade or restart.

**Outcome: real Desktop2-only window placement + background editable TextBox + button semantic click + wheel/right mouse + screenshot VERIFIED. General-purpose native Computer Use NOT complete.**
