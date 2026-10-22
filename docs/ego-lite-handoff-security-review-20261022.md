# DeskMCP Ego Lite — browser takeover security review (2026-10-22)

Status: CANDIDATE ONLY / no native Human Takeover UI / DO NOT MERGE or DEPLOY.
Source baseline: isolated review branch based on main@343ba99, later advanced through 622b763.

## SOURCE / TEST VERIFIED mitigations

- The per-session FIFO now caps pending + running requests at 32. Overload fails closed; independent sessions continue.
- Optional BrowserRuntime handoff checks are enabled only when a BrowserHandoffAgentPort is explicitly injected at construction. An in-process privileged local-control object is separate from the Agent-facing port. No corresponding MCP tool was registered.
- Handoff invalidates existing Observations and increments an authorization epoch. Queued Agent operations are rejected after an ownership transition. The local port must confirm resume, then Agent begins with a fresh Snapshot.
- Under the injected gate, snapshot/find/act/download/workflow, tab management, dialog handling and Agent-initiated close deny access while human-owned. Browser session/profile inventory redacts human-owned entries with an epoch recheck following async reads.
- A handoff request requires an active dedicated Agent Desktop lease and a non-headless browser. Invalid transitions and failed invalidation cannot grant Agent control.
- Browser unit suite: 70/70 PASS. Existing real Edge headless Agent-only path: 10/10 PASS. These are not true Human Takeover E2E tests.

## Release blockers — RED

1. TRUSTED LOCAL CONFIRMATION: a local object capability does not prove a person actually accepted/finished the handoff. Native Control Panel/HUD authenticated local IPC, explicit user interaction and audited approval are not implemented. Never expose local accept/resume through remote MCP.
2. CROSS-TOOL ENFORCEMENT: candidate MCP-level quarantine now covers all 24 non-Browser registered tool entrypoints, with 27/27 current tool registrations accounted for. This is NOT full cross-transport or OS isolation: in-flight side effects, signed Artifact HTTP routes, other applications and plugins remain outside the guarantee. Details: ego-lite-cross-tool-quarantine-20261022.md.
3. WINDOWS DESKTOP IDENTITY: an Agent Desktop lease can represent a private Win32 Desktop Object rather than actual human-visible Win+Tab Desktop 2. Real UI handoff and Desktop 1 non-interference are unproven.
4. LIFE CYCLE: native lease/HUD failure, user exit, computer lock, process termination, profile ownership, system shutdown and background idle cleanup need explicit cleanup and recovery contracts.
5. PRIVACY: fresh snapshots after Agent resume can show form values. Sensitive fields and credential prompts require redaction, site-aware handling and a clear handback warning.
6. WORKFLOW GATE: the internal guarded workflow is not an audited MCP action. Future registration requires caller policy, per-step audit, bounded deadline/cancellation and no automatic replay.
7. EPOCH/TOMBSTONES: optional handoff record retirement is not wired to verified process teardown; the unsafe public forget/reset operation was removed pending a bounded cleanup design.

## Evidence boundary

SOURCE + UNIT VERIFIED: candidate in-process state machine, queue bound, ownership tests, list redaction, stale-token rejection.
REAL EDGE VERIFIED: 10/10 scoped headless agent-only workflow tests; no real human used the local-control port.
NOT VERIFIED: true local-user confirmation, native UI/IPC, credential input, cross-tool guarantees or Desktop 2 focus.

No installed Gateway restart/update, Production change, main merge, push, personal Chrome access or MT5 operation.