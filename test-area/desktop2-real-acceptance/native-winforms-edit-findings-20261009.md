# 2026-10-09 MYT — real Desktop2 native WinForms Edit targeted acceptance

## Result

**Verified on one candidate-owned, opt-in WinForms single-line Edit fixture only.** The human stayed on real Windows virtual Desktop1. The owned Form was created with `WS_EX_NOACTIVATE` before HWND creation, DWM-cloaked before Show, then moved to actual virtual Desktop2 and explicitly uncloaked. Candidate Agent Desktop2 lease + heartbeating HUD, message-only WinEvent foreground watcher, VDA virtual desktop notifications + 25 ms polling, guarded window/child capability discovery, and one-shot Win32 `SendMessageTimeoutW` were exercised. No OS clipboard, global keyboard/mouse, WinApp input or automatic desktop switching.

**Earlier unsafe direct UIAutomation `ValuePattern.SetValue` stays quarantined**, see `incident-20261009-direct-uia-focus-steal.md`. A WPF TextBox is not a native WinForms Edit HWND.

| Real run (MYT = UTC+8) | Outcome | Actual GUI state |
|---|---|---|
| 2026-10-09 15:51, first inspect | STOPPED before move/action | WinForms runtime class was `WindowsForms10.Edit.app...` instead of expected case-sensitive `WindowsForms10.EDIT.`; test aborted by strict class guard; 0 focus events, 0 switch |
| 2026-10-09 15:55, corrected inspect | **PASS** | Passive HWND/PID inventory -> exact child HWND capability `native-edit:2428482`; 0 text edits, 0 app focus messages, 0 target foreground alarms, 0 desktop switches |
| 2026-10-09 15:56, one-shot write | **PASS** | Candidate `set_native_edit` with exact old text `""`; native `WM_SETTEXT` and immediate + delayed `WM_GETTEXT` readback; **exactly one** app callback `APP_EDIT=1:D2_NATIVE_WINFORMS_ONE_SHOT`; 0 unexpected chars/focus, monitor no alarm, owner Desktop1 before/after |
| 2026-10-09 15:59, wrong previous text | **PASS (denial)** | Deliberately wrong `expectedPreviousValue` denied by native helper (the TS invoker returns a sanitized generic failure). **0 `TextChanged` callbacks**, 0 app focus or virtual desktop switches |

The successful written target was a real WinForms `WindowsForms10.Edit.app.0.2360855_r3_ad1` child window; the full test used a fresh exact native HWND capability plus a one-use semantic token tied to target/root PID, Desktop2 GUID, lease and observer ready identity.

For EACH of the final three passing test runs, the independent passive observer event log contained **START only** (no VDA desktop notifications or WinEvent target foreground changes), its sticky tripwire file was absent, the probe application log showed **no `WM_ACTIVATE`/`WM_SETFOCUS` or keyboard messages**, and Desktop1 remained active after test cleanup. All three test Agent Desktop2 leases were stopped and test-owned GUI process exited. Do not infer that transient focus changes other than the monitored events were impossible, or that third-party apps automatically behave identically.

## Local evidence — preserve

- Successful inspect: `test-area/desktop2-real-acceptance/runs/native-inspect-2026-10-09T07-55-04-483Z/`
- Successful write: `test-area/desktop2-real-acceptance/runs/native-write-2026-10-09T07-56-13-399Z/`
- Wrong-old-value refusal: `test-area/desktop2-real-acceptance/runs/native-deny-stale-2026-10-09T07-59-10-683Z/`
- Initial class case fail (before move): `test-area/desktop2-real-acceptance/runs/native-inspect-2026-10-09T07-51-27-074Z/`
- Each directory includes `steps.jsonl`, `result.json`, `owned-winforms.events.log`, `owned-winforms.ready.json`; the `result.json` points to the unique observer `observer.events.jsonl` and tripwire path under `%LOCALAPPDATA%\DMC\t\deskmcp-d2-lease-*`.
- Executable-only owned fixture: `test-area/desktop2-native-edit-probe/` (source and project tracked).
- One-shot, guarded harness: `test-area/desktop2-real-acceptance/run-native-edit-once.mjs` (source tracked).
- Raw logs in `runs/` are **intentionally Git-ignored and never deleted**.

## Security interpretation

**Native Win32/WinForms single-line Edit is now empirically feasible in a controlled, opt-in fixture.** `WS_EX_NOACTIVATE` alone was NOT sufficient for unsafe direct UIAutomation input; only the *separate native window-message* transport passed these samples. The foreground observer is a detector, not a guarantee preventing first focus theft. Application-level success is grounded by a real WinForms `TextChanged` event, not just a Win32 WM acknowledgement.

Remaining **RED for production general Computer Use**: common third-party GUI roots lacking opt-in `WS_EX_NOACTIVATE`; arbitrary WPF/WinUI/Electron widgets; Electron/WebView2 menus and browser; sliders, click/popup/drag and real app callbacks; multi-window and heavy-concurrency; live clipboard-leak measurements; proving no foreground/input contamination over multiple independently tested versions. No live production MCP registration or installed client update was performed.

The next engineering gate is an explicit **per-control-class capability matrix** and evidence-backed release criteria. Native Edit actions must remain bounded and leased, and must never fall back to global SendInput, direct UIA ValuePattern, shared OS clipboard or automatic Desktop2 switching.
