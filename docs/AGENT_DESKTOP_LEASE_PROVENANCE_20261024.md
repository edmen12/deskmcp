# Agent Desktop lease revocation provenance and passive stability — 2026-10-24

Status: candidate implementation and isolated tests PASS; **not deployed to installed DeskMCP**. This is not a claim of conclusively solving the historical one-off revocation or guaranteeing all-duration stability.

## Observed real machine evidence

A fresh Agent Desktop2 HUD-backed lease was started only after status confirmed D2 free. A standalone candidate passive check called `AgentDesktopManager.assertLease` and the native virtual-desktop info on every sample, with **no GUI launch, computer input, window inspection, or change to persisted live control state**.

- **18/18** HUD/lease heartbeat checks passed over **16,827 milliseconds** of measured sample time
- Owner remained on Windows virtual **Desktop 1**, and the same Desktop2 lease remained active and bound
- Lease's own generation remained **556 → 556**
- No general Computer Use authorization was issued; the test lease was explicitly stopped, returning Desktop2 to Free

Command: `scripts/verify-agent-desktop-lease-stability.mjs <lease-uuid> OWNED_AGENT_DESKTOP_HUD_STABILITY_READ_ONLY`. Requires an explicitly started D2 lease, candidate native host and available trusted VDA. Uses no `init()` or `stopControl()`. **Do not treat this short 16.8s run as an hours-long soak test.** It does not perform an independent win-event foreground hook because no GUI is involved.

## Source-level lease lifecycle findings

`src/index.ts` calls `agentDesktop.init()` at Gateway startup. `AgentDesktopManager.init()` resets the control list; if there were any controls, it increments document generation and removes the prior HUD state file. This is an intentional fail-closed ownership reset on a new Gateway process, but can revoke an existing test's valid lease upon a real Gateway restart. Other recognized removal routes include explicit `stopControl`, linked task completion via `stopControlForTask`, and the `startControl` HUD-ready timeout cleanup. A normal periodic HUD heartbeat check does not itself remove the control record; it denies use while stale.

**Historical case:** one earlier owned WinForms test saw a lease disappear before the fixture was launched; control state was empty when examined afterwards. The installed control error log and available audit do **not** provide a contemporaneous actor attribution. We cannot conclude whether a Gateway restart, stop request, linked task, new session, or other actor wrote the file. A missing HUD heartbeat alone would ordinarily produce a different error than a revoked lease, but this is diagnostic inference, not a retrospective event audit.

## New candidate-only atomic provenance

`AgentDesktopControlDocument.lastMutation` is optional for old records. On each candidate mutating write, a validated record is **atomically part of the same control.json commit**, under the existing cross-process lock:

| Committed reason | Event |
|---|---|
| `gateway_initialization` | `init()` reset and fresh owner handoff |
| `lease_allocated` | `startControl()` allocated lease |
| `hud_readiness_timeout` | Initial HUD failed to become ready; lease removed |
| `explicit_stop` | Caller requested a matching lease stop |
| `linked_task_completed` | Task Room closure removed its linked lease |

Record includes writer process PID, ISO timestamp, committed document generation and before/after active-lease counts; it does **not** include lease UUIDs, window titles, credentials, or user task labels. Last mutation alone is not an immutable, complete historical audit, and it can be superseded. `lastControlMutation()` exposes this record only to internal code. The existing protected WinForms fixture test's loss report will optionally include this most-recent committed reason and its generation relevance; it does not claim the actor's motive or a definitive root cause. A separate, durable audit trail and lifecycle release tests are still required before treating this as forensic certainty.

## Verification

- Isolated temporary state test: active D2 control document reset on Gateway init writes `gateway_initialization`, generation +1 and before/after 1→0.
- Explicit stop writes `explicit_stop`; linked task stop writes `linked_task_completed`; unrelated idempotent stop does not invent a mutation.
- Old control.json without `lastMutation` remains loadable; invalid reason, bad generation, invalid PID and inconsistent afterCount fail closed.
- Short real HUD stability probe **PASS**; no lease or installed Gateway modified except the explicitly granted/stopped *test lease*.

**Release decision:** Do not install/merge this candidate without reviewing on-disk data format compatibility, cross-process event attribution and behavior during intentional Gateway restarts. Keep automatic lease recovery disabled. All production Desktop1 non-interference protections remain in force.


## Batch 18 — real extended HUD check exposed an active-lease loss

A second, **extended** passive run was attempted using `scripts/verify-agent-desktop-lease-stability.mjs <lease> OWNED_AGENT_DESKTOP_HUD_STABILITY_READ_ONLY extended_read_only_60s`. It was configured for 72 read-only checks; **14 checks succeeded, then the run FAILed** before reaching the target. No GUI was launched, no input was sent, and the script did not call `init()`, `stopControl()`, or any action method. The installed Desktop2 status subsequently returned **Free**, persisted control document had `generation=559`, `controls=[]`, and the HUD state file was absent. The observed control document modification time was **2026-10-23 19:28:51 UTC**. This is evidence of a real lease lifecycle interruption, **not an accepted long-running stability pass**.

The installed Gateway process(es) visible after the failure had creation times preceding the test (October 20 and 22), and sampled audit records near the control-file modification did not identify an explicit user/MCP stop event. Neither observation rules out a short-lived secondary writer, a different control-plane actor, or older incomplete logging. Because the **installed** control document lacks mutation provenance, **the writer is not known**. Do not claim Gateway restart caused this specific occurrence; do not silently recover/recreate a revoked lease.

The candidate script now distinguishes lease revocation from HUD-heartbeat absence and other provider errors, returning only a sanitized failure category, current generation and Desktop1 status if verifiable. No automatic retry or action permission is granted. The failed run predated this classifier upgrade, so its emitted category remained `BACKEND_OR_HUD_UNAVAILABLE`.

## Corrected persistence and cross-session behavior

An additional defect was identified: legacy `init()` wrote an empty control document on every **idle** Gateway bootstrap, even if no lease was active, potentially replacing the most useful `lastMutation` record without incrementing generation. Candidate `init()` now **preserves the exact existing document when there are no active controls**; a missing control document receives an empty generation-0 baseline without claiming a revocation.

Candidate `control.json` retains up to **32 recent control mutations** as an optional `recentMutations` array alongside `lastMutation`, appended atomically under the existing cross-process lock. Validation requires bounded length, contiguous generations and consistent before/after control counts. The most recent entry must agree with `lastMutation`; comparison is by data fields, not JSON key serialization order. Old documents with only `lastMutation` or no provenance remain supported. This is a **bounded, mutable state history, NOT an immutable or tamper-proof event log**.

