# Real Windows virtual Desktop2 — Computer Use capability gate
Updated 2026-10-09 (Asia/Kuala_Lumpur)

**Global production Computer Use status: RED. Do not connect candidate native transports to installed production MCP until class-specific release approvals and real application regression coverage exist.**

| Transport / control | Actual Desktop2 evidence | Status | Allowed behavior |
| --- | --- | --- | --- |
| Passive native top-level window inventory (HWND/PID) | Owned protected WPF and WinForms roots; no target foreground events | Fixture verified | Read-only candidate |
| Guarded UIA metadata inspect-tree on owned protected WPF | Detected WpfEdit/WpfScroller with 0 observed foreground events in read phase | Fixture verified | Candidate metadata only; no generic writes |
| .NET UIA ValuePattern.SetValue WPF | **REAL foreground theft** under WS_EX_NOACTIVATE, with unexpected extra text edit | **PROHIBITED** | Quarantined TS + native implementation |
| Native Win32/WinForms single-line Edit WM_SETTEXT | One owned opt-in Form, real TextChanged=1, matching text, no alarm; stale old text denied without mutation | Fixture verified | Candidate only; root must be noactivate, exact HWND/PID, lease, observer, single-line nonpassword, one-use control permit |
| Native System-style WinForms PushButton BM_CLICK | One owned opt-in Form, BUTTON_WM_F5 and APP_BUTTON_CLICK=1, no focus alarm | Fixture verified | Candidate only; exact native BS_PUSHBUTTON/BS_DEFPUSHBUTTON, child PID/parent, lease/observer, one-use permit |
| Default owner-drawn WinForms Button | Exact class existed but style filter excluded it in live read-only acceptance | DENIED | Never auto-fallback to SetActiveWindow or global click |
| WPF Button UIA Invoke | No proven zero-interference Click on exact candidate chain | RED | Not enabled |
| WinUI/XAML controls | No real zero-interference coverage | RED | Not enabled |
| Electron/WebView/browser UI | No genuine Desktop2 app-specific transport acceptance | RED | Not enabled |
| WPF/WinForms UIA ScrollPattern | Static tests only, no complete independent live scroll acceptance | RED | Not approved for production |
| Menus, popups, drag, arbitrary mouse/keyboard | No comprehensive independent live acceptance | RED | No host-global input fallback |
| Clipboard | User requested DeskMCP-owned copy buffer, not global clipboard sync; global clipboard isolation not validated | RED | Never use OS clipboard as an automatic input fallback |

## Universal safeguards
1. User remains on Desktop1 throughout. Foreground theft counts as failure **even without actual virtual desktop switching**.
2. Source owns target observation + live lease/HUD identity, native virtual Desktop2 GUID, exact HWND/PID and child class/style; no best-effort title lookups.
3. Passive WinEvent/VDA tripwire arms **before** native interactions; abort all subsequent work at the first foreground/desktop/lease anomaly and preserve raw logs.
4. One-use semantic control token; deny stale HWND, wrong process, wrong action type, forged/duplicate control, missing watcher, unsupported styles and abandoned lease.
5. Do not infer app Click/TextChanged callback from WM_SETTEXT or BM_CLICK result. Real app event or independently observable state required for application-effect claims.
6. No production MCP registration, merge, restart, installer update or automatic desktop handoff without a class-specific release decision.

## Primary evidence
- Native WinForms Edit: test-area/desktop2-real-acceptance/native-winforms-edit-findings-20261009.md
- Native WinForms PushButton: test-area/desktop2-real-acceptance/native-winforms-button-findings-20261009.md
- Prohibited direct WPF UIA: test-area/desktop2-real-acceptance/incident-20261009-direct-uia-focus-steal.md
- Local raw observer and owned app events in test-area/desktop2-real-acceptance/runs/ (Git-ignored) and %LOCALAPPDATA%\DMC\t\deskmcp-d2-lease-*/ (retained).

Microsoft BM_CLICK reference: https://learn.microsoft.com/en-us/windows/win32/controls/bm-click ; for an inactive dialog, the documented SetActiveWindow workaround is deliberately forbidden by DeskMCP's Desktop1 isolation requirement.
