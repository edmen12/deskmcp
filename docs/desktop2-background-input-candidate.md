# Windows virtual Desktop 2 — native background input research / source-only candidate

Date: 2026-10-08. Branch: `agent/native-desktop2-background-input-20261008` (based on `1b1f8eb`, **without** the rejected Hyper-V prototype). Installed DeskMCP remains 0.9.23, `main@94082fc`.

## Non-negotiable owner contract

- Same **local Windows** environment. Agent's visible apps must live on the actual *Windows virtual Desktop 2* that the human can visit using Win+Tab. Not a Win32 Desktop Object or VM.
- Desktop 1 never switches automatically, never receives Agent mouse/keyboard, never displays transient Agent app windows, never has focus stolen. User manual navigation between desktops always allowed; no auto-return.
- Must ultimately work with click, right/double click, hover, wheel, drag/drop, arbitrary typing/hotkeys, screenshots, native dialog and modern apps. Blocking is safer than leaking to Desktop 1, **but does not count as feature completion**.
- **Do not install/upgrade/restart DeskMCP, push/merge the branch, or reboot the machine without owner approval.**

## Actual host probes

1. `DeskMCP.AgentDesktopHost.exe current-desktop` resolved Windows virtual Desktop 1, 2 existing virtual desktops. Target Desktop 2 GUID was resolved independently.
2. A PowerShell WinForms test Form instantiated with a hidden HWND (not shown): `MoveWindowToDesktopNumber` returned **failure**, and `IVirtualDesktopManager.GetWindowDesktopId` reported element not found. Hidden-only HWND creation is **not sufficient** for placement into Windows virtual Desktop 2.
3. A second window with `Opacity = 0`, `ShowWithoutActivation` and `WS_EX_NOACTIVATE`, `ShowInTaskbar = false` was created without visible pixels, and its HWND was **successfully moved** using the existing native VDA host. The host reported `desktopId = Desktop2`, `desktopNumber = 2`, but **`onCurrentDesktop = true` despite Windows current desktop being 1**. This can occur with toolwindows/pinned windows. **Do not assume desktop GUID alone proves Desktop1 isolation.** The test window was NEVER made opaque.
4. A subsequent direct `SendMessageTimeoutW` input probe did **not** successfully reach the test GUI because the target window had exited and the HWND was invalid (error 1400). This is **not a verified background click/typing E2E**. The probe was time-limited and completed. No global input, focus switch or VM operation was attempted.
5. Source tests passed 5/5 and TypeScript compilation passed. The C# .NET native host **could not be compiled** in the current remote shell because `dotnet.exe` SDK was absent. Framework-only `csc.exe` is present but does not build the project's net10.0-windows code. This is an explicit release blocker.

## Source candidate

- `agent-desktop-host/BackgroundWindowInput.cs` and `agent-desktop-host/Program.cs`: a **native HWND-targeted SendMessageTimeout** transport handling mouse move, single/right/double click, drag, wheel, WM_CHAR literal typing, and a single WM_KEYDOWN/UP. Requires **valid live HWND, exact expected PID, genuine Windows virtual Desktop2+ ID** and actual root window desktop identity. Rejects *pinned/shared on user active desktop* if target desktop is not current. Client coordinates validated against HWND bounds; bounded dispatch. **No SendInput, SetCursorPos, SwitchDesktop or SetForegroundWindow anywhere on this path.**
- `src/desktop2-background-input.ts`: strict bounded argument compiler and action types; no global-input fallbacks.
- `src/agent-desktop-native.ts`: candidate-only `backgroundWindowMessage` wrapper with desktop identity and pinned-window checks. **Not registered in MCP**.
- `tests/desktop2-background-input.test.ts`: 5 tests (argument bounds, message operation shapes, no host injection/static safety).

## Issues / future acceptance

- [ ] **Window placement without even temporary Desktop1 UI or taskbar artifact:** hidden HWND cannot move; zero-opacity NOACTIVATE toolwindow moves but reports current desktop visibility true. Need a truly Desktop2-owned non-pinned top-level window that is never painted/activated on Desktop1, including child dialogs/processes, then confirm `GetWindowDesktopId == Desktop2` and `IsWindowOnCurrentVirtualDesktop == false` from Desktop1.
- [ ] Compile the native host in a source-only stage using a trusted existing .NET SDK (not installed on host now), then verify binary.
- [ ] True live E2E from an owned Desktop2 GUI: window-level WM click/down/up/double/right, drag, wheel, WM_CHAR text, control events/state readback. Message accepted is not proof of application response; measure latency and ensure same PID/HWND/root before and after.
- [ ] Multi-framework coverage: Win32, WinForms, WPF, Electron, Chrome, WinUI/UWP, native file dialogs. PostMessage/SendMessage cannot universally synthesize Raw Input, physical focus or OS/global shortcuts; do not silently fall back to host SendInput.
- [ ] Window-level screenshot with no focus activation and readback. User takeover by manual Win+Tab without forced auto-return.
- [ ] Lease-bound MCP authorization to exact Agent-managed Desktop2 process tree and revocation, no cross-process target spoofing or injection into pinned/user HWNDs.
- [ ] Full regression suite, native installed-candidate acceptance and owner approval before upgrade.

**Current verdict: research and bounded source prototype only. No native GUI input or visual handoff passed.** Do not deploy.