Isolated non-production tests include:
- Idle Gateway bootstrap never erases an earlier stop reason
- 32-entry history cap and chain consistency, malformed history fail-closed
- Two manager instances concurrently stopping different leases serialize without lost updates
- A stop racing Gateway initialization leaves no orphan active lease
- An isolated child process completes `init()` and **then exits with a nonzero code**, leaving atomic revocation evidence for another manager instance to read; **this does not test a crash halfway through the atomic rename**
- Equivalent JSON with reordered keys remains accepted

**Decision:** candidate state/event attribution improvements pass isolated tests; **real extended lease stability remains RED**. No installed Gateway restart, update, merge or production migration was executed.



## Batch 19 — identified the missing writer and the matching real HUD safety failure

### Observed incident (strong time/cause match)

The installed Control Panel's own `agent-desktop/control-error.log` contains the **exact incident**:

```
2026-10-23T19:28:51.5683257Z Agent Desktop safety HUD is not on its bound desktop.
```

The live `agent-desktop/control.json` file was modified at **2026-10-23 19:28:51 UTC**, ended up with `generation=559` and `controls=[]`, and `hud-state.json` disappeared. This log line and the exact code path strongly support the following sequence:

1. The WPF Control Panel's periodic `AgentDesktopControlCoordinator.Tick()` detects a HUD desktop-identity failure inside `EnsureSafetyOverlayAsync` → `AgentDesktopOverlay.IsOnDesktop`.
2. The catch calls `TryRevokeAfterSafetyFailure`, which writes **control-error.log**, then invokes `RevokeControl` under the existing cross-process directory lock.
3. `RevokeControl` increments generation and rewrites `control.json`; a later tick removes the inactive HUD state.

Thus the **immediate safety-revocation trigger is identified**. What remains unknown is **why** the check failed: the blue edge window may have lost its desktop GUID, the HUD toolbar may have lost its GUID, the COM `GetWindowDesktopId` call may have failed/transiently returned an empty GUID, or the HWND may actually have moved. Historical logging only recorded the combined Boolean failure; we cannot retrospectively determine which window was responsible. Control-panel-error.log shows the same general warning on **October 17–23**, so this is not a one-off.

### Candidate-only cross-component correction

The WPF Control Panel is a **second writer** of `control.json`, separate from the Gateway. The earlier candidate-only `recentMutations` logic existed only in TypeScript. Existing WPF writers serialized a document without these fields, silently discarding the history whenever the Control Panel revoked controls.

Now **all Control Panel mutating writes** record the same atomic `lastMutation` + bounded `recentMutations` fields under the shared lock, with origin-specific reasons:

- `control_panel_safety_revocation` for a HUD/binding/provider safety failure
- `control_panel_startup_reset` for its active-control reset at Control Panel start
- `control_panel_manual_exit` when the HUD Exit button is used
- `control_panel_shutdown` for explicit active-control cleanup at Control Panel shutdown
- `control_panel_desktop_renumber` for a native desktop number update

The Gateway validator was extended to recognize these exact reason strings. Empty startup/reset calls leave unchanged idle documents intact. WPF HUD verification **still revokes immediately** on a failed safety check; there is no auto-retry, focus stealing, desktop switching, safety bypass or broad action permission.

The safety failure message for **future candidate deployments** will additionally contain independently queried bounded diagnostic categories for **edge and HUD separately**: `correct_desktop`, `wrong_desktop`, `desktop_id_unresolved`, `window_handle_missing`, `com_hresult_0x...`, or `desktop_query_failed`. No HWND, window title, target GUID or private application details are added to that new category log. A diagnostic re-query may itself race with shell state, so this is **evidence**, not an infallible ground truth.

### Verification and release boundary

- WPF candidate Control Panel build: **0 warnings, 0 errors**.
- Candidate TypeScript build and focused control-panel provenance tests: PASS.
- **Actual .NET ↔ TypeScript bidirectional serialization compatibility:** `scripts/verify-agent-desktop-provenance-interop.mjs` loaded the built WPF assembly in a **non-GUI console process**, emitted a native `control_panel_safety_revocation` control document read by the Gateway, then round-tripped a Gateway `control_panel_shutdown` document through the native model. Both preserved their mutation history. Temporary synthetic data only; production `control.json` was **not touched**.

**Important:** this is a **candidate source fix**, not installed. The installed Control Panel cannot yet emit the additional diagnostic categories/history until an explicitly approved installation. The historical event’s **immediate revocation reason is known**; the *underlying cause of the HUD-window GUID mismatch* and long-session safety reliability remain **UNVERIFIED**. No new live D2 session was started this round.


## Batch 20 — passive real Windows HUD window ownership reproduction (2026-10-24 MYT)

**VERIFIED / LIVE FAILURE REPRODUCED; NOT FIXED OR DEPLOYED.** A standalone, candidate-only observer was built with the local .NET 10 SDK (0 warnings / 0 errors). It uses read-only Win32 window enumeration, exact DeskMCP Edge/HUD title and process-name filtering, `IVirtualDesktopManager`, and (in later runs) read-only HWND/style and `DWMWA_CLOAKED` inspection. It never calls MoveWindowToDesktop, launches GUI, authorizes computer input, writes production control state, changes foreground or switches desktops. A separate candidate WPF fixture explicitly moves **only its own** test windows and never touches an Agent Desktop lease.

### Observed installed Control Panel evidence

- **First real passive lease:** 52 samples, 5,705 ms, lease LOST. At **2026-10-23T20:23:32.643Z** Edge changed from target Desktop2 GUID to `desktop_id_unresolved` and `on_owner_desktop`, while HUD remained `correct_desktop` / `not_on_owner_desktop`. This repeated at 20:23:32.868Z. The Control Panel logged `Agent Desktop safety HUD is not on its bound desktop` at **20:23:32.929Z**, then `control.json` became empty. Owner remained Desktop1 in every sampled observation.
- **Second real passive lease:** **75,077 ms / 686 samples / 0 anomaly** with Edge and HUD remaining on Desktop2; both HWND identities and extended styles stayed stable. This lease was explicitly stopped after the observation. A single 75s PASS cannot cancel the preceding real FAIL.
- **Third live lease:** revoked before the separately launched observer could attach. Installed safety log gained the same message at **20:31:39.738Z**. This motivated a pre-armed read-only observer that waits for the *next* distinct control generation before monitoring.
- **Pre-armed fourth live lease:** 20 samples / 2,139 ms, lease LOST. At **20:33:33.897Z** the **same Edge HWND** with the **same extended styles** (`WS_EX_LAYERED=true`, `WS_EX_NOACTIVATE=true`, `Topmost=true`, `WS_EX_TOOLWINDOW=false`) changed from correct Desktop2 assignment to `desktop_id_unresolved` / `on_owner_desktop`; the HUD retained its correct Desktop2 assignment and the same HWND. Installed Control Panel safety error at **20:33:34.104Z**; lease removed shortly thereafter. This directly rules out Edge HWND recreation or an extended-style change as the *necessary cause in this observed event*, but cannot identify who/what changed Shell desktop assignment.
- **Pre-armed fifth live lease:** 31 samples / 3,343 ms, lease LOST; the installed Control Panel logged the same safety error at **20:35:14.920Z**. On the preceding safe samples, both windows had `DWMWA_CLOAKED=2` (Shell cloaked while owner stays on Desktop1); the sampled interval **did not catch the instant of the fifth failure**, so no claim about cloaking at failure is made.

