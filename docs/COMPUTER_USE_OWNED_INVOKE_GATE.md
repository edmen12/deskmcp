# Win32-object UIA Invoke: owned-fixture safety admission (candidate)

Status: **OWNED-FIXTURE REAL ISOLATED INVOKE PASS (ONE TARGET, ONE SHOT) / GENERAL THIRD-PARTY NATIVE ACTIONS STILL RED**.
The successful one-shot experiment and its evidence are isolated to a self-owned, hash-pinned WinForms test application. No installed service, main branch, regular Computer Use action, or arbitrary third-party application gained input permission.

## What this batch implemented

- A **one-shot, app-specific admission class** in `src/computer-use-owned-invoke-gate.ts` for exactly one `OwnedNativePushButton` in the self-owned WinForms selection fixture. It is deliberately **not registered as any MCP tool**.
- Exact application identity (DLL SHA-256, root HWND, PID, WinForms window class), HUD lease and owner Desktop1, independent observer readiness, root `WS_EX_NOACTIVATE`, observed fresh UIA root identity, and exactly one enabled/invokable UIA button of the expected name and automation ID. A truncated, missing, duplicate, stale or ambiguous UIA tree rejects execution.
- An attempt is **consumed before backend delivery**, not after receiving a successful message. Unknown transport outcome cannot retry.
- Only one `APP_BUTTON_CLICK=1` application log entry, no recorded root/button focus messages, owner remaining Desktop1, quiet independent observer, owned Job cleanup, observer exit and lease retained through teardown can produce a **fixture-only callback-attested** outcome. UIA `Invoke` return values alone are not accepted as app success.
- `test-area/isolated-thirdparty-prelaunch/probe-owned-winforms-ui.mjs`: a disposable standalone harness, with separate explicit READ and INVOKE one-shot sentinels, hash-pinned local test EXE+DLL, safe memory gate and mandatory exact active lease. Uses `ProcessHost` preassigned `STARTUPINFO.lpDesktop` and read-only WinApp discovery first; **never** falls back to user-desktop input, native button messages or desktop switching.

## Real protected test observations — October 24, 2026 (Malaysia)

Earlier failed attempts were genuinely **pre-action denials**:
1. The original read-only fixture readiness wait ran until its foreground observer was unavailable. After introducing a bounded wait and process-exit check, another launch ended with ProcessHost exit code 1, before any fixture-ready file. Shell invocation was later changed to the explicit PowerShell quoting used by the working isolated process path. The earlier code-1 message did not preserve enough text to conclusively identify its underlying cause.
2. One new Desktop2 HUD lease was revoked before fixture launch. The control document was empty afterward. Source review confirms that Gateway startup calls `AgentDesktopManager.init()`, which resets previous controls, but there is **no contemporaneous evidence proving that a Gateway restart caused this particular revocation**. Lease failure correctly blocked execution.
3. A subsequent protected read-only test **did start the WinForms fixture** and returned the expected `DWM cloak=1`, `WS_EX_NOACTIVATE=true`, and zero foreground HWNDs. Its readiness predicate rejected the actual Windows class `WindowsForms10.Button.*` because the test mistakenly required `WindowsForms10.BUTTON.*` (case mismatch). This false rejection was corrected without relaxing the HWND/PID/lease guards.

After this fix, a **fresh leased read-only test PASSED**:
- Self-owned WinForms EXE/DLL hash verification and non-activating isolated startup PASS
- **96 UIA elements**, with exactly **one matching `OwnedNativePushButton`**
- Desktop1 **1 → 1**, independent monitor quiet; owned process Job and watcher exited; lease retained through cleanup and explicitly released
- **0 Invoke calls** in read-only mode

Finally, a **separately leased, strict-observer single Invoke test PASSED**:
- 96 UIA elements, unique target button, exact WinForms app process and fixed hash
- Exactly **1 `Invoke` sent**, exactly **1 real `APP_BUTTON_CLICK=1`** application callback
- Raw local app event log contained only `APP_SHOWN_FOREGROUND=0`, `UNCLOAK_SUCCESS`, then `APP_BUTTON_CLICK=1`; no duplicate callback or unexpected activation event
- Desktop1 stayed **1 → 1**, no independent observer alarm, process and watcher cleanup both PASS, lease retained through teardown and explicitly released
- `production_action_authorized=false` throughout

The one-shot native GUI test was performed inside the **private Win32 desktop object** and is distinct from the Windows virtual Desktop2 application list. Neither test enabled any generic `desktop_ui_action` capability.

For subsequent runs, `src/computer-use-owned-launch-diagnostics.ts` classifies early ProcessHost failures and tracks lease generation without guessing revocation cause. An offline consistency check is available:

```cmd
node scripts\verify-owned-winforms-invoke-evidence.mjs <owned-run-stamp>
```

For the existing passing run, use stamp `mvlc141h`. This checks the saved result against the app log. Its output explicitly reports `log_run_binding=legacy_unbound` (the older saved result had no embedded run stamp) and `raw_observer_trace_reverified=false`; do not mistake this offline check for an independent full foreground trace reinspection. New runs carry an explicit `run_stamp` field.

## Release status

**GREEN for one owned WinForms fixture Button Invoke under exact protected conditions; RED for general native third-party application control.** One call and one callback under a safe isolated desktop show that UIA Invoke **can** preserve WinForms business event semantics for this precise control class/fixture; they do not guarantee behavior on all Windows apps or controls. More control types, third-party profiles, long-session reliability, and independent monitor attribution need separately approved tests before any wider release.
