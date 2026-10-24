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
- This test intentionally reuses the previously reviewed native observer + direct UIA binaries from `DeskMCP-D2-Native-Acceptance`. **It does not prove they are built, packaged, or version-compatible from this current-base branch's native source itself.**

## Blockers: RED until independently passed

1. **Gateway-owned launch and identity**: test harness owns its child and checks pinned fixture SHA256/PID/HWND; a production trusted Job Object owner, binary-path/start-time/process-tree attestor, non-activating prelaunch, cleanup and revocation are still missing. Existing `desktop_start_process(agent_desktop_lease_id)` is **private Win32 desktop object** and must never be promoted as actual Win+Tab virtual Desktop2.
2. **Native ABI/release packaging**: re-port and review the observer/direct UIA Win32/.NET native helpers to the `c2ad782` installer build, with verified runtime dependencies and release smoke tests. Existing test consumes candidate-built helpers outside this branch.
3. **End-to-end real Gateway**: local network MCP tests use an internally injected mock bridge to prove transport and permit lifecycle; real GUI test uses the composed bridge directly, not through an MCP transport. These two successes are separate and cannot be called a real GUI-through-Gateway-MCP E2E.
4. **Third-party application safety**: WPF/WinUI/Electron/Chrome behaviors, multi-display no-focus, actual physical HUD Exit, minutes-to-hours soak, concurrent clients and test of all fault-injection/rollback flows remain unverified. Unproven transport must be denied, never switch Desktop1 away-and-back or use global clipboard.

No Production update, source merge to main, tag, install, service restart, or remote push is authorized by this acceptance.
