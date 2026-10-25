# 2026-10-10 MYT — Real Windows virtual Desktop2 Chrome: old startup focus theft fixed in source-only staged trial

## Newer accepted E2E (supersedes the earlier startup FAIL for this exact Chrome/CDP path)

- **Initial safe bootstrap (live Windows)**: A unique disposable Chrome profile launches with `--no-startup-window` and Windows `-WindowStyle Hidden`. CDP `Target.createTarget({url:'about:blank',background:true,focus:false})` creates a live and *visible* `Chrome_WidgetWin_1` on real D1 **without a foreground event**. Unlike `hidden:true`, the browser root has a valid VDA GUID/index.
- **Exact OS placement (live Windows)**: After verifying that the test-owned Chrome root HWND/PID is visible, unique and not foreground, `AgentDesktopNativeBridge.moveWindow(hwnd, realDesktop2Guid)` with **no ShowWindow** moves it to Windows Win+Tab Desktop2; independent native readback confirms `desktopNumber=2`, `onCurrentDesktop=false`.
- **Full one-shot native acceptance**: `runs/chrome-cdp-nofocus-move-d2-2026-10-10T11-51-19-811Z/result.json`: `pass=true`, Windows foreground events **0 total**, owner D1 1→1, exact Chrome root PID 25316/HWND 3474794 on true D2; app callbacks `FIELD:TRUE_D2_FOCUS_SAFE_中文` and `CLICKED:TRUE_D2_FOCUS_SAFE_中文`; owned Chrome Job exit, observer exit, HUD lease held through teardown and then stopped; zero tripwire, errors empty.
- **BrowserRuntime source integration**: new opt-in source-only `BrowserRuntime` visible-real-D2 launch uses the same no-startup Chrome command and no-focus CDP initial target in `PlaywrightBrowserDriver.createPageWithoutFocus`; D2 owner verification is done before initial URL navigation and app input, and visible process-tree placement does not call redundant `ShowWindow`. Existing headless/private-object paths remain distinct. `runs/real-thirdparty-chrome-2026-10-10T11-59-12-414Z/result.json` **actual integrated BrowserRuntime PASS**: true D2 Chrome root, real copy/paste and click app readback, **0 owned-Chrome foreground events**, 3 unrelated D1 foreground changes (not attributed to agent), D1 1→1, observer/browser/lease teardown PASS, `pass=true`, exit 0.
- **Repeat integrated reality checks**: `runs/real-thirdparty-chrome-2026-10-10T12-02-40-851Z/result.json` PASS (zero foreground changes of ANY application, 0 owned Chrome focus, full D2/app callbacks/teardown). `runs/real-thirdparty-chrome-2026-10-10T12-08-10-109Z/result.json` PASS again **after requiring a live independent observer in the BrowserRuntime constructor** (0 owned Chrome foreground events, 2 unrelated D1 app foreground events, 1→1, full teardown). This is 3 consecutive source BrowserRuntime E2E PASS total, not a stress/SLA guarantee.
- **Fail-closed watcher integration**: Staged `BrowserRuntime` visible-real-D2 now REQUIRES an independently started `Desktop2ObserverLifecycle` handle; its `assertHealthy(leaseId)` is called before launching Chrome and on every later placement/snapshot/action scope, with recheck after a mutating placement. Without watcher it rejects BEFORE any Chrome process launch. The live E2E still separately correlates the native foreground event stream to owned Chrome HWND/PID; `assertHealthy` alone does not establish absence of an initial Chrome focus event. Experimental branch remains off by default.
- **Release status:** Real visible Chrome/CDP source candidate functionality and repeated no-owned-foreground trials **VERIFIED**, but longer stability, automatic continuous event/PID attribution inside the production BrowserRuntime rather than the E2E harness, abnormal popup handling, and formal release acceptance remain **RED**. Do **not** install, enable staged flag in production, merge or restart the service. Arbitrary native WinForms/WPF/WinUI/Electron GUI Computer Use is **NOT** solved.

## Historical failing launcher and investigative evidence (preserved)

## Why this run matters

Do **not** conflate the old `desktop_start_process(agent_desktop_lease_id)` private Win32 Desktop Object with the human-visible Windows **Win+Tab virtual Desktop 2**. This experiment used existing source-candidate `BrowserRuntime` with a dedicated real visible Chrome process and the native VDA virtual Desktop GUID; candidate `readRealVirtualDesktop2Windows` used native `list-virtual-windows` instead of the private-object WinApp backend.

This test did not modify the installed Gateway or the user's Chrome profile. Source-only CLI; not a production MCP success claim.

## Exact on-host evidence

