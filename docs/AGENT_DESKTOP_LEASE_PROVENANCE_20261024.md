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