All newly acquired test leases ended as Desktop2 Free. No installed binary, Control Panel, Gateway, AQP service or credential was upgraded, restarted or modified. The existing safety revocation remains enabled. The read-only native observer is at `test-area/agent-desktop-hud-affinity-observer/`; original JSONL evidence remains **local ignored artifacts**, not Git-tracked. No independent WinEvent foreground hook or Desktop1 pixel capture ran; `owner_desktop1=true` means the virtual desktop did not switch, **not** full proof that no D1 window appeared.

### Isolated self-owned GUI A/B; not a release gate

- WPF Edge + HUD fixture with Edge `DropShadowEffect`: **FAIL twice** (14,565 ms and 5,657 ms).
- Same WPF fixture without Edge effect: **PASS once** (35,034 ms / 372 checks), **FAIL once** (100 ms). The effect is **not** established as sole root cause or sufficient repair.
- WPF fixture with an offscreen-created, non-layered single Edge bar and the same HUD: **FAIL at 2,897 ms**. Merely disabling layered transparency is not a proven repair.
- Pure Win32 offscreen non-layered `STATIC` frame fixture: initial COM desktop binding **FAILED** with `TYPE_E_ELEMENTNOTFOUND`; it is not a viable drop-in replacement in this tested form. Its four owned HWNDs were destroyed on exit.
- Corresponding candidate-only fixture sources: `test-area/hud-edge-production-repro/` and `test-area/native-hud-edge-fixture/`. Both compiled with 0 warnings/errors, but native runtime failure remains a genuine FAIL.

Chromium independently documents that `IsWindowOnCurrentVirtualDesktop` and `GetWindowDesktopId` can be inconsistent for recently created HWNDs; see https://chromium.googlesource.com/chromium/src/+/e4f1aef5f3ec30a28950d766612cc2c04c822c71/ui/gfx/win/hwnd_util.cc . This is **external context**, not evidence that DeskMCP's repeated post-initialization failures are benign.

**Current decision:** Keep real lease stability RED. Do **not** turn off Edge/HUD identity checks, auto-reassign a revoked lease, auto-switch desktops, extend a grace interval that authorizes unsafe GUI actions, merge, or deploy based on these tests. Next: instrument a complete, production-eligible non-layered top-level window alternative (not a `STATIC` popup) in isolated tests, and capture exact DWM Cloak / foreground provenance at the same failing HWND instant before considering any safety-preserving replacement.

**Batch 20 source regression (fresh):** `npm run test:fast` completed **279/279 PASS**, exit code 0; all three candidate-only .NET fixture projects built with 0 warnings/0 errors. This is a source/test result, **not** HUD long-run release acceptance.

**Batch 20 continuation — higher-frequency pre-armed read:** changed only the standalone passive observer's sleep from 100 ms to 25 ms (not Control Panel tick or lease rules). A fresh HUD-backed lease ran **35,021 ms / 1,117 samples** and remained active throughout; 11 early samples counted as window anomalies *during normal initial D1-to-D2 Window.Move*, before the windows were established on D2. All saved post-initialization observations reported both windows `correct_desktop` and DWM Shell cloaking; the test lease was explicitly stopped and Desktop2 returned Free. Do not count those 11 bootstrap samples as a post-ready stability failure. This PASS cannot override the independently captured real revocations or establish a safe replacement design. A failing-time DWM cloak sample and independent D1 foreground/pixel evidence are still OPEN.


## Batch 21 — hidden WPF owner vs ownerless virtual-desktop affinity (2026-10-24 MYT)

**EXPERIMENTAL SOURCE VERIFIED / RELEASE STILL RED.** Follow-up to the Batch 20 real installed Edge GUID-loss evidence; no change to the installed Control Panel, Gateway, existing leases, AQP processes or credentials.

### Direct real-Windows isolated A/B evidence

- Independent registered Win32-class HWND fixture, offscreen + `WS_EX_NOACTIVATE` + non-layered, tested `WS_OVERLAPPEDWINDOW` and `WS_POPUP`: **both FAILED** initial virtual-desktop ownership with `TYPE_E_ELEMENTNOTFOUND / 0x8002802B`. The custom HWND registered and was destroyed on exit; it did not obtain a verified usable D2 assignment. Fixture: `test-area/native-edge-registered-class/`. .NET build 0 warnings/errors.
- WPF HUD-only with existing transparent top-level `AllowsTransparency=true`, `ShowInTaskbar=false`: **FAILED at 44,082 ms / 468 samples**, `desktop_id_unresolved`, no Edge created. Edge is **not** the only window type subject to this loss.
- WPF HUD-only `AllowsTransparency=false`, `ShowInTaskbar=false`: one **75,031 ms PASS** and another **28,031 ms FAIL** (`desktop_id_unresolved`). Removing transparent layering alone is **not** sufficient.
- Native `GetWindow(hudHwnd, GW_OWNER)` on a WPF HUD with `ShowInTaskbar=false` returned a **nonzero owner HWND**, whose VDA identity query failed with `0x8002802B`. This proves there is a hidden WPF owner for this fixture; that owner being causal in future reassignments remains an inference, not a proven OS internals claim.
- WPF opaque HUD-only with `ShowInTaskbar=true`: `GW_OWNER=0` (no owner), two isolated **PASS** runs of **75,037 ms / 796 samples** and **75,072 ms / 795 samples**.
- Explicit WPF D2 root owner trial: root window assigned `correct_desktop`, but both child Edge/HUD immediately reported `desktop_id_unresolved` despite deliberate move calls: **FAILED at initialization**. Moving an explicit owner to D2 does not fix owned WPF safety windows in this tested form.
- WPF original-looking *two-window* Edge (blue animated transparent full-screen edge) + HUD (transparent top bar), both with `ShowInTaskbar=true`: independently confirmed `GW_OWNER=0` for **both**, and two isolated **PASS** runs: **75,037 ms / 797 samples** and **75,086 ms / 795 samples**. Both windows remained correctly assigned to Desktop2 and virtual desktop number remained Desktop1 in each WPF fixture observer sample. This is stronger evidence than single-HUD testing but remains well short of a full product E2E or repeated long-session reliability proof.

