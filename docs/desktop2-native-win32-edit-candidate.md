# Real Windows Virtual Desktop 2 — native Win32/WinForms Edit message transport (candidate only)

**Status: ONE OWNED WINFORMS EDIT SUBSET LIVE VERIFIED / general release still RED. Production and installed DeskMCP unchanged.**

## Why a distinct transport?

The 2026-10-09 06:03 MYT incident demonstrated that even a `WS_EX_NOACTIVATE` WPF window can become the Windows system foreground during `.NET UIAutomation ValuePattern.SetValue`, while Windows virtual Desktop1 remains selected, and text can be altered unexpectedly. That unsafe provider transport remains quarantined. This module takes a different route: **Win32 control HWND messages**, not UIAutomation or global physical keyboard/mouse.

Microsoft documents `WM_SETTEXT` and `WM_GETTEXT(LENGTH)` for native Edit controls and documents that `SendMessageTimeoutW` marshals system messages (<WM_USER) across processes. This makes an alternate transport *plausible*, but does **NOT** prove that a third-party/custom control will never activate itself, generate unexpected app events, or interfere with input. `EN_CHANGE` is not uniform across all Edit variants, including multiline behavior. The independent foreground observer and real application callback **have now been validated on one test-owned WinForms Edit fixture**; this does not establish identical behavior for other apps or classes.

## Candidate implementation

- `test-area/desktop2-direct-uia/DirectUia.NativeEdit.cs`, compiled into the **candidate** `DeskMCP.Desktop2DirectUia.exe` only.
- `--request inspect-native-edits`: after observer target arming and full root HWND/PID, lease, Desktop2 GUID, active Desktop1, pinned/shared window and `WS_EX_NOACTIVATE` guards, `EnumChildWindows` visits at most **128** child HWNDs and returns at most **32** supported native single-line Edit controls. It does **not** use UIA, read textbox values, synthesize keystrokes, or request focus. Returned metadata uses `native-edit:<child HWND>`, class and capability; no value or password data.
- Target child requires **exact root ownership and PID**, visible/enabled status, class exactly `Edit` or starting `WindowsForms10.Edit.` (case-insensitive). Reject ES_PASSWORD, ES_READONLY, ES_MULTILINE; no RichEdit, WinUI/XAML, WPF virtual TextBox, Electron DOM, generic HWND or top-level windows.
- `--request set-native-edit`: requires a separate one-time HWND-native semantic capability and **exact expected previous text**, both new and old bounded to 512 UTF-16 code units, no control chars. It re-enumerates the child, verifies HWND/root/PID/class/styles, reads `WM_GETTEXTLENGTH`/`WM_GETTEXT` with 350ms bounded `SendMessageTimeoutW` (UIPI-sensitive), compares the old value, sends `WM_SETTEXT` once, then verifies `WM_GETTEXT` immediately and again after 80ms under live observer checks. A failed step is **not retried**.
- The native result contains `textReadbackConfirmed:true`, `appEventConfirmed:false`, `foregroundSafetyUnproven:true` — never claims real application callback or zero-interference.
- TypeScript: `Desktop2DirectUiaLeaseCoordinator.inspectNativeControls` validates native metadata; `Desktop2ComputerUseCandidate.snapshotNativeWindow` issues **separate one-time semantic control permits** bound to window capability, owner lease and specific observer ready path; `Desktop2ComputerUseSession.snapshotNativeWindow` injects lease/observer automatically; `set_native_edit` requires provenance `canSetNativeValue:true`. An ordinary UIA snapshot cannot authorize native HWND writes. Direct `set_value` continues to throw `DIRECT_UIA_VALUEPATTERN_QUARANTINED_AFTER_FOREGROUND_THEFT`.

## Current evidence

- Candidate C# build **PASS, 0 warnings/errors**.
- TypeScript targeted Computer Use suite **98/98 PASS** (includes isolated native Edit metadata and action capability tests).
- Native security-contract/static suite **14/14 PASS**.
- Native helper direct negative tests with a **missing observer** deny both inspect and set, **before any GUI/window access**.
- **REAL OWNED WINFORMS ACCEPTANCE PASSED (2026-10-09 15:55–15:59 MYT):** real virtual Desktop2 passive Edit HWND inventory (one actual `WindowsForms10.Edit.app...`), single exact `WM_SETTEXT` with app `TextChanged` callback count **1**, exact text and double message readback; later wrong-prior-value request denied with app callback count **0**. Across three independent runs: Desktop1 before and after, zero VDA desktop changes, zero target foreground hooks/tripwires, zero application activation/focus/keyboard events. This is controlled fixture evidence only, not third-party/WinUI/WPF/Electron proof. Full source log inventory: `test-area/desktop2-real-acceptance/native-winforms-edit-findings-20261009.md`.
- Existing production `desktop_ui_action` and installed DeskMCP remain unchanged.

## Live release gate before any routing/deployment

1. **DONE for one test-owned WinForms fixture:** opt-in `WS_EX_NOACTIVATE`, single-line Edit on real Desktop2 with owner on Desktop1; independent WinEvent foreground watcher, VDA notifications/25ms poll, real application focus and `TextChanged` events captured. 3 real acceptance runs passed (inspect, write, stale-old-value denial), with no target foreground or virtual desktop switch. **Not a guarantee for other apps.**
2. Verify empty/preexisting text compare-and-swap; password/readonly/multiline refusal; stale/reparented HWND; concurrent manual edits; UIPI mismatch and hung receiver; clipboard non-use.
3. Require **zero actual focus theft, zero virtual desktop switches, zero extra edits, correct app-side events** across independent runs and app versions. If any target requires foreground, use explicit human handoff or an app-specific IPC/CDP route, not a silent fallback.
4. Only after this, consider a per-class allowlisted production route; never equate Win32 success with WPF/WinUI/Electron coverage.

No separate VM, new Windows desktop object, shared clipboard or host-global keyboard/mouse injection.
