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