The correlation is consistent with Windows Shell HWND ownership eligibility: the ownerless taskbar-eligible form survived four 75s single-/dual-window tests, whereas some hidden-owner forms failed. The exact Windows Shell internal mechanism remains **INFERRED**, not VERIFIED. Microsoft defines `IVirtualDesktopManager` in terms of top-level windows and does not guarantee reliable per-window affinity forever; see https://learn.microsoft.com/windows/win32/api/shobjidl_core/nf-shobjidl_core-ivirtualdesktopmanager-getwindowdesktopid and https://chromium.googlesource.com/chromium/src/+/e4f1aef5f3ec30a28950d766612cc2c04c822c71/ui/gfx/win/hwnd_util.cc for public API and Chromium's handling of GUID_NULL observations.

### Candidate opt-in only

Source `control-panel/wpf/AgentDesktopControl.cs` now reads `DESKTOP_MCP_AGENT_DESKTOP_OWNERLESS_SAFETY_WINDOWS_EXPERIMENT`. **Only when exactly `1`**, the Edge and HUD each use `ShowInTaskbar=true` (thus no implicit hidden WPF Owner in the isolated tests). Otherwise the original `false` remains in effect. All prior guardrail calls are unchanged: two HWND desktop identity checks, lease-bound start, HUD heartbeat, WPF safety revocation on mismatch, `ShowActivated=false`, edge `WS_EX_NOACTIVATE`, no forced desktop navigation, no input grant. No changed default installation or settings. The separate fixture and source-only flag must not be considered an approved deployment path.

- Fresh candidate WPF Control Panel build: **0 warnings / 0 errors**.
- Fresh `npm run test:fast`: **280/280 PASS**, includes new guard asserting the opt-in switch, both windows, and unchanged safety revocation.
- Not verified: **real candidate Control Panel with flag on**, > several-minute live HUD lease, actual taskbar visibility on Desktop1 or Desktop2, independent WinEvent foreground watcher (the fixture only checked current virtual desktop number, not every focus event), operator ability to press HUD Exit under mode, true absence of D1 UI interference, and rollback/production release.
- **Decision:** preserve the installed release, keep release RED, do not merge/push/install/restart. Next isolate a candidate Control Panel in a fully separate state root with an independent WinEvent/foreground monitor, validate WPF taskbar UX and D1 safety on repeated 5–10 minute sessions, then gate any deployment on explicit maintenance approval and real HUD lease + Exit + cleanup checks.

**Batch 21 independent foreground follow-up:** The isolated `both_taskbar` WPF fixture was updated to arm `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` **before creating its windows** and fail if any fixture-owned process HWND becomes system foreground. Fresh Windows run: **60,064 ms, 637 identity checks, `own_foreground_events=0`, `foreground_hook_armed=true`, Edge/HUD both `correct_desktop`, owner virtual desktop remained Desktop1, exit 0**. This covers fixture-owned foreground events observed by the hook, not taskbar flash/pixel overlays, all focus paths or the Control Panel's real process tree. The candidate implementation remains disabled by default, and real long-run release gate remains RED.


## 2026-10-24 live installed recurrence (read-only recheck)

**VERIFIED (installed release, not a candidate acceptance):** User-reported `Agent Desktop safety HUD is not on its bound desktop.` matched additional native Control Panel `agent-desktop/control-error.log` entries at **2026-10-23 20:56:00.5736563 UTC** and **2026-10-23 21:01:01.3503258 UTC**, i.e. **2026-10-24 04:56:00 and 05:01:01 MYT**. The installed `agent-desktop/control.json` is `generation=575`, `controls=[]`, mtime **2026-10-23 21:01:01 UTC**; fresh Agent Desktop status = **Desktop2 Free**. Installed `release-target.json` still identifies **`343ba99`**, whereas the isolated candidate branch remains **`1bb15c6` / clean**. Thus the new ownerless-shell-window experiment and richer edge/HUD failure categories are **not installed** and cannot be credited with fixing (or directly explaining) the installed failure.

**No restart evidence:** installed DeskMCP PID 4872 began on October 20 (before both errors); Explorer and DWM process start times likewise predate them. A bounded read-only query of Application/System error/warning events around the two recent incidents did not return a relevant DeskMCP/Explorer/DWM/Shell crash event. This does not prove the Shell never changed window ownership or exclude transient COM failure. The legacy message does not identify which exact safety HWND failed this time. Earlier read-only real-window observations captured Edge GUID loss on previous incidents; applying that exact cause to these two latest instances would be **INFERRED**, not VERIFIED.

**Isolation feasibility, not runtime acceptance:** current candidate Control Panel source supports `DESKTOP_MCP_DATA_ROOT`, `DESKTOP_MCP_SETTINGS_DIR`, `DESKTOP_MCP_INSTANCE_NAMESPACE`, `DESKTOP_MCP_STARTUP_LINK_PATH`, `DESKTOP_MCP_TUNNEL_PROFILE_PATH`, `DESKTOP_MCP_DISABLE_TUNNEL`, and `DESKTOP_MCP_PORT` overrides. A candidate executable was invoked only with the non-GUI `--agent-safe-isolation-self-test` and isolated overrides; exit code was 0, but this Windows GUI-subsystem binary did not surface a test-specific stdout marker. **A full isolated Control Panel runtime and any real candidate ownerless HUD lease remain NOT EXECUTED.** Its startup/background side effects require separate verification before launch. No installed binaries, settings, credentials, startup entries, running services or production lease state were changed; no new lease started.

**Release gate remains RED.** Never suppress safety HUD affinity checks or treat a lost lease as recoverable without new authority. Continue from a fully isolated, safety-instrumented candidate runtime and authenticated long-session HUD+Exit+Desktop1 no-interference acceptance, not by restarting the installed Gateway.


## Batch 22 — compiled real Control Panel overlay / isolated Coordinator E2E (2026-10-24 MYT)

**VERIFIED in the candidate assembly; NO PRODUCTION CUTOVER.** Two strictly isolated entry points were added to the **real candidate WPF Control Panel executable**, which can run without starting `ControlPanelRuntime`, Gateway, updater, tunnel, tray, startup shortcut, or native Computer Use. Both require a hard-pinned test-only `DESKTOP_MCP_DATA_ROOT` under `test-area/ownerless-isolation-smoke/data`, `DESKTOP_MCP_INSTANCE_NAMESPACE=ownerless-isolated-smoke-20261024`, tunnel-disabled and the opt-in ownerless safety-window flag. These are test probes, not general MCP capabilities.

