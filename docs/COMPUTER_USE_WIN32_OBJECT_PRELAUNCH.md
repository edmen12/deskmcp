# Third-party prelaunch isolation and UIA read — real Windows acceptance

Date: **2026-10-24**. Candidate-only, owner-approved system application scope. NO production install, merge, update, root desktop switch or GUI input.

## Scope and result

Two real short-lived trials ran Microsoft Windows's system `C:\Windows\System32\winver.exe` under the candidate `DeskMCP.ProcessHost`, using an actual native, HUD-backed Agent Desktop2 lease. An independent **strict prelaunch foreground/desktop observer** started and reported Ready **before** either Winver process existed. Both trials observed exactly one Winver dialog inside the lease-derived **isolated Win32 desktop object**, and ended with Desktop1 current (1 → 1), no observer tripwire, Winver's owned KILL_ON_JOB_CLOSE process job terminated, native observer exited, lease retained through teardown and subsequently explicitly released.

The **second** real trial additionally ran WinApp CLI itself *inside the same isolated Win32 desktop object* for read-only UI Automation. WinApp reported **12 semantic UI elements** for the owned Winver dialog. The same Winver HWND was **not present** in the Windows **virtual Desktop2** visible-window inventory. No buttons were invoked, no keystrokes or clicks were sent, no app callback/business effect was exercised.

This is an end-to-end test of **preassigned desktop-object process launch + separate-object UIA read**, not of general third-party app automation or a virtual Desktop2 app. The monitor saw no specified focus/desktop alarms **during these two trials**; it does not prove unconditional zero interference in every program or Windows build.

## Correct desktop model

1. **Win32 desktop object**: `desktop_start_process` supplies the exact lease-derived `DeskMCP-Agent-...` object to `ProcessHost`; host sets `STARTUPINFO.lpDesktop = "winsta0\\..."` BEFORE `CreateProcessW`. Its child remains `CREATE_SUSPENDED` until the process is attached to `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. This protects against the earlier dangerous post-launch migration race for this class of process.
2. **Windows virtual Desktop2**: `AgentDesktopManager.filterWindowsForLease` evaluates a real Windows virtual desktop GUID for normally launched windows. It does **not** make private Win32 desktop-object windows appear in the virtual Desktop2 shell.
3. **Current API gap**: the WinApp backend already supports `listWindows(app, desktopObjectName)` and `inspect(hwnd, ..., desktopObjectName)`; but the public `desktop_ui_windows`, `desktop_ui_snapshot` and `desktop_ui_action` lease routing currently uses virtual-desktop GUID filtering and doesn't derive a separate verified Win32-object scope/capability. Do not pass an object-scoped HWND through the virtual-D2 authorization logic as if it were the same identity. A safe future implementation needs an explicit scope discriminator and an observation-bound origin/lease check across discovery, inspection, each action, timeout handling and cleanup.

## Repro and safety

Source-only test: `test-area/isolated-thirdparty-prelaunch/probe-owned-winver.mjs`. Requires the **existing** adjacent Desktop2 acceptance worktree's independently compiled observer and safety preflight (not copied into production), a previously built **candidate** ProcessHost and AgentDesktopHost, installed trusted WinApp executable, .NET runtime/VDA and an explicitly started lease for Desktop2.

The script checks exact `OWNED_SYSTEM_WINVER_WIN32_OBJECT_READONLY_ONCE` sentinel and lease UUID; checks sufficient host memory; verifies live HUD and current Desktop1; starts the strict independent watcher; then launches only System32 Winver into the lease-derived private Win32 desktop object. Read operations inspect that specific object only; any failure prevents a PASS. Owned job termination and observer teardown occur before lease is released by the caller. Evidence files are sanitized and stay Git-ignored in `test-area/isolated-thirdparty-prelaunch/runs/`. The script itself does not start, move or stop Windows virtual desktops.

Offline evidence verification (no app/window access):

```cmd
node scripts\verify-isolated-winver-evidence.mjs
```

Acceptance evidence must show both `owner_desktop_before/after=1`, genuine strict observer, exactly scoped Winver HWND, WinApp UIA elements, quiet observer, job/observer cleanup, and **no** production action authorization. Source-only tests additionally assert process-host `lpDesktop` is assigned before suspended launch/job resume; the test does NOT grant WinApp Invoke/SetValue permission.

## Decision

**Prelaunch on the isolated Win32 desktop object: PASS for one Windows-owned third-party program; read-only semantic discovery: PASS (12 elements).**

**Generic Desktop2 Computer Use: still RED.** Distinct desktop namespaces have not been connected in an action-capable, observation-bound, lease-checked MCP API. No native/semantic input or app event was tested on Winver. More third-party application classes, focus-attribution stability and timeout tests remain required.
