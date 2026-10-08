# Real Windows Virtual Desktop 2 — native Win32/WinForms Edit message transport (candidate only)

**Status: SOURCE-ONLY / RED. NO live GUI mutation tested. Production and installed DeskMCP unchanged.**

## Why a distinct transport?

The 2026-10-09 06:03 MYT incident demonstrated that even a `WS_EX_NOACTIVATE` WPF window can become the Windows system foreground during `.NET UIAutomation ValuePattern.SetValue`, while Windows virtual Desktop1 remains selected, and text can be altered unexpectedly. That unsafe provider transport remains quarantined. This module takes a different route: **Win32 control HWND messages**, not UIAutomation or global physical keyboard/mouse.

Microsoft documents `WM_SETTEXT` and `WM_GETTEXT(LENGTH)` for native Edit controls and documents that `SendMessageTimeoutW` marshals system messages (<WM_USER) across processes. This makes an alternate transport *plausible*, but does **NOT** prove that a third-party/custom control will never activate itself, generate unexpected app events, or interfere with input. `EN_CHANGE` is not uniform across all Edit variants, including multiline behavior. An actual independent foreground-monitor live validation is still necessary.

## Candidate implementation

- `test-area/desktop2-direct-uia/DirectUia.NativeEdit.cs`, compiled into the **candidate** `DeskMCP.Desktop2DirectUia.exe` only.
- `--request inspect-native-edits`: after observer target arming and full root HWND/PID, lease, Desktop2 GUID, active Desktop1, pinned/shared window and `WS_EX_NOACTIVATE` guards, `EnumChildWindows` visits at most **128** child HWNDs and returns at most **32** supported native single-line Edit controls. It does **not** use UIA, read textbox values, synthesize keystrokes, or request focus. Returned metadata uses `native-edit:<child HWND>`, class and capability; no value or password data.
- Target child requires **exact root ownership and PID**, visible/enabled status, class exactly `Edit` or starting `WindowsForms10.EDIT.`. Reject ES_PASSWORD, ES_READONLY, ES_MULTILINE; no RichEdit, WinUI/XAML, WPF virtual TextBox, Electron DOM, generic HWND or top-level windows.
- `--request set-native-edit`: requires a separate one-time HWND-native semantic capability and **exact expected previous text**, both new and old bounded to 512 UTF-16 code units, no control chars. It re-enumerates the child, verifies HWND/root/PID/class/styles, reads `WM_GETTEXTLENGTH`/`WM_GETTEXT` with 350ms bounded `SendMessageTimeoutW` (UIPI-sensitive), compares the old value, sends `WM_SETTEXT` once, then verifies `WM_GETTEXT` immediately and again after 80ms under live observer checks. A failed step is **not retried**.
- The native result contains `textReadbackConfirmed:true`, `appEventConfirmed:false`, `foregroundSafetyUnproven:true` — never claims real application callback or zero-interference.
- TypeScript: `Desktop2DirectUiaLeaseCoordinator.inspectNativeControls` validates native metadata; `Desktop2ComputerUseCandidate.snapshotNativeWindow` issues **separate one-time semantic control permits** bound to window capability, owner lease and specific observer ready path; `Desktop2ComputerUseSession.snapshotNativeWindow` injects lease/observer automatically; `set_native_edit` requires provenance `canSetNativeValue:true`. An ordinary UIA snapshot cannot authorize native HWND writes. Direct `set_value` continues to throw `DIRECT_UIA_VALUEPATTERN_QUARANTINED_AFTER_FOREGROUND_THEFT`.

## Current evidence

- Candidate C# build **PASS, 0 warnings/errors**.
- TypeScript targeted Computer Use suite **98/98 PASS** (includes isolated native Edit metadata and action capability tests).
- Native security-contract/static suite **14/14 PASS**.
- Native helper direct negative tests with a **missing observer** deny both inspect and set, **before any GUI/window access**.
- **NO genuine Desktop2 Win32/WinForms Edit control was altered**, and no real app callback or foreground-safety claim is yet supported. Last actual GUI attempted on this host was the earlier direct UIA WPF foreground-theft incident; no GUI retest has been conducted for this native Edit path.
- Existing production `desktop_ui_action` and installed DeskMCP remain unchanged.

## Live release gate before any routing/deployment

1. Under a separately approved one-shot scope, run a **test-owned, opt-in `WS_EX_NOACTIVATE`, single-line native WinForms/Win32 Edit fixture** on actual Windows virtual Desktop2, with owner on Desktop1. Monitor `EVENT_SYSTEM_FOREGROUND`, VDA notifications, 25ms desktop polling, app `WM_ACTIVATE`/focus events, mouse/keyboard contamination and real application text-change callbacks. Abort at first interference; **never auto-return**.
2. Verify empty/preexisting text compare-and-swap; password/readonly/multiline refusal; stale/reparented HWND; concurrent manual edits; UIPI mismatch and hung receiver; clipboard non-use.
3. Require **zero actual focus theft, zero virtual desktop switches, zero extra edits, correct app-side events** across independent runs and app versions. If any target requires foreground, use explicit human handoff or an app-specific IPC/CDP route, not a silent fallback.
4. Only after this, consider a per-class allowlisted production route; never equate Win32 success with WPF/WinUI/Electron coverage.

No separate VM, new Windows desktop object, shared clipboard or host-global keyboard/mouse injection.
