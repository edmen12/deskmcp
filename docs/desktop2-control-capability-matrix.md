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
| WPF/WinForms UIA ScrollPattern | No real zero-foreground acceptance; older candidate exposed a callable SetScrollPercent transport | **PROHIBITED** | Now blocked at outer Computer Use, TS lease and native C# policy; SetScrollPercent implementation removed; metadata snapshot reports canScrollTopBottom=false. Distinct verified native WinForms ListBox LB_SETTOPINDEX remains separate |
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

## 2026-10-09 — Computer Use candidate rejects legacy forged UIA ValuePattern authority

**SOURCE-ONLY SAFETY FIX**: The native UIA semantic snapshot and lease coordinator already rejected `canSetValue=true` after actual WPF ValuePattern foreground theft, but the outer `Desktop2ComputerUseCandidate.snapshotWindow` previously trusted its injected `inspectControls` result and would mint a one-use permit for a forged editable UIA element. Its `dispatch` also had an old branch authorizing `set_value` when such a permit existed; native/lease helper would still refuse, but authority at this boundary was inconsistent.

The candidate now **rejects any `canSetValue !== false`**, requires a guarded UIA scroll-only snapshot, refuses mixed native action flags, and **hard-denies `set_value` even if an old/forged semantic permit is supplied**. The action attempt burns the one-use observation. Authentic scroll snapshots and separate native HWND Edit/Button/ListBox capabilities remain intact. Test fixtures were changed from the formerly permissive fake WPF edit into a scroll-only control; two adversarial tests cover forged `canSetValue=true` metadata and trying to upgrade/replay a scroll permit for a prohibited write.

**Verified**: TypeScript compilation PASS, focused Computer Use/lease tests **47/47 PASS**, all eight Desktop2 source tests **90/90 PASS**, native source contracts **20/20 PASS**, `git diff --check` PASS. **No new real GUI test in this change** because host free RAM repeatedly dropped to ~380–507 MB despite brief recovery; the added-ListBox-fixture Edit/Button E2E regression remains OPEN. No lease started, no target/app foreground operations, and no upgrade/restart/merge/push to production. WPF UIA ValuePattern and generic third-party Computer Use remain RED.

## 2026-10-09 19:35–19:36 MYT — post-ListBox Edit/Button live regression + memory safety gate

**SUPERSEDES ONLY the older OPEN note** above about re-running Edit/Button on the extended Edit/Button/ListBox fixture. The post-ListBox regression has now been tested on a **real Windows virtual Desktop2**; it is no longer OPEN for that self-owned WinForms fixture. It remains unproven for arbitrary non-owned apps, or other UI frameworks.

New acceptance harness safety gate: `test-area/desktop2-real-acceptance/resource-preflight.mjs` requires **three consecutive Windows physical available-memory samples >=1200 MiB**, without an environment override, before observer startup and again immediately before any owned GUI fixture spawn. Invalid data and low/unstable memory fail closed; no process killing or retry. Its deterministic unit tests are **4/4 PASS** (low-memory, falling/invalid sample, stable samples, compulsory call ordering). This protects the user's Desktop1 when the Windows 16GiB host has heavy Chrome/ChatGPT/WSL memory pressure; it does not prove arbitrary Windows apps are focus-safe.

Fresh REAL Desktop2 stages on **updated ListBox-containing WinForms fixture**:
- `write`: exact Edit `WM_SETTEXT` readback, one independent app `TextChanged`, no Button click or ListBox change.
- `deny-stale`: wrong expected old Edit text rejected before mutation, zero app Edit/Button/ListBox changes.
- `button-click`: one `BM_CLICK`, exactly one independent app `Click`, no Edit or ListBox change.

Each of the three stage `result.json` and separate passive WinEvent/VDA observer event logs was **reread**: `pass=true`, `desktopBefore=desktopAfter=1`, `tripwire=false`, zero observer alarm rows, zero app focus events. All fixture/observer helper processes exited and Agent Desktop2 lease was explicitly stopped; Desktop2 free. Verified raw directories retained under ignored `runs/`:
- `native-write-2026-10-09T11-35-30-261Z/`
- `native-deny-stale-2026-10-09T11-35-47-499Z/`
- `native-button-click-2026-10-09T11-36-02-400Z/`

WPF `ValuePattern.SetValue` foreground theft remains **PROHIBITED**; no generic WinUI/WPF/Electron mouse/drag/scroll enablement, no production MCP registration or install, no automatic desktop switching. These app-class specific tests **cannot certify universal no-interference**.

## 2026-10-09 — Unverified UIA ScrollPattern transport closed at all three candidate layers

