# Real Win+Tab Desktop2 Chrome startup isolation — 2026-10-10 MYT

Status: **source candidate; meaningful no-focus bootstrap established, visible real D2 GUI creation NOT achieved. Production RED.**

## Why the normal launcher is unsafe

Prior exact native foreground correlation identified an owned Chrome window as the Windows system foreground on Desktop1 around 1.39 seconds after monitoring started, before any CDP mutation. `--start-minimized` did not prevent this. The later attempt to pass PowerShell `Start-Process -WindowStyle Hidden` to Chrome also did not suppress Chrome's own main GUI creation.

### New exact native evidence

The source-only `agent-desktop-host/Program.HiddenChromeProbe.cs` command `probe-hidden-chrome --pid <PID> --started-utc <ISO>` validates a **fresh chrome.exe** PID, full installed binary path and process start timestamp before read-only `EnumWindows` of *both visible and invisible* HWNDs. It reports class, visibility, foreground, native VDA GUID/index and root window status. It **cannot show/move/click/type**; returned handles do not grant authority.

`test-area/desktop2-real-acceptance/probe-hidden-chrome-preplacement-once.mjs` uses a one-time test-only Agent lease, passive Windows switch/foreground observer, independently owned Chrome temporary profile and job, 1200MiB physical RAM gate, and cleanup before lease stop. It supports three explicit operation sentinels only, all read-only except the independently authorized Chrome CDP hidden-page creation.

| Live evidence directory under `test-area/desktop2-real-acceptance/runs` | Concrete results | Safety boundary |
| --- | --- | --- |
| `hidden-chrome-census-2026-10-10T11-34-16-396Z` | Fresh owned Chrome PID 6616. Seven top-level windows: two invisible `Chrome_WidgetWin_0` with **null VDA desktop GUID/index**, plus one **visible** `Chrome_WidgetWin_1` assigned real **Desktop1**. Four consistent samples. Windows native foreground event **owned Chrome PID 6616** at observer elapsed 1441ms. | **FOREGROUND FAIL** even with `-WindowStyle Hidden`. Its two hidden helper HWNDs are not valid VDA Desktop2 main GUI windows. |
| `chrome-no-startup-window-2026-10-10T11-36-37-423Z` | Fresh owned Chrome PID 15180 remained alive across four snapshots. Only hidden `Chrome_WidgetWin_0` without a VDA GUID/index; no visible main browser window. Watcher recorded **zero foreground events**, Desktop1→Desktop1, owned job/watcher/lease clean. | **NO-FOCUS BOOTSTRAP PASS**, not usable as a real GUI. |
| `chrome-cdp-hidden-target-2026-10-10T11-38-41-762Z` | Fresh owned Chrome PID 22360, four stable snapshots, CDP `Target.createTarget({url:'about:blank',background:true,hidden:true})` **accepted**, still only one invisible `Chrome_WidgetWin_0` with null virtual desktop GUID/index. **Zero foreground events**. Owned Chrome/watcher/lease cleaned. | **BACKEND PAGE CREATION PASS**, but no visible Chrome GUI/window to place on actual D2. |

C# Release build **0 errors, 0 warnings**. Dedicated Chrome profile never reused user's real Chrome account. All temporary owned process trees exit; native observer processes zero, D2 lease pool free. These test-specific `pass:true` flags mean census/prelaunch accepted, **not general Computer Use or foreground-safe visible Chrome**.

## Next engineering decision

Chromium's `--no-startup-window` switch is a genuine first-party Chromium switch, see https://github.com/chromium/chromium/blob/main/chrome/common/chrome_switches.h and https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/startup/startup_browser_creator.cc. But neither this flag nor CDP **hidden target** has created a visible, real-VDA Chrome main window.

The next isolated candidate must examine whether a `Target.createTarget` **background but not hidden** call can create a `Chrome_WidgetWin_1` **without any owned Chrome foreground event**, before considering a real VirtualDesktop2 placement. If this inevitably creates and activates a Desktop1 window, mark that route rejected; never auto-switch the owner's desktop or use a focus-stealing fallback. The current native `MoveProcessTree` filters `!IsWindowVisible`; do not simply remove that filter for unmanaged arbitrary HWNDs without identity, observer and VDA checks. Both hidden `Chrome_WidgetWin_0` currently have *no usable VDA association*.

**No production install/restart/merge.** This work does not change user Chrome authentication, Windows default shell desktop, clipboard or UAC settings.