1. `--agent-desktop-overlay-isolated-probe <seconds> [SYNTHETIC_HUD_BUTTON_EVENT]`: instantiates the **actual** `AgentDesktopOverlay` from `AgentDesktopControl.cs` and lets its real code create both windows, move only its own HWNDs to bound Desktop2, run the Edge pulse, and dispose. Windows `EVENT_SYSTEM_FOREGROUND` is armed before window creation. A 90ms WPF-STA observation verifies both desktop GUIDs, both windows' `GW_OWNER=0`, `DWMWA_CLOAKED=2` (Shell cloaked from Desktop1), current virtual Desktop1, and zero process-owned foreground events. A WPF synthetic `ButtonBase.ClickEvent` exercises the actual HUD Exit callback **without** mouse, keyboard, UIA or foreground manipulation.
2. **Actual overlay** isolated run: **65,116ms / 685 samples PASS**, Exit Code 0, both GUIDs correct, zero own foreground events, Edge and HUD ownerless, Shell Cloak=2 for both, clean process exit.
3. **Actual overlay + synthetic Exit** isolated run: **180,228ms / 1,887 samples PASS**, Exit Code 0, same safety invariants, exact HUD Exit routed-event callback fired and process exited. Synthetic event is **not** evidence of a human click / accessibility-provider result.
4. `--agent-desktop-coordinator-isolated-probe <seconds>`: constructs a **real** `AgentDesktopControlCoordinator` but deliberately does not call `Start()` (which registers the desktop switch hook). It calls the actual private `Tick()` on the WPF dispatcher every 450ms, with a **synthetic lease confined to the isolated data root**. Tests the real Overlay lifecycle, private `control.json`, native HUD heartbeat schema/freshness, fail-closed lease revocation, mutation generation/journal, removal of `hud-state.json`, and synthetic HUD Exit callback. It does **not** ask the production Gateway for a lease, authorize actions, register a shell hook, or touch the installed state.
5. **Actual Coordinator Tick + synthetic lease/Exit** first run: **75,181ms / 756 HUD heartbeat validity checks PASS**, Exit Code 0, `armed=true`, `visible=false`, zero test-process foreground events, Desktop1 unchanged. Final isolated `control.json`: generation **2**, empty controls, `lastMutation.reason=control_panel_manual_exit` with contiguous `lease_allocated@1` → `manual_exit@2`. HUD heartbeat file absent after Exit. This is genuine candidate Coordinator code execution but not a live Gateway lease or human GUI Exit.
6. Production `control.json` remained **generation=575, `controls=[]`**, installed build still `343ba99`, Desktop2 remained **Free**, no new installed candidate process left behind. Source build succeeded with **0 warnings and 0 errors**.

**Still OPEN/RED:** repeated 5–10-minute Coordinator real GUI heartbeat under independent instrumentation; full `ControlPanelRuntime.Start()` + Gateway-issued real lease and true HUD Exit; taskbar task-button flicker / Desktop1 pixel non-interference; WPF-native loop vs complete production process-tree behavior; release rollback/approval. Do **not** count synthetic test controls as real Agent Desktop bookings. Keep fail-closed GUID safety checks; no merges, pushes, installation, or restarts without separate approved cutover.


### Batch 22 long-session update — real candidate Coordinator source / **5 minutes PASS**

A second **strictly isolated** candidate-Coordinator test completed **300,211ms / 3,083 valid native HUD heartbeat observations, 0 unexpected revocations, 0 self-owned foreground events, exit 0**. The coordinator's actual `Tick()` continued to validate the bound Desktop2 HUD while the user's current Windows virtual desktop remained Desktop1. After 5 minutes, the actual WPF Exit button's **synthetic routed Click event** called the coordinator's real `ExitControl(leaseId)`; the isolated control document advanced from generation **3** active to generation **4** `controls=[]`, recorded `control_panel_manual_exit`, and `hud-state.json` was absent after completion. The four journal entries are contiguous: allocate 1 → manual exit 2 → allocate 3 → manual exit 4. Production `control.json` remained generation **575** and Desktop2 **Free**.

This establishes a **candidate 5-minute isolated control-loop acceptance**, correcting the earlier Batch 22 OPEN item for that narrow layer. It **does not** clear the end-to-end product release gate: production has an older build; no Gateway-managed lease, real `Start()` desktop-switch hook, official HUD user-click action, independent taskbar pixel/focus artifact scan, or full production session state was used. The release status remains **RED**, and the existing immediate safety revocation is unchanged.

Candidate `npm run test:fast` during the long session: **282/282 PASS**; tests additionally assert the strict test-root guard, 450ms real `Tick()`, bounded self-test invocation, isolation from `ControlPanelRuntime`, no programmatic desktop switch, and synthetic event/cleanup separation. Control Panel .NET Release build: **0 warnings/0 errors**.


## Batch 23 — real cross-process Manager allocation + MCP network, taskbar risk (2026-10-24 MYT)

**Scope**: Candidate branch `feat/computer-use-evidence-20261023`, no installed production changes or restarts. Two strictly guarded test harnesses under `test-area/ownerless-gateway-handoff/` use a **private** `data/agent-desktop/{config,control,hud-state}.json`, explicit Desktop2 ID, private audit, and no copied production secrets. The WPF test invokes **real** `AgentDesktopControlCoordinator.Start()` and thus its registered virtual desktop event hook. The Node test invokes **real** `AgentDesktopManager.startControl()/stopControl()` with installed native `DeskMCP.AgentDesktopHost.exe` only as a bounded native command bridge.

### Cross-process and actual MCP protocol results

- **Direct Manager ↔ WPF handoff**: Manager process status `REAL_MANAGER_HANDOFF_PASS`, **62,333ms**, **227 active authorization checks**, `readiness_pass=true`, `explicit_stop=true`, `stale_rejected=true`; WPF process `REAL_MANAGER_HANDOFF_PASS`, **76,396ms**, **511 valid HUD heartbeats**, **534 active-lease observations**, **0 process-owned foreground events**, owner remained Desktop1, HUD removed after stop. The private generation incremented **1 allocation → 2 explicit stop**; the external production `control.json` remained generation **575**.
- **Actual `desktop_agent_desktop` MCP protocol**: An isolated loopback-only server registers exactly **one** production `registerAgentDesktopTools`-provided tool; no other capabilities, full index.js, backend bridge, updater, tunnel, real installed Gateway or Internet listener. The client executes real MCP `status`, `start`, sustained `status(lease_id)`, then `stop`. First run: **49,922ms / 126 valid MCP authorization checks / 421 valid WPF heartbeats**, all PASS, exact private mutation sequence allocation@3→explicit_stop@4. After Stop, the previously valid lease cannot be asserted. Native candidate HUD is real.
- **Hook-verification rerun**: Changed the WPF probe to read the actual private `desktopHookRegistered` state (instead of assuming `Start()` implies hook ready) and fail closed if false. Fresh separate MCP run: **46,809ms / 119 authorization checks** PASS; WPF run **63,829ms / 393 HUD heartbeat checks**, `did_register_virtual_desktop_hook=true`, **0 foreground events**, success/cleanup PASS.
- These are candidate code + actual MCP network/protocol/tool registrations under strict private isolation, **not** an installed Gateway full runtime, real user task approval, nor a production lease.