**New security finding (SOURCE-ONLY)**: Matrix listed generic WPF/WinForms UIA `ScrollPattern.SetScrollPercent` RED, but candidate source still accepted `scroll` on a UIA `canScrollTopBottom=true` observation, TS lease translated into `scroll-top/bottom`, and native C# helper actually called `SetScrollPercent` without any real zero-interference acceptance. Such a provider may activate its app, so a watcher detecting it afterward is not sufficient.

**FIX**: Computer Use rejects `scroll` while retaining separate `scroll_native_list`; TS lease throws `DIRECT_UIA_SCROLLPATTERN_NOT_LIVE_ACCEPTED` before a native call; native policy rejects both generic scroll actions even with forged requests and removes `SetScrollPercent`. Guarded metadata snapshots no longer query `ValuePattern` or `ScrollPattern`, publish `canSetValue=false` and `canScrollTopBottom=false`, and **mint no generic UIA mutation capability**. Native HWND Edit, Button and exact-index ListBox are unchanged. A future safe scroll implementation would require its **own live acceptance and explicit new authorization**, not re-enabling this transport by accident.

**Evidence**: .NET helper Release build 0 warnings/errors; TypeScript build PASS; Desktop2 candidate/lease and observer suite **90/90 PASS**; C# static contracts **21/21 PASS**; offline no-observer, release identity, and forbidden action tests PASS. Previously unsafe mock tests asserting generic UIA scroll success were replaced by fail-closed expectations. No new GUI app was started: host available RAM fell to **~457 MB**, below mandatory 1200MiB GUI preflight. Read-only inspection of installed Microsoft Notepad / Registry Editor / MMC / Winver command paths established candidates but did **not** establish zero-focus behavior or interaction compatibility. All third-party apps remain UNVERIFIED / production Computer Use RED.

## 2026-10-09 — REAL passive Desktop2 window census / external Microsoft app readiness

**Real Windows native read-only verification**: `test-area/desktop2-real-acceptance/passive-thirdparty-inventory.mjs` used the candidate AgentDesktopNativeBridge native host, official VDA and the installed Manager's *status-only* binding (no `init()`, no lease mutation or GUI start) to enumerate existing real Windows virtual Desktop2 windows, while checking the user remained on Desktop1 both before and after. Executed **twice**, both returned `pass=true`, `ownerDesktopBefore=ownerDesktopAfter=1`, `totalWindows=0`, `allowlistedProcessNames=[]`, `authorizedForInput=false`. This is **not** evidence of third-party application interaction, foreground invariance between reads, or readiness to mutate a window; no target existed. The census never saves/prints HWND, PID, titles, window content or non-allowlisted app identities. It denies pinned/foreground/foreign HWNDs, overlapping lease, ownership change, binding change and malformed inventory, and no user input/clipboard/screenshot/UIA calls are present. **8/8 source/unit adversarial tests PASS.**

**On-disk candidate identity (no GUI launched)**: Windows System32 `notepad.exe` (file version `10.0.26100.8457`) and `winver.exe` (`10.0.26100.1`) had Authenticode status Valid, Microsoft Windows signing identity. User's installed `Microsoft.WindowsNotepad` package reports version `11.2607.14.0`. These are binary/package authenticity checks **only**, not proof of which executable owns a future HWND, nor any WPF/WinUI focus safety. The passive census intentionally treats a process filename as **untrusted for authorization**, even when it matches a system app allowlist.

**LIVE EXTERNAL GUI GATE**: Host free RAM repeatedly below mandatory 1200MiB, including ~665–900MiB during candidate work. No `winver` / `notepad` was launched, no Desktop2 lease started, and no external GUI read/write operation was attempted. First external acceptance must use a fresh real Desktop2 lease, continuous VDA/WinEvent foreground watcher before any launch, verified independent Microsoft process/window identity and owner Desktop1, fail closed on memory pressure, and start with read-only app inventory. No OS-global SendInput, focus, mouse drag/wheel or clipboard, no editing of user files, no existing Notepad tab reuse, and no production candidate promotion until safe end-to-end proof. **Third-party Computer Use remains RED.**

## Primary evidence
- Native WinForms Edit: test-area/desktop2-real-acceptance/native-winforms-edit-findings-20261009.md
- Native WinForms PushButton: test-area/desktop2-real-acceptance/native-winforms-button-findings-20261009.md
- Prohibited direct WPF UIA: test-area/desktop2-real-acceptance/incident-20261009-direct-uia-focus-steal.md
- Local raw observer and owned app events in test-area/desktop2-real-acceptance/runs/ (Git-ignored) and %LOCALAPPDATA%\DMC\t\deskmcp-d2-lease-*/ (retained).

Microsoft BM_CLICK reference: https://learn.microsoft.com/en-us/windows/win32/controls/bm-click ; for an inactive dialog, the documented SetActiveWindow workaround is deliberately forbidden by DeskMCP's Desktop1 isolation requirement.