| Trial | True D2 Chrome HWND/VDA | Browser app-side input + click | Owner Desktop1 before/after | Native foreground signal | Result |
| --- | --- | --- | --- | --- | --- |
| `real-thirdparty-chrome-2026-10-10T10-55-01-937Z` | 1 Chrome `Chrome_WidgetWin_1` on real D2, `onCurrentDesktop=false` | `FIELD:ACTUAL_D2_中文`, `DONE:ACTUAL_D2_中文` | 1→1 | 2 `FOREGROUND_CHANGED` entries; owned-PID attribution not implemented in this first run | FUNCTIONAL PASS, foreground classification INCOMPLETE; original `pass=true` was **overly permissive** |
| `real-thirdparty-chrome-2026-10-10T10-58-27-823Z` | 1 real-D2 Chrome root, native PID + HWND recorded | app input-event and button-result readback PASS | 1→1 | 1 event, and **that foreground PID matches the owned Chrome window PID**; `desktopIndex=0` | **FUNCTIONAL PASS / ZERO-FOCUS FAIL** (`pass=false`, exit 3) |
| `real-thirdparty-chrome-2026-10-10T11-01-44-387Z` | No stable top-level HWND available to existing native mover | no app action attempted | 1→1 | 3 events of unknown attribution; root Chrome PID not captured, **cannot call this focus-safe** | HIDDEN-LAUNCH PLACEMENT FAIL (`pass=false`, exit 3) |

The independently launched native WinEvent watcher for the second trial recorded owned Chrome foreground takeover at **2026-10-10 10:58:30.7901734Z** (18:58:30.790 MYT), elapsed **1389ms** from observer start, HWND `5375248`, PID `13760`, while `desktopIndex=0` (owner Desktop1). This occurred at **startup**, before any CDP copy/paste/click. No VDA virtual desktop switch was recorded. Distinguish foreground theft from switching the visible virtual desktop. The target owner can experience a focus interruption even without a switch.

Original observer events and result JSON are preserved under `test-area/desktop2-real-acceptance/runs/...` and `%LOCALAPPDATA%\DMC\t\deskmcp-d2-lease-461e0696-yEibkw\observer.events.jsonl`. Chrome browser + observer exited; agent lease held through teardown, then stopped; D2 status free. Existing user Chrome sessions remained untouched.

## Root cause and failed experiment

The visible real-D2 BrowserRuntime launches Chrome on `WinSta0\Default` (because it deliberately does not use `desktopObjectNameForLease`), with `--start-minimized`, then moves its process tree to Windows virtual Desktop2 after CDP startup. `--start-minimized` **does not guarantee that Chromium never becomes foreground**. This concrete real run proves it can take focus once before VDA placement. This is not a CDP click bug.

A candidate-only attempt added `Start-Process -WindowStyle Hidden` to the visible-launch PowerShell line. The exact native move command then failed: `No stable top-level window remained in the requested process tree before timeout`. Source `agent-desktop-host/Program.cs::EnumerateTopLevelWindows` filters `!IsWindowVisible(hwnd)`, so the mover **cannot consider hidden windows**. No evidence was collected to prove the hidden Chrome HWND exists or is assigned a VDA desktop before Show. Therefore this attempted change was **reverted** rather than regressing the working browser-specific route. This third trial does NOT establish zero focus theft.

## Code implemented, release boundaries

- Added an opt-in MCP `desktop2_real_windows_readonly` candidate: calls exact HUD-lease + native VDA `Desktop2WindowInventory`, checks active Desktop1, true D2 GUID, valid HWND/PID/class and nonforeground/unpinned membership. Does not grant raw PID/HWND/legacy `window_id`/input/screenshot permission. Hides window titles by default. Registered ONLY when `DESKTOP_MCP_REAL_D2_INVENTORY_EXPERIMENT=1`; installed Gateway unchanged.
- Added 4 direct TypeScript tests for real VDA provenance, title privacy, rejection of private-object/shared/foreground rows, and lease/owner fail-closed gates.
- New end-to-end source probe `test-area/desktop2-real-acceptance/run-real-chrome-readonly-tool-once.mjs`: real HUD lease, unchanged 1200MiB physical RAM preflight, passive native observer, dedicated temporary Chrome profile, actual VDA D2 browser window, CDP app-input/click-state witness, cleanup, and PID/HWND correlation of native foreground events. It now denies subsequent app actions when an already recorded Chrome startup foreground event is matched.

## Next real blocker

**The zero-focus startup guarantee is not implemented.** Before releasing real-D2 Chrome, we need an actual native/window lifecycle route that can place an owned Chromium HWND on the virtual Desktop2 **before any activation**, or an equivalent independently verified mechanism. A hidden initial launch may need a separate guarded HWND enumeration and move-before-show path, but whether hidden Chrome has a usable stable VDA HWND remains UNVERIFIED. Do not broadly loosen native process-tree mover filters, unhide on Desktop1, use global SendInput, auto-switch owner Desktop, or mark these E2E functional PASS results as full Computer Use release PASS.

WPF/WinUI/Electron native input remains RED. Official production `observationGuardsEnabled=false`; NO merge, install, restart, or release approval.