### Desktop1 taskbar visual verification — INCONCLUSIVE / release RED

- Baseline ownerless window `ShowInTaskbar=true` stayed correct on Desktop2 in direct overlay tests, including an additional **60,055ms / 622 correct identity + Cloak checks, zero self-owned foreground events**.
- An independent Windows `Shell_TrayWnd` observer captured **only the center 1200px taskbar region to transient RAM** for pixel comparison. No images, actual pixels, UI titles of other apps, or screenshots were written or exported; the artifact contains only per-sample `elapsedMs / exact HUD HWND count / changedPixelCount`. Windows 11 taskbar UIAutomation exposed just **3 descendants** and could not reliably show task button names.
- First pixel run: idle baseline 13 samples of 0; with HUD present 185 samples mean **123.4** changed pixels, maximum **1,202**, but after HUD exit the changed-pixel values continued. **Cannot attribute** these differences to HUD.
- Second trace-enabled controlled run proved the camera itself or desktop environment varied substantially **before the HUD appeared**: at **3,919ms** with **0 candidate HWNDs**, **56,289** changed pixels; pre-HUD max **56,320**, first two candidate HWNDs observed only at **20,963ms**, with then **1,202** changed pixels. This invalidates any claim of pixel-perfect taskbar proof from those runs. Visual **zero-interference is not demonstrated**.
- Investigated Microsoft's `ITaskbarList::DeleteTab(hwnd)` applied only to our own two safety HWNDs and gated as a candidate-only flag. **Both tested modes FAILED**: applying before moving windows to Desktop2 caused immediate Edge GUID.Empty at initial move; moving first then calling DeleteTab produced **Edge+HUD GUID loss, DWM cloak 0** in the very first check at approx **187ms**, so the safety overlay failed closed. **The entire DeleteTab path was REVERTED to committed `349a676` source**; a regression now specifically prohibits inclusion of DeleteTab in the safety overlay. Do not use this workaround in production.
- No reliable taskbar visual clearance, no human HID Exit acceptance or full standard ControlPanelRuntime+full Gateway lifecycle. These remain **RED** even though isolated MCP and long-running overlay/Coordinator tests are green. The existing safety revocation on GUID loss remains mandatory.

### Fresh regression and product boundaries

- Candidate `npm run test:fast`: **284/284 PASS**; WPF Release win-x64 build **0 warnings / 0 errors**. Isolation tests assert the one-tool network surface, exact private root, no desktop activation, real hook state, no production controller, and no unsafe DeleteTab helper.
- All candidate processes exited, private lease state returned to `controls=[]`, official Desktop2 returned **Free**, and installed control document stayed `generation=575`. Production `release-target.json` still `343ba9974015b8bea3b44d0320e1eb9562d90984`.
- Next gate: reliable independent *rendered* taskbar indicator/foreground windows evidence while Desktop1 remains current; official whole-process Gateway/ControlPanel with private port and audit boundaries; real user-exercised HUD Exit; known-good staged rollback with explicit maintenance authorization. No merge, push, install or restart until approved.


## Batch 24 — entire primary taskbar A/B, full read-only Gateway, real UIA provider exit (2026-10-24 MYT)

**VERIFIED, strictly candidate-isolated, not a release approval.** All tests use the opt-in ownerless safety HWNDs under the previously hard-pinned private data roots and validate that Windows virtual Desktop1 stays current. The installed release source commit is still `343ba99`; no production restart, installation, deployment, registry setting, access-policy change, or merging occurred.

### Taskbar screenshot-no-persistence A/B (privacy safe)
Earlier fixed-first-frame pixel captures were not trustworthy because a capture changed before any candidate HWND existed. Added `taskbar-ab-observer.ps1`, warming up 12 RAM-only taskbar frames and selecting a medoid baseline; then samples HUD-absent, HUD-present and HUD-exited phases, recording only timestamps, exact candidate HWND count, per-zone changed-pixel counts, frame deltas and aggregate numbers. **No screenshots/pixel buffers stored to disk.** A 25-second HUD-absent control returned **93 samples, max/mean difference 0, max frame delta 0**.
- **Centered 1200-pixel taskbar run, 90 seconds**: pre-HUD **74/74** samples max changed pixels 0; HUD present **223/223** max 0; post-HUD **35/35** max 0. No capture jump, all twelve horizontal zones stable; real candidate overlay passed native desktop GUID/Cloak/foreground checks and exited 0.
- **Entire main taskbar (2560-pixel wide) `taskbar-all-observer.ps1`, 80 seconds**: pre-HUD **122/122** samples max changed pixels 0, present **148/148** max 0, post-HUD **24/24** max 0; `deltaMax=0` and `largeJumps=0` across all three phases. Candidate overlay performed **actual own-WPF-UIA-Invoke Exit** and exited 0. This proves only that **that captured primary Windows taskbar region did not change at the chosen 35-channel-value pixel threshold in these bounded sessions**. It cannot prove all desktop UI, secondary displays, mouse/keyboard focus, taskbar input, or physically exercised Exit always have zero interference. The unsafe `ITaskbarList::DeleteTab` workaround remains reverted and banned by regression.

### Full standard Gateway entrypoint, private loopback + read-only
- The **real candidate `dist/src/index.js`** was booted independently on `127.0.0.1:59123` with separate root, `DESKTOP_MCP_PROFILE=read-only`, allowed paths limited to the private test root, local private audit log, installed process/native hosts used solely for preflight, and separate Windows named-pipe namespace (port-specific). Verified `/health` `mode=desktop-runtime`, audit enabled, Agent Desktop registered, exactly one loopback listener owned by this launched candidate PID, and actual MCP client registration.
- Negative actual MCP `desktop_agent_desktop status` and `start` both correctly denied by read-only policy; **no lease was ever created by this full Gateway test**. The candidate closed through its own port-specific shutdown control pipe, and launched candidate process exited; the **installed** DeskMCP Gateway remains untouched. Machine-readable `full-readonly-runtime-result.json` reports **`FULL_READONLY_GATEWAY_SMOKE_PASS`** and all assertions true.
- This validates full product startup/recovery and permission fail-closed under read-only, **not** a full product runtime with desktop-control permission. The previous separate one-tool MCP client tests cover active lease control.

