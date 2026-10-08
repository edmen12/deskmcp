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

## 2026-10-09: HEADFUL Chrome on REAL Windows virtual Desktop2 — full local E2E PASS

The owner confirmed **a brief initial Desktop1 launch is acceptable**; the core constraint is no automatic switch, stolen user keyboard/mouse or foreground changes *during autonomous Desktop2 operation*. Password/OTP/authorization may require a separately requested, explicit human takeover of Desktop2; never force a return to Desktop1.

**Repro:** `node test-area/desktop2-chrome-e2e.mjs` on the test Windows host. This is a test fixture, NOT production BrowserRuntime / MCP integration. It starts a **unique, separate Chrome profile**, discovers the actual Chrome browser root (Chrome's initial launcher may exit zero and hand off), and uses the existing installed native `move-process-tree --show-no-activate` to place the real visible HWND(s) on Desktop2. It validates `GetWindowDesktopId==Desktop2` and `onCurrentDesktop=false` for all owned top-level windows before CDP input. It uses Playwright CDP (not host-global `SendInput`) for GUI interactions; `finally` closes only that unique-profile test browser. No personal Chrome profile, installed Gateway or AQP service modified.

**Observed (repeated real E2E, including 2026-10-09 final expanded run):**
- Actual **headful** Chrome native window moved to Desktop2 (not a Win32 Desktop Object, not a VM, not headless). User's current virtual desktop was Desktop1 before, during and after.
- Button `CLICKED:DESKTOP2_AGENT_OK`, input `DESKTOP2_AGENT_OK`, hotkey **Ctrl+A** and literal Unicode text `中文桌面二✓`, right-click `contextmenu`, double-click `DOUBLE_OK`, HTML drag/drop `DRAG_OK`, wheel scrollY=650. All verified by page-state readback.
- CDP screenshot PNG valid; **separate installed WinApp native window screenshot** succeeded from the inactive Desktop2 Chrome HWND, **946×713 PNG ~20–21 KB**, with **30 distinct colors** sampled in a prior run. Thus not merely a headless browser screenshot. Native user desktop remained Desktop1, invariant log count unchanged at **8**.
- An independently opened second Chrome popup created a second top-level HWND. Explicit re-run of `move-process-tree` relocated **both windows** to Desktop2; its page-state readback `POPUP_BACKGROUND_AGENT_OK` succeeded. **Popup relocation is an explicit test step, NOT yet an automatic process-watchdog or MCP workflow.** Brief popup appearance on Desktop1 is allowed by user, but sustained Desktop1 interference is not.
- All observed owned test Chrome process trees were closed/verified absent; personal Chrome processes unaffected. The test used no Hyper-V, no `SendInput`, no Windows virtual desktop switching.

**Updated 2026-10-09:** the candidate `BrowserRuntime` now has a gated, lease-scoped **real visible Desktop2 Chrome path** and succeeded in a full **source BrowserRuntime + OwnedBrowserProcessController/ProcessHost + real AgentDesktopManager lease + browser CDP** E2E. It remains an experimental source-only feature, **disabled by default**; enabling requires `DESKTOP_MCP_DESKTOP2_VISIBLE_BROWSER_EXPERIMENT=1` on a separate staged instance or passing the opt-in constructor argument (test only). See the verified integration section below. Native generic WinForms drag/double-click remain unsupported; WPF, Electron (outside Chrome CDP), WinUI/UWP and native dialogs are unproven. Do not merge, install or claim universal native Computer Use.

## 2026-10-09: ACTUAL candidate BrowserRuntime + Agent lease + ProcessHost E2E

**Repro source**: `node test-area/desktop2-visible-runtime-e2e.mjs` on the authorised Windows 11 host. It creates an owned short-lived AgentDesktop2 lease, starts local HTTP fixture, opens a unique Chrome profile from the candidate `BrowserRuntime` with `headless:false`, exercises normal Browser observations/CDP and the existing private Agent clipboard, creates a popup and closes the owned browser/profile and lease in `finally`. No DeskMCP installation, restart, service modification or VM.

**Observed in REAL Windows virtual Desktop2 (not standalone Chrome test):**
- `BrowserRuntime.start` with `OwnedBrowserProcessController`, `DesktopBackendBridge` / ProcessHost job, actual `AgentDesktopManager` lease and the staged opt-in flag: `RUNTIME_STARTED` with `headless:false`, one real visible page, on Desktop2. User Desktop1 remained foreground. No host-global input.
- `virtual_copy` from the source page into the lease-scoped Agent buffer, `virtual_paste` into input, then BrowserRuntime `click` triggered `DONE:AGENT_RUNTIME_中文` observed in page snapshot; logged `RUNTIME_CLIPBOARD_AND_BUTTON_PASS=true`.
- Chrome popup opened, BrowserRuntime's before/after action placement reconciled native top-level windows back into Desktop2, with 2 CDP pages; logged `RUNTIME_POPUP_PAGE_COUNT=2`.
- Initial run showed **a real liveness bug**: a 1-second background reaper accumulated repeated multi-second native placement operations in its serialized mutation queue and delayed explicit browser close. The owned lease was explicitly revoked and candidate browser session safely reaped; that first full test did **not** pass. No orphan Chrome was found.
- Fix: `BrowserRuntime.reaperInFlight` gates reaper ticks until the previous sweep finishes; the added regression `slow visible Desktop2 reaper cannot starve an explicit browser close behind repeated sweeps` passed with synthetic >1-second placement.
- Retest **PASS** (exit 0, 98.91 seconds): `RUNTIME_CLOSE_OWNED_BROWSER_PASS=true`, `INTEGRATED_RUNTIME_DESKTOP2_PASS=true`, `OWNED_LEASE_STOPPED=true`. Final native Desktop1 remained current and foreground-switch log count remained **8**. After-run inspection: Agent Desktop2 pool free, test Chrome processes **0**, generated test directories **0**.
- This is a **source-runtime candidate with existing installed ProcessHost + native helper**, not a staged installed Gateway MCP release. The installed DeskMCP remains 0.9.23 and still uses its old default behavior. The opt-in candidate mode is OFF by default.

**Still blocking production / full Computer Use:** 99-second end-to-end duration is high and requires latency profiling, native-app generic click/drag/double and cross-framework compatibility unverified, human login handoff state not connected to actual UI/MCP, non-browser GUI/window lease binding incomplete, full serial regression suite/installed-candidate acceptance and owner approval outstanding. No Hyper-V. Do not merge or deploy.
