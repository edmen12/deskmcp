# Real Windows virtual Desktop2 — Computer Use capability gate
Updated 2026-10-09 (Asia/Kuala_Lumpur)

**Global production Computer Use status: RED. Do not connect candidate native transports to installed production MCP until class-specific release approvals and real application regression coverage exist.**

| Transport / control | Actual Desktop2 evidence | Status | Allowed behavior |
| --- | --- | --- | --- |
| Passive native top-level window inventory (HWND/PID) | Owned protected WPF and WinForms roots; no target foreground events | Fixture verified | Read-only candidate |
| Guarded UIA metadata inspect-tree on owned protected WPF | Detected WpfEdit/WpfScroller with 0 observed foreground events in read phase | Fixture verified | Candidate metadata only; no generic writes |
| .NET UIA ValuePattern.SetValue WPF | **REAL foreground theft** under WS_EX_NOACTIVATE, with unexpected extra text edit | **PROHIBITED** | Quarantined TS + native implementation; semantic inspect-tree no longer probes ValuePattern nor returns `canSetValue=true`; forged editable rows rejected by lease adapter |
| Native Win32/WinForms single-line Edit WM_SETTEXT | One owned opt-in Form, real TextChanged=1, matching text, no alarm; stale old text denied without mutation | Fixture verified | Candidate only; root must be noactivate, exact HWND/PID, lease, observer, single-line nonpassword, one-use control permit |
| Native System-style WinForms PushButton BM_CLICK | One owned opt-in Form, BUTTON_WM_F5 and APP_BUTTON_CLICK=1, no focus alarm | Fixture verified | Candidate only; exact native BS_PUSHBUTTON/BS_DEFPUSHBUTTON, child PID/parent, lease/observer, one-use permit |
| Native Win32/WinForms ListBox LB_SETTOPINDEX | 2026-10-09 19:18–19:19 MYT fresh real Desktop2: guarded discovery, top index 0→20 app-observed once, wrong old index denied; 0 foreground/desktop alarms | Fixture verified | Candidate only; standard non-owner-drawn/non-multicolumn/nonvirtual ListBox, bounded 512-item list and exact expected previous top index, fresh lease/observer/control capability. **Not a generic wheel/scroll replacement** |
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

## 2026-10-09 18:59–19:00 MYT — new guarded WinForms acceptance

**VERIFIED on one self-owned non-activating, initially cloaked WinForms fixture only**: actual Windows virtual Desktop2 lease, fresh passive observer, bounded native-only Edit/Button capabilities. Four fresh stages: `inspect`, `write`, `deny-stale`, `button-click`, all exit 0 and `pass=true`. Raw `result.json` plus observer events were reread after test: for every stage Desktop1 before/after, 0 target foreground/switch alarms, 0 app focus events, tripwire absent. Write: one exact app `TextChanged`; stale edit: zero app changes; pushbutton: exactly one app `Click`. All owned native observer/fixture processes exited; lease stopped, Desktop2 free.

Raw evidence (ignored by Git; retain):
- `test-area/desktop2-real-acceptance/runs/native-inspect-2026-10-09T10-59-22-944Z/`
- `test-area/desktop2-real-acceptance/runs/native-write-2026-10-09T10-59-44-500Z/`
- `test-area/desktop2-real-acceptance/runs/native-deny-stale-2026-10-09T11-00-00-487Z/`
- `test-area/desktop2-real-acceptance/runs/native-button-click-2026-10-09T11-00-17-200Z/`

**CODE-ONLY current change**: UIA semantic `inspect-tree` no longer advertises or probes unsafe `ValuePattern` edit; TypeScript bridge rejects fabricated `canSetValue=true` from the snapshot. Native HWND Edit continues as distinct one-use channel; WPF/UIA write remains quarantined. .NET 0 warnings/errors, focused TS 40/40 PASS, offline C# negative/contract 18/18 PASS. A successful owned WinForms fixture cannot prove arbitrary third-party WinForms/WPF/WinUI/Electron windows will not activate; production release gate remains RED.

## 2026-10-09 19:18–19:19 MYT — real Desktop2 WinForms ListBox native scroll

**REAL GUI VERIFIED (only own protected WinForms ListBox fixture)**: three independent test stages, all exit 0 and `pass=true`, actual Windows virtual Desktop2, desktop1 before/after=1, observer alarm rows=0, focus events=0, tripwire=false:
- `list-inspect`: one exact `WindowsForms10.ListBox.*` native child handle and capability; no app scroll.
- `list-scroll`: one `LB_SETTOPINDEX` message using fresh one-use ListBox snapshot, expected previous top index 0, target top index 20. Native `LB_GETTOPINDEX` exact readback and application independent `APP_LIST_TOP=20` observed **once**; no focus/desktop event.
- `list-deny-stale`: deliberate expected previous top index 5 while actual is 0; helper refused before mutation, zero application ListBox changes.

Guarded path: observer/HUD/real Desktop2 GUID → exact root HWND/PID and nonactivating style → bounded non-owner-drawn/nonvirtual/native ListBox enumeration and native child capability → expected-old-index CAS → one `LB_SETTOPINDEX` → two independent native readbacks → observed app change. No generic UIA ScrollPattern, `SendInput`, global mouse, wheel, clipboard, or automatic desktop navigation.

Raw evidence (retained; Git ignored):
- `test-area/desktop2-real-acceptance/runs/native-list-inspect-2026-10-09T11-18-50-816Z/`
- `test-area/desktop2-real-acceptance/runs/native-list-scroll-2026-10-09T11-19-03-269Z/`
- `test-area/desktop2-real-acceptance/runs/native-list-deny-stale-2026-10-09T11-19-19-193Z/`

**SOURCE TESTS**: .NET Release helper + fixture build 0 warnings/errors, TypeScript compilation pass, focused lease/capability 45/45, full Desktop2 suite 88/88, static source contracts 19/19, offline fail-closed tests including missing observer PASS. Observer/test GUI processes exited; Agent lease stopped and Desktop2 free. The extra fixture ListBox had not yet been used for a new Edit/Button regression; a planned follow-up was intentionally **BLOCKED by host free RAM ~459 MB**, not falsely reported PASS. Non-owned and third-party app behavior remains unverified, production RED.

## Primary evidence
- Native WinForms Edit: test-area/desktop2-real-acceptance/native-winforms-edit-findings-20261009.md
- Native WinForms PushButton: test-area/desktop2-real-acceptance/native-winforms-button-findings-20261009.md
- Prohibited direct WPF UIA: test-area/desktop2-real-acceptance/incident-20261009-direct-uia-focus-steal.md
- Local raw observer and owned app events in test-area/desktop2-real-acceptance/runs/ (Git-ignored) and %LOCALAPPDATA%\DMC\t\deskmcp-d2-lease-*/ (retained).

Microsoft BM_CLICK reference: https://learn.microsoft.com/en-us/windows/win32/controls/bm-click ; for an inactive dialog, the documented SetActiveWindow workaround is deliberately forbidden by DeskMCP's Desktop1 isolation requirement.