### Real WPF UI Automation provider Invoke, no Desktop1 switch
- Enhanced the actual candidate `AgentDesktopOverlay` isolated test harness to locate its **own** Exit button, create `ButtonAutomationPeer`, request `PatternInterface.Invoke`, and call `IInvokeProvider.Invoke()`; no `SendInput`, physical mouse, keyboard, switching desktops, UIA action against external apps, or process activation. First harness iteration **failed** because it synchronously checked for a WPF callback before the Dispatcher completed. Corrected the *test harness*, allowing up to **2,500ms** for the callback while maintaining all safety checks; this does **not** change production HUD safety logic.
- Re-run **35,081ms / 368 safety samples** PASS, `hud_uia_provider_invoke_checked=true`, `overlay_exit_callback_checked=true`, owner Desktop1 remains current, both HWNDs on Desktop2 with DWM Shell cloak=2, **0 candidate foreground events**, candidate exit 0. Repeated in whole-taskbar A/B run with 40-second owned-provider Exit and exit 0. This is **provider Invoke**, not a human physical click.

### Same actual MCP lease → actual HUD WPF UIA Exit → manager revocation
- Added third isolated end-to-end flow: bounded *single-tool local MCP* `start(Desktop2)` creates an actual Manager-generated lease; an independent **real WPF Control Panel Coordinator `Start()/Tick()`**, having registered its real virtual desktop notification hook, creates/heartbeats the real HUD. After 25 seconds of the same lease, the WPF harness verifies both HWNDs remain on Desktop2 and owner stays Desktop1, then invokes the **actual own HUD Exit UIA provider**. **Node does not normally call Stop**; actual Control Panel Exit is the writer of the revocation.
- **WPF real Coordinator**: `REAL_MANAGER_UIA_EXIT_PASS`, 55,320ms / 498 samples, **206 valid heartbeat checks**, `uia_exit_invoke_dispatched=true`, `uia_exit_mutation_confirmed=true`, `hud_removed_after_stop=true`, `did_register_virtual_desktop_hook=true`, **0 candidate foreground events**, process exited 0.
- **MCP network client**: `MCP_LEASE_OWN_HUD_UIA_EXIT_PASS`, **63 live authorization checks**, manager confirmed `control_panel_manual_exit` (not explicit Stop), old lease denied, HUD file absent, `managerStopInvokedForNormalExit=false`. Private control journal has contiguous allocation `generation=7` → **`generation=8`**, `controls=[]`, last reason `control_panel_manual_exit`, writer WPF process. Installed control still generation=575.
- The narrow-loopback MCP test deliberately does not start the entire full-control Gateway runtime or expose Computer Use/browser tools. No physical user Exit was tested.

**Release gate remains RED** for physical/manual UI interaction, truly whole-production-runtime control with strict protected sidecar auth, full desktop notification/taskbar per-user behavior, multi-display and staged rollback verification. Do not claim a proven universal zero-interference property. Keep safety GUID/Cloak checks fail-closed; no installed binary changes, merges, pushes or restarts without authorized staged release.


## Batch 25 — Full Control **entire Gateway** + exact installed recovery + installer fault rollback (2026-10-24 MYT)

**Actual candidate full-control Gateway passed. Installed DeskMCP remains untouched. New candidate SETUP not yet created; no release approval.**

### Full Gateway/Control Panel handoff in same session
- `test-area/ownerless-gateway-handoff/full-control-runtime.ps1` strictly pins a private data root, workspace root, audit log, settings, startup link, tunnel disabled, separate WPF instance namespace, and **`127.0.0.1:59123`**; it checks live installed PID and production `control.json` SHA-256 before/after, uses only owned candidate PIDs for cleanup, and verifies no leaked private lease/port. Launches **actual `dist/src/index.js` with profile `full-control`**, not a single-tool mock. No browser/Computer Use tools are called.
- Independent actual candidate WPF `AgentDesktopControlCoordinator.Start()/Tick()` registers the Windows virtual desktop callback, creates Edge/HUD on bound Desktop2 while Desktop1 remains the foreground desktop.
- The real full Gateway MCP client lists **29 tools** and calls **only `desktop_agent_desktop`**. It allocates a lease, performs **54 authorized/healthy status checks**, then waits for the actual own HUD `ButtonAutomationPeer` / `IInvokeProvider.Invoke()` Exit. Node **does not Stop()**. Gateway sees `control_panel_manual_exit` and stale lease cannot be returned; HUD state file disappears.
- **Gateway runner** result: `FULL_CONTROL_GATEWAY_MCP_HUD_UIA_EXIT_PASS`, `fullRuntimeReady=true`, `gatewayBoundLoopback=true`, `fullControlPolicy=true`, `independentAudit=true`, `wpfRealCoordinatorStarted=true`, `mcpHudExitVerified=true`, both candidate processes exit cleanly, test port released, private control file empty. **Production lease file hash unchanged and installed GUI PID unchanged.**
- **Candidate WPF result**: `REAL_MANAGER_UIA_EXIT_PASS`, **33,623ms / 298 samples / 205 good HUD heartbeat checks**, `foreground_events_owned=0`, Desktop1 remains current, native desktop switch notification hook registered, Exit journal confirmed, HUD removed.
- The separate status document advanced **generation=9 allocation → generation=10 `control_panel_manual_exit`**, recorded writer PIDs and ended `controls=[]`. Product Desktop2 remained Free throughout because only the candidate root was used.
- These results clear the **isolated full Full Control software E2E** gate, not physical human HUD click or actual installed release.

### Precise installed binary recovery source **343ba99**, verified
- Existing local `DeskMCP-Setup-0.9.23.exe` in `Desktop\DeskMCP\runtime\release` hashes SHA256 `31BF62DE77FAE470FD479BDE11AE3EEC23D4C8CA9288E22A6065D0AD0C965D1E`; embedded source provenance is **`f8b1cd3f2aac107aaa13378cded79878d1aa6eff`**, **NOT** installed **`343ba9974015b8bea3b44d0320e1eb9562d90984`**. The same semantic version number cannot qualify it as an exact rollback.
- `prepare-exact-rollback.ps1` read-only verifies all **32/32** protected installed payload hashes, then copies the installed program directory (and **not user data**) to `C:\Users\User\Desktop\DeskMCP\runtime\recovery\installed-343ba99-20261024`. Follow-up confirms **16,353/16,353** relative paths and byte lengths match, the snapshot protected manifest is **32/32**, snapshot source provenance **343ba99**, original source contract unchanged. Snapshot size **546,589,328 bytes (~521 MB)**. Result `VERIFIED_EXACT_PROGRAM_RECOVERY_SNAPSHOT_READY`; evidence `Desktop\DeskMCP\runtime\recovery\installed-343ba99-20261024-evidence.json`.
- A cold file snapshot is **not** an independently signed exact-version Setup and is **not** evidence that restoring or reinstalling the live program has succeeded. Preserve its integrity and do not mutate it in staging.

