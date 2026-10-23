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
