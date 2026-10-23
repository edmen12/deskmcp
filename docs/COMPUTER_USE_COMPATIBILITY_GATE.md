# Computer Use compatibility and outcome-evidence gates — 2026-10-23

Candidate branch only. **Not** approval to merge, push, install, restart, use uncontrolled foreground input, or release native actions on third-party software.

## Know what was proved

| Stack / experiment | Evidence | Release interpretation |
|---|---|---|
| DWM-cloaked owned WPF UIA **read** | 5/5 expected controls using full scan; 4/5 interactive | Read/control discovery only; WinApp provider completeness not guaranteed |
| DWM-cloaked owned WinForms UIA **read** | 0/3 app child controls visible to WinApp; native HWND read 3/3 | UIA success is not app-control visibility; native fallback not automatically allowed |
| Owned WinForms native Edit | Historical guarded Desktop2 WM_SETTEXT with TextChanged callback | One fixture, one class/style, not a general text-editing privilege |
| Owned WinForms native PushButton | Historical guarded Desktop2 BM_CLICK with one Click callback | One fixture only; no generic third-party action approval |
| Owned WinForms native ListBox scroll | Fresh 2026-10-23 leased Desktop2: TopIndex 20 observed by app, stale precondition rejected | Observed scroll state, not a managed notification or general click equivalence |
| Owned WinForms native ListBox selection | Fresh 2026-10-23 A/B: external LB_SETCURSEL changes index 7 but triggers **0** managed SelectedIndexChanged events; in-app assignment triggers **1** | State change is not business event delivery; do not expose as user-equivalent selection |
| Chrome/CDP on real Desktop2 (disposable owned browser profile) | 2026-10-10 archived three Chrome-specific BrowserRuntime E2Es: real D2, app input/click effects, **0 owned Chrome foreground events** in each, full cleanup | Proven only for specific staged Chrome/CDP launch & target flow; **not** generic WinApp/Electron native GUI Computer Use |
| General third-party WinForms, WPF, WinUI, Electron native actions | **No accepted test matrix** | RED — unverified and not enabled in production |

The archived Chrome E2E result files are in the **separate** `DeskMCP-D2-Native-Acceptance` worktree under `test-area/desktop2-real-acceptance/runs/real-thirdparty-chrome-2026-10-10T*`. A read-only recheck of these **three exact archived passing trials** reports:
- 3/3 with no foreground event attributable to the owned Chrome process and app-level test-page effects
- Only **1/3** with zero *all-session* foreground transitions; the other two have 3 and 2 unrelated transitions, respectively (**5 total**)
- 3/3 with Browser/observer exit and lease retained through cleanup

**Caveat:** the prior 2026-10-10 Chrome startup path also had a documented **owned-Chrome foreground takeover**, before a safer no-startup-window/CDP flow was trialed. Do not reuse the old launcher or generalize the staged fix. The 3 Chrome E2E trials are not a long-term stability/SLA proof; no fresh third-party app window was started or interacted with during this follow-up. For a read-only repeat:

```powershell
node scripts/verify-thirdparty-chrome-evidence.mjs "C:\Users\User\Desktop\DeskMCP-D2-Native-Acceptance\test-area\desktop2-real-acceptance\runs"
```

## Fresh passive real Desktop2 census — 2026-10-23

The source-only candidate gained a **strictly read-only** `list-virtual-windows` native host operation and `scripts/passive-desktop2-thirdparty-inventory.mjs`. The native implementation checks the real user desktop is D1, the target is exactly D2, and each returned window belongs to the **non-current** virtual desktop rather than the foreground/pinned/shared desktop. It does not start, move, activate, screenshot or send input to a GUI. It excludes the Agent Desktop safety HUD and strips window **titles** from native output; the runner further omits raw HWND, PID, private process names and class names. Windows processes on an inert allowlist may be categorized by executable filename, but **file names are not verified signatures** and confer no permission to control apps.

