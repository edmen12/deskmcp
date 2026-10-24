# Real Windows Desktop 2 — current-release-base integration gate (2026-10-24)

Status: **STAGING SOURCE + REAL OWNED WINFORMS E2E PASS; NOT RELEASE-READY**.
Isolated branch: `feat/real-d2-currentbase-integration-20261024`.
Base commit: `c2ad782290a7bad780764d34aa79add54863f944`.
No installer, Gateway process, Production settings, desktop bindings, or user application was changed.

## What was ported

Only the controlled real-VDA Desktop2 read/invoke candidate modules and explicit opt-in registration were brought over from the source-only candidate. This is **not a merge of its older runtime**. Legacy `desktop_ui_windows`, `desktop_ui_action`, desktop policy, HUD manager, install runtime and public default MCP contract retain the `c2ad782` implementations.

Modules: `desktop2-window-inventory`, `desktop2-computer-use-candidate/session`, `desktop2-observer-lifecycle`, `desktop2-direct-uia-lease`, `desktop2-real-owned-control/compose/mcp-tools` and optional read-only inventory. To preserve actual installed-native ABI, the optional unaccepted background WM route is explicitly **not wired** to `AgentDesktopNativeBridge` and cannot be reached through the owned-control MCP endpoints.

`src/index.ts` deliberately never passes a `realD2Owned` bridge to `startHttpServer`; production does not register these action endpoints. Registration requires BOTH injected independent launch-attestation authority AND `DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT=1`; an environment flag alone cannot activate it. The action tools accept only three native operations: exact-old-value Edit, observed push button, and bounded ListBox top index. No UIA ValuePattern.SetValue, global SendInput or clipboard sharing.

One-use public permits live in a WeakMap keyed by the **trusted injected internal bridge**, not in a request-scoped MCP registration closure; expire at 30 seconds, are burned before provider invocation, and are cleared on a failed policy/audit/operation. Native IDs are not leaked to MCP clients. The test failure that revealed request-scoped permit loss was reproduced and fixed in the separate candidate before porting here.

## Verification (fresh, this branch)

- TypeScript compile and `npm run build`: PASS.
- Full `npm run test:fast`: **304/304 PASS**.
- Real loopback HTTP MCP client tests (actual connection and multiple RPCs): PASS for default-unavailable tools, injection+flag requirement, opaque control ids, cross-request action, replay refusal, policy denial.
- Real GUI test with an installed `c2ad782` HUD lease, independent VDA/WinEvent observer and a hash-pinned, **self-owned disposable WinForms** process: `test-area/desktop2-real-acceptance/runs/native-owned-bridge-2026-10-24T08-30-51-071Z/result.json`. PASS: exactly 1 TextChanged, 1 Button Click, ListBox TopIndex=20; Desktop1 1→1, target focus events 0, GUI exited, observer exited, active lease held through teardown, followed by explicit stop. Final `control.json` at test close: `generation=605`, `controls=[]`, `reason=explicit_stop`.
- The above GUI PASS used previously built native observer/UIA helpers. **Fresh native source build is now verified separately**: imported WinEvent observer, Direct UIA, disposable WinForms fixture and current-base AgentDesktopHost C# source; all four `net10.0-windows` Release builds completed with **0 errors, 0 warnings** using preinstalled SDK `10.0.400`. Fresh helper DLL hashes differ from the prior candidate builds, and the GUI runner now points only to the newly built in-branch binaries, with the new pinned fixture SHA256 `f189d5c5c2352e6bdbde58386d92b07a6adc1149d64332b2d2844f7c086a9904`.
- **Fresh offline native guard suite 5/5 PASS**: UIA policy, strict foreground-watcher self-test, fail-closed missing observer for native Edit/Button/List, and quarantine of foreground-stealing ValuePattern and unverified Invoke.
- **Fresh stage created, NOT installable**: `scripts/stage-real-d2-native-candidate.mjs` reproducibly rebuilds current branch native helpers, copies only AgentDesktopHost/observer/UIA apphost+DLL+runtime configuration (3 components, 12 assets), and hashes every source/asset in a manifest under `test-area/desktop2-real-acceptance/runs/native-stage-*`. Stage is explicitly marked `releaseApproved=false` and cannot install anything.
- **Fresh new-native GUI retest is not a functional result**: before launching the disposable GUI, the unchanged memory safety preflight saw only **1083MB available (<1200MB)** and returned `NATIVE_GUI_INSUFFICIENT_HOST_MEMORY` with exit code 3. No GUI or mutation ran; lease was explicitly stopped and Desktop 2 returned `Free`. Subsequent read-only sample was ~815MB; user applications/WSL were left running, safety threshold was not reduced. New in-branch binaries therefore have **native build + offline guard PASS, real GUI E2E PENDING**.

## Blockers: RED until independently passed

1. **Gateway-owned launch and identity**: test harness owns its child and checks pinned fixture SHA256/PID/HWND; a production trusted Job Object owner, binary-path/start-time/process-tree attestor, non-activating prelaunch, cleanup and revocation are still missing. Existing `desktop_start_process(agent_desktop_lease_id)` is **private Win32 desktop object** and must never be promoted as actual Win+Tab virtual Desktop2.
2. **Native ABI/release packaging**: native source port, reproducible local builds, asset hashes, and offline fail-closed guards are **PASS**, but the new binaries have not passed real-D2 GUI E2E (blocked by low host memory), the actual `c2ad782` installer has not incorporated or signed the new Native helpers, and packaged runtime resolution, rollback and installer smoke remain **RED**. Existing earlier real GUI PASS used prior-candidate native binaries.
3. **End-to-end real Gateway**: local network MCP tests use an internally injected mock bridge to prove transport and permit lifecycle; real GUI test uses the composed bridge directly, not through an MCP transport. These two successes are separate and cannot be called a real GUI-through-Gateway-MCP E2E.
4. **Third-party application safety**: WPF/WinUI/Electron/Chrome behaviors, multi-display no-focus, actual physical HUD Exit, minutes-to-hours soak, concurrent clients and test of all fault-injection/rollback flows remain unverified. Unproven transport must be denied, never switch Desktop1 away-and-back or use global clipboard.

No Production update, source merge to main, tag, install, service restart, or remote push is authorized by this acceptance.
