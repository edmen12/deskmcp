# Win32-object UIA Invoke: owned-fixture safety admission (candidate)

Status: **SOURCE-ONLY / NEGATIVE GATES PASS / REAL INVOKE NOT YET ACCEPTED**.
No production service, installed gateway, main branch, regular Computer Use action, or third-party application gained any new input permission.

## What this batch implemented

- A **one-shot, app-specific admission class** in `src/computer-use-owned-invoke-gate.ts` for exactly one `OwnedNativePushButton` in the self-owned WinForms selection fixture. It is deliberately **not registered as any MCP tool**.
- Exact application identity (DLL SHA-256, root HWND, PID, WinForms window class), HUD lease and owner Desktop1, independent observer readiness, root `WS_EX_NOACTIVATE`, observed fresh UIA root identity, and exactly one enabled/invokable UIA button of the expected name and automation ID. A truncated, missing, duplicate, stale or ambiguous UIA tree rejects execution.
- An attempt is **consumed before backend delivery**, not after receiving a successful message. Unknown transport outcome cannot retry.
- Only one `APP_BUTTON_CLICK=1` application log entry, no recorded root/button focus messages, owner remaining Desktop1, quiet independent observer, owned Job cleanup, observer exit and lease retained through teardown can produce a **fixture-only callback-attested** outcome. UIA `Invoke` return values alone are not accepted as app success.
- `test-area/isolated-thirdparty-prelaunch/probe-owned-winforms-ui.mjs`: a disposable standalone harness, with separate explicit READ and INVOKE one-shot sentinels, hash-pinned local test EXE+DLL, safe memory gate and mandatory exact active lease. Uses `ProcessHost` preassigned `STARTUPINFO.lpDesktop` and read-only WinApp discovery first; **never** falls back to user-desktop input, native button messages or desktop switching.

## Real protected test observations

The **read-only preflight** was attempted before allowing any button Invoke:

1. Owned fixture did not emit its startup proof in time. The independent observer later became unavailable; the guarded harness aborted and cleaned the owned process; no Invoke was sent.
2. After adding a bounded startup check, the owned ProcessHost exited with code `1` before the fixture could emit its ready proof. Independent observer quiet and cleanup were recorded; no Invoke was sent. The exact underlying process-host/fixture reason has **not been established**.
3. After adjusting shell quoting, the newly started Agent Desktop lease was revoked before any fixture launch; the harness refused further work. The user desktop remained Desktop1; no Invoke was sent. The control state was empty when inspected afterward; the precise reason for revocation is **not yet verified**.

The installed Agent Desktop control error log did not provide a contemporaneous, unambiguous reason for the observed lease revocation. No testing policy or HUD heartbeat budget was weakened, no Desktop1 window was opened, and no new native-action route was enabled.

## Release status

**RED: real owned-fixture isolated-object UIA Invoke not established.** Do not run `invoke` mode without first passing an identical safe **read-only** fixture discovery, independent observer readiness and full cleanup in this environment. A source-level PASS or a Winver read-only UIA PASS does not establish native UIA Invoke callback safety.

Next engineering gate: recover ProcessHost failure diagnostics from the prelaunch controlled subprocess without leaking secrets; distinguish non-start, early process exit, fixture initialization exception and provider invisibility; then get read-only fixture discovery PASS while the HUD/lease remains valid. Only then run at most one explicitly authorized Invoke experiment.