The initial attempt to run the archived inspection harness failed before enumeration because its standalone AgentDesktopHost lacked a local `VirtualDesktopAccessor.dll` and had no `DESKTOP_MCP_VDA_PATH` configured. The native `info` returned `virtualDesktopAccessor=false` and an **unknown** desktop number. This was a missing capability, **not evidence the user switched to Desktop2**. Using the existing installed DeskMCP VDA DLL path as an **explicit read-only environment setting** restored capability without touching installed files. The archived inspector and the new candidate's own native host independently returned a verified `Desktop1 1→1`, **0 D2 windows**, and no input authorization. No third-party GUI was launched, moved, inspected through UIA or acted upon in this round. Since there were no candidate windows, **third-party native GUI compatibility has not been tested**.

Reproducible candidate-only probe (requires local built native host and a previously installed trusted VDA DLL):

```cmd
set "DOTNET_ROOT=C:\Users\User\Desktop\DeskMCP\runtime\dotnet-sdk"
set "DOTNET_ROOT_X64=C:\Users\User\Desktop\DeskMCP\runtime\dotnet-sdk"
set "DESKTOP_MCP_VDA_PATH=C:\Users\User\AppData\Local\Programs\DesktopMCP\virtual-desktop-accessor\VirtualDesktopAccessor.dll"
node scripts\passive-desktop2-thirdparty-inventory.mjs
```

Without an explicitly available VDA dependency the tool **fails closed**; it does not guess the active desktop. Error `PASSIVE_D2_VDA_UNAVAILABLE` is distinct from `PASSIVE_D2_OWNER_NOT_DESKTOP1`; an active D2 lease, missing/broken desktop GUID or changing state also refuse the read. `no_candidate_windows` is a **no-target outcome**, not a verified empty application or a compatibility PASS. This remains **source-only**: it does not register an MCP GUI action and does not change production app-control policy. Native window enumeration is visibility-limited and can omit unavailable/closing windows; the result is not a complete inventory guarantee.

## Product-facing outcome contract

After a mutating `desktop_ui_action`, `succeeded=true` only means the backend call returned; it **never** establishes application callback or business outcome. Candidate `ui_postcondition` is an optional bounded one-off read of an *exact* selector using `present`, `enabled` or `value_equals` (default `scan_mode=full`). For example:

```json
{
  "action": "invoke",
  "selector": "Submit",
  "ui_postcondition": {
    "selector": "Status",
    "condition": "value_equals",
    "expected_value": "Submitted"
  }
}
```

A single unique non-truncated UIA control matching the condition returns `ui_postcondition_status=met` and `ui_postcondition_verified=true`, but **`outcome_verified=false`**, `app_event_verified=false`, `business_outcome_verified=false`, and `outcome_evidence_level=ui_state_only_business_unverified`. The UI may change before a corresponding backend transaction commits, or a native message may update an index without notifying the app. This is not a substitute for app-owned event/business evidence.

A present exact control with a wrong known value gives `not_met`, whereas missing, truncated, ambiguous, unavailable, lease-changed or otherwise limited observations are `inconclusive`. A failed postcondition never triggers an automatic retry; for a non-idempotent action, the previous dispatch may have succeeded despite loss of later observation. The feature is optional; previously supported unscoped desktop actions and Agent Desktop restrictions remain unchanged. Read-only `wait_for` continues to be separate.

## Required pre-release tests

1. For each **native control class/style**, run a fresh owned-fixture Desktop2 A/B test with independent observer armed *before* operation, exact current window/PID/lease, app event and state witnesses, abnormal termination and stale HWND/selector rejection.
2. Use **actual third-party software** via a dedicated, non-disruptive controlled profile, with owner-approved scope; verify process-owned foreground attribution from the moment of launch, not just Desktop1 index before/after.
3. Require non-idempotent actions to distinguish backend delivery, UI state, app event, business effect and cleanup. Mark unknowns inconclusive; never synthesize event messages or fall back to global input without separate acceptance.
4. Preserve release isolation: candidate commits/tests alone never change installed service, production branches, user desktop or current app sessions.

**General native Computer Use release status: RED.**
