# 2026-10-10 — real third-party Notepad: private Desktop Object is NOT Windows virtual Desktop 2

## Objective
Stop using source/fixture tests or a lease-scoped `desktop_ui_windows` result as proof that arbitrary third-party software can run and accept background input on the owner's **real Win+Tab Desktop 2**. No VM, new account/session, production deployment, or Desktop1 switching.

## Actual independent Windows observations (2026-10-10 MYT)
- Before GUI launch, native VirtualDesktopAccessor inventory on real virtual Desktop 2 reported `totalWindows=0`, `ownerDesktopBefore=ownerDesktopAfter=1`. Host had ~2292MiB available at the no-GUI safety check, above unchanged 1200MiB floor.
- A real Gateway-owned Desktop2 HUD lease was created for a single test, then `desktop_start_process` with `agent_desktop_lease_id` ran **the genuine Windows 11 Notepad launcher** (not an owned WinForms/WPF test fixture). The gateway returned `Owned process tree launched inside the active Agent Desktop isolated desktop object.`
- The launcher PID 3532 exited and Windows Notepad subprocess PID **28076** was observed, created on this run, with verified `ParentProcessId=3532`. Notepad restored a prior `README.md` tab automatically; no text, input, click or editing action was performed on that tab. Do not infer a fresh empty editor.
- The lease-scoped `desktop_ui_windows({app:'notepad',agent_desktop_lease_id})` returned an opaque Notepad window, foreground=false.
- Independently, candidate-native `desktop-info --desktop-number 2` and `list-virtual-windows --desktop-id <actual Desktop2 GUID>` returned **0 genuine virtual Desktop2 windows** while that Notepad was running. `info.currentDesktopNumber=1` throughout. Therefore **the visible-in-private-object Notepad window did NOT qualify as a real virtual Desktop2 target**.
- After checking exact parent PID and application name, stopped only test-owned PID 28076. Stopped only this HUD lease. Desktop2 pool returned `free`; no unrelated Chrome/Notepad, production Gateway or AQP workload was terminated, switched, or restarted.

## Root architecture split: verified from installed local source
The installed `src/process-tools.ts` passes `desktopObjectNameForLease(...)` to `DesktopBackendBridge.startProcess`. Installed `src/computer-use-tools.ts` passes the same desktop object name to the legacy UI backend. These APIs operate on a **private Win32 Desktop Object**. Neither this placement nor the resulting opaque `window_id` proves a window is in the **shell virtual Desktop 2**.

Real virtual Desktop2 targeting is a **separate candidate path**: `src/desktop2-window-inventory.ts` requires native `listVirtualWindows(realDesktop2Guid)`, exact PID/HWND/class, `desktopNumber=2`, `onCurrentDesktop=false`, no foreground, and stable lease/owner D1. The existing Chrome/CDP visible Desktop2 runtime and owned WinForms VDA fixture are examples of this *different* transport, not evidence the old private-object route is the same.

## Release decision
- **Notepad private-object launch: VERIFIED.** This is useful isolation, but **NOT REAL D2** and **NOT Computer Use functional PASS**.
- **Real D2 third-party Notepad text/click/scroll/drag: NOT TESTED / RED.** Do not use the recovered README.md tab as a disposable target, and do not invoke unsafe generic UIA `ValuePattern.SetValue` or host-global `SendInput`. The prior WPF native UIA foreground theft remains confirmed.
- **Real D2 browser-specific Chrome/CDP:** separate historical true virtual-D2, app-readback E2E exists; not a generic native GUI implementation.
- **Next implementation requirement:** separate launcher/backend origin explicitly. Permit third-party actions in autonomous real D2 only after exact live virtual Desktop2 membership, process ownership, foreground watcher and **app-specific** app-state readback. A private-object window capability can never substitute for VDA proof.
- **Production release gate: RED.** No production upgrade or service restart authorized.

Do not silently 'fix' this by automatically switching the human to Desktop2 or falling back to global mouse, keyboard, clipboard or unguarded UIAutomation mutations.
