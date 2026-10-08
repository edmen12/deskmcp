# 2026-10-09 MYT — candidate direct UIA steals foreground without switching virtual desktop

**Safety gate RED; release blocker confirmed with real Win32 foreground monitoring.**

## Scope and ownership

- Host Windows 11 real virtual Desktop1 owner / Desktop2 candidate Agent lease. Installed DeskMCP production 0.9.23 and main `94082fc` unchanged.
- One candidate-owned WPF test window, with `WS_EX_NOACTIVATE` set **before show**, initially DWM-cloaked, moved to real Desktop2 via native Host, then uncloaked; not an arbitrary third-party app.
- Passive observer hooked `EVENT_SYSTEM_FOREGROUND`, registered VDA desktop-change notifications, and polled every 25ms. No global SendInput, OS clipboard, forced desktop switching or auto-return.
- Candidate sequence: Agent lease/HUD → passive native window enumeration → `--arm-target` (HWND/PID) → guarded `--request inspect-tree` → `--request set-value`.
- Temporary Agent Desktop lease `1e78233e-c39a-4040-9d0f-e007bf1f1cd4` stopped after incident; Desktop2 free and owner Desktop1 at final reading.

## Exact evidence (all wall times 2026-10-09 Asia/Kuala_Lumpur, UTC+08:00)

| MYT | Observation | Evidence |
| --- | --- | --- |
| 06:02:55.899 | Passive switch/foreground observer started on zero-based Desktop1 index 0 | `observer.events.jsonl` |
| 06:02:58.038 | Owned WPF root created, cloaked and `WS_EX_NOACTIVATE` verified before moving to Desktop2 | candidate step timeline and app |
| 06:03:01.505 | Exact target HWND/PID watch armed | step timeline |
| 06:03:03.330 | **Protected UIA metadata snapshot passed**, returned `WpfEdit` (writable Edit) and `WpfScroller` (ScrollViewer), with no foreground event | step timeline |
| **06:03:04.498** | **Target WPF root HWND `32704358`, PID `26524` became Windows system foreground while active desktop was still Desktop1 (VDA index 0)** | Win32 `FOREGROUND_CHANGED` event |
| **06:03:04.525–04.530** | WPF root saw `WM_ACTIVATEAPP`, `WM_ACTIVATE`, and focus message | WPF app log |
| **06:03:04.526** | Passive observer **latched `TARGET_FOREGROUND_EARLY_ABORT`** with `observedDesktopIndex=0`; **no VDA switch notification** | persistent observer tripwire and event log |
| 06:03:04.931 | WPF app still reported `APP_EDIT=D2_CANDIDATE_UIA_ACCEPTANCE` | WPF app-side callback |
| 06:03:04.993 | WPF app reported a **second, unexpected value `APP_EDIT=1D2_CANDIDATE_UIA_ACCEPTANCE`** | WPF app-side callback |
| 06:03:05.004 | Native UIA helper operation failed because watcher was tripped; remaining operations (including scroll) were skipped | step timeline |
| 06:03:05.226 | End-of-run desktop still Desktop1; switch tripwire yes; cleaned owned WPF; lease then revoked | result, follow-up lease stop |

**Interpretation:** The concrete triggering action path is candidate **`DeskMCP.Desktop2DirectUia.exe --request set-value` → `ValuePattern.SetValue`** on a protected WPF root, following a safe metadata snapshot. We do not know which internal Win32 focus API originated the activation. The monitor caught a **real foreground theft**, not merely a user desktop switch. There were **zero VDA notifications and zero poll-detected desktop-index changes** in this sampled run; do not claim an actual Desktop1→Desktop2 switch in this incident. The second WPF text edit is evidence of unintended content alteration; **do not infer the source of the added `1` without independent input traces**.

WS_EX_NOACTIVATE + checking Desktop2 GUID + passive tripwire are insufficient to prevent the first focus theft. The tripwire protects *subsequent* actions; it cannot prevent focus side effects already in-flight. A previous protected WPF + **WinApp CLI** A/B run without foreground change does not generalize to this candidate direct .NET UIA execution path.

## Evidentiary paths (local only, preserve)

- Windows event file: `C:\Users\User\AppData\Local\DMC\t\deskmcp-d2-lease-7d5897b5-3d3rLO\observer.events.jsonl`
- Persistent latch: same folder, `observer.tripwire.json`
- Candidate test: `test-area/desktop2-real-acceptance/runs/guarded-2026-10-08T22-02-55-528Z/`
- Files in run: `steps.jsonl`, `result.json`, `wpf.app.log`, WPF ready/uncloak markers.

Before this incident, two earlier one-shot attempts failed **before UIA or GUI interaction** (first WPF ready timeout, second monitor startup readiness timeout); no target foreground or desktop switching evidence in those attempts. Observer-only real smoke after extending readiness budget: PASS, ready in ~2417ms, no desktop switch.

## Required countermeasure

1. **Quarantine direct `ValuePattern.SetValue` on real virtual Desktop2 at the native execution boundary.** This is a transport-specific block on an experimentally unsafe path, not a decision to disable all Computer Use or installed production.
2. Continue guarded read-only semantic metadata lookup (sampled PASS) and separate app-specific *non-foreground* editing adapters. For Win32/WinForms native child Edit controls, investigate target-verified `WM_SETTEXT`/bounded `WM_GETTEXT` (may still invoke app side effects; needs own tests). For app-owned WPF, prefer process-local dispatcher/IPC; for Electron, debugger-protocol DOM when explicitly supported. Do **not** claim these are universally available for arbitrary third-party apps.
3. Any future live acceptance must monitor **target foreground theft** as a first-class failure even if desktop number remains Desktop1. Require app-side callback and independent control value confirmation without mixed input; fail on extra edits. No auto-return, no legacy unprotected fixture, no production MCP update without proof.

**Outcome: native semantic snapshot reached and succeeded. Direct ValuePattern mutation is NOT approved. Overall real Desktop2 zero-interference gate stays RED.**