### Old Setup's real transactional rollback and interrupted-recovery tests PASS
- `verify-isolated-installer-rollback.ps1` creates a **short-path, valid 32-file baseline Fixture from the recovery snapshot**, not from the live program; pins an isolated installer mutex namespace/state/startup path, runs only **hidden CLI test flags** (no shortcuts/registry/launch).
- Old `f8b1cd3` Setup `--install-test-fail-after-backup` intentionally returns **10**, and original Fixture marker plus **32/32 hash manifest** are restored with no leftover staging or backup directory. `--recover-test` simulates an incomplete install and backup and returns **0**; marker recovered, **32/32** validated, temporary directories removed. Result `ISOLATED_EXISTING_INSTALLER_ROLLBACK_AND_RECOVERY_PASS`, production control state hash and original GUI process preserved. Temporary Fixture directories are cleaned; evidence in `Desktop\DeskMCP\runtime\recovery\rollback-fixture-20261024-evidence.json`.
- This test validates **the existing old installer's rollback mechanism** but **does not** validate a never-built new candidate Setup. **New candidate packaged installer, signed release, install/upgrade failure injection, true physical Desktop2 HUD Exit and cutover/rollback under maintenance are still RED**.
- No installation, production restart, Git merge/push, human desktop switch or Desktop1 keyboard/mouse injection was authorized/performed. Existing fail-closed desktop affinity safety remains intact.


## Batch 26 — Candidate Release Stage security audit remediation (2026-10-24 MYT)

- Attempted a **candidate-only** win-x64 Release Stage for `aad7840`. Reused SHA256-pinned Node 24.19.0, tunnel v0.0.13 and WinApp v0.5.0 archives from the local verified cache. Shared .NET runtime publish and native ProcessHost root/Job lifetime tests all PASS, and VirtualDesktopAccessor Rust release compiled from exactly `8172097993b1194e3d5e2ff38421ebb06f867b6c` (x64 `0x8664`), Host self-test PASS. An initial transient PowerShell command wrapper incorrectly treated native `git clone` progress on stderr as a terminating error; after correcting wrapper and checking out the pinned commit, that issue was resolved without relaxing build verification.
- **REAL RELEASE SECURITY BLOCKER FOUND**: production `npm ci --omit=dev --ignore-scripts --audit=true` audited 475 packages and reported **five advisories** (three high: `body-parser`, `markdown-it`, `zod`; two moderate: `fast-uri`, `ip-address`). The strict `found 0 vulnerabilities` release guard correctly stopped Stage generation. No candidate Setup was produced from that attempt.
- Updated direct `zod` to **4.6.7** in the root manifest, and repaired transitive package-lock resolutions to `body-parser@2.4.0`, `markdown-it@14.3.3`, `fast-uri@3.1.9` and `ip-address@10.7.4`, with related lockfile closures. Old vendored Desktop Commander itself declared `zod@^3.24.1`; npm `overrides` on the root did **not** remove the nested vulnerable Zod 3. Changed the vendored manifest explicitly to `zod@^4.6.7` and regenerated the lock, which now contains a single `zod@4.6.7` and **0 audit vulnerabilities**. Reinstalled root dependencies with fresh `npm ci --ignore-scripts`: **497 audited / 0 vulnerabilities**. No `npm audit --force`, no security skip.
- **Functional compatibility hazard caught by an independent negative smoke:** Desktop Commander's schema source compiled for Zod3 parsed arguments with Zod4 but `zod-to-json-schema` silently returned `{$schema: ...}` without tool fields. Merely achieving zero audit vulnerabilities was **not** a pass. Updated the vendored compiled schema runtime import and related declarations from `zod` to **`zod/v3`** (compatibility interface supplied by the patched `zod@4.6.7`). The smoke then verified `read_file` and `start_process` argument validation, and real JSON Schema conversion with required `path`, `command`, `timeout_ms` fields. Added a permanent Fast regression reproducing these conditions.
- Rebuilt Fast tests with patched lock and vendor modules: **290/290 PASS**. Integration suite initially failed because the standalone candidate process did not include the already-present local .NET 10 SDK on PATH; rerunning with a process-local PATH override resolved that environment issue. The integration suite then found two missing *expected names* in the test's two fixed tool-list arrays: `desktop_ui_object_windows` and `desktop_ui_object_snapshot`. Verified both were pre-existing real read-only Win32 Object tools requiring a valid lease and never granting user desktop action capability. Corrected only those two enumerations, **no permission logic changed**, and reran: **82/82 integration tests PASS**.
- This security fix requires a **new candidate source commit before Release Stage packaging**, because the stage and installer enforce exact clean-Git commit provenance. The candidate Stage/Setup and installer upgrade/rollback with this patched dependency closure remain pending until a new full stage build actually succeeds. Existing installed `343ba99` and its verified cold recovery snapshot remained unmodified. No installed replacement, restart, merge, push, desktop switch, or production policy change.

## Batch 27 — isolated candidate Setup artifact without Desktop1 GUI smoke

`471b46e` Stage passed: **15,054 files / 513.1MB, npm audit zero, exact stage source commit and native test PASS**. A subsequent review found that `scripts/test-release-stage.ps1` expected **27** MCP tools while real current Gateway has **29**, including two pre-existing scoped read-only Win32-object tools. Updated only the expected inventory (no permissions changed). Standard `build-installer.ps1` additionally launches an isolated but interactive Control Panel `--startup` to smoke test the GUI/Gateway. This would add a Windows tray item on Desktop1 and therefore is not acceptable as zero user-desktop visual interference.

Introduced explicitly opted-in `-PackageOnly -SkipStage` flag in the canonical build script (requires `DESKMCP_PACKAGE_ONLY_ACK=UNQUALIFIED_NO_GUI_ARTIFACT`). It executes the same exact-clean-Git release source, full Stage payload integrity manifest, ZIP SHA256, compiled installer with embedded source commit, and embedded commit verification. It then returns **before** GUI/installer smoke, with `SETUP_PACKAGE_ONLY_UNQUALIFIED=TRUE`, `PUBLIC_RELEASE_READY=FALSE`, `INSTALLER_GUI_SMOKE=NOT_RUN`. It **does not** modify default install, registry, startup or run a candidate Desktop1 panel; this candidate artifact cannot be signed/finalized/published as a passed release. Complement with an isolated CLI `--install-test`, failure-injection and interrupted-recovery test without launching GUI. The original fully qualified installer test remains unchanged for maintenance-window acceptance.

No production install/restart, Desktop1 focus switching, merge or push is authorized. A passing candidate-only installer test is not a live deployment or human HUD physical Exit test.
