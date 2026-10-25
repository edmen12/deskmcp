# Ego Lite engineering comparison (2026-10-22)

Status: staging candidate / not merged / not installed.
DeskMCP baseline: local main at 343ba997 when reviewed.
Reference: https://github.com/citrolabs/ego-lite, sparse checkout commit d392204d1ea1a8027a591ab2b0129c2e11d85f26.
The published Ego Lite repository contains the agent SDK and Skill, not the browser application's own source. Private browser-engine claims are unverified.

## Current code observations

- Ego Lite Task Spaces have an explicit agent/user ownership model. Its SDK page-model.ts has a per-space gate, handOff(), waitForControl(), and reconciles managed vs. unmanaged tabs. Browser Spaces are not Windows Virtual Desktop or independent Win32 input desktops.
- Ego Lite PageRefRegistry binds exposed element refs to target, frame, node and document provenance and invalidates on document changes.
- Ego Lite can compose JavaScript through its SDK bridge. Do not enable unrestricted host JavaScript or raw CDP in DeskMCP without retaining local permissions, audit and observation rules.
- DeskMCP already provides owned browser sessions, one-use browser_observation_id and a maximum of one mutating action per observation although the schema accepts up to 20 total actions. This is an intentional safety boundary.
- DeskMCP serializeMutation guarded lifecycle but not ordinary snapshot/find/act within a session. A snapshot could begin during a previous in-flight action in the same browser session.

## Candidate implementation

- New per-session FIFO gate for find, snapshot, download and act.
- Page creation/selection/close, dialogs, browser close and reaper disposal also coordinate with this gate.
- Action/download completion snapshots use the already-held session gate and therefore avoid nested locking.
- One mutation per observation, single-use tokens, stale-state checks, profile isolation and global lifecycle safeguards remain unchanged.
- Independent sessions continue in parallel, rather than serializing all agents globally.

## Verification

- npm run build: PASS.
- npm run test:browser: 56/56 PASS.
- npm run test:fast: 146/146 PASS.
- Deterministic injected driver tests show same-session snapshot waits while action is running, unrelated session still responds, and close waits for in-flight action.
- 2026-10-22 (MYT): A repeatable real Chromium test was added at `test-area/ego-lite-real-browser-concurrency.mjs` and run against locally installed **Microsoft Edge (Chromium), headless only**, using temporary test-owned profiles and a local HTTP fixture. Result **8/8 scoped assertions PASS**: two live sessions and distinct profiles; same-session action/snapshot ordering; cross-session progress while another action was deliberately paused; no deadlock; actual input/click DOM callback verified via BrowserRuntime snapshot; used sibling observation rejected; close waits for an in-flight action; remaining session remains usable; unexpected process termination reconciles its session/profile lock. Raw JSON result is in ignored `runtime/ego-lite-real-browser-e2e.log` (not a deployed service log). The two initial ordering tests use an injected scheduling barrier surrounding actual Edge actions; this is deterministic concurrency coverage, **not** a statistically representative throughput benchmark.
- Test-owned process inventory after run: **0**; fresh temporary profiles deleted; two earlier failed-test/probe directories separately verified unowned and cleaned. An earlier Chrome headless test did not produce a CDP port and was stopped through its own DeskMCP process session; this environment result is **BLOCKED**, not evidence the DeskMCP browser engine is broken.
- Long-running multi-agent stress, Chrome-specific success, visible Windows Virtual Desktop 2, user handoff, installed DeskMCP runtime and full production E2E remain **OPEN**. No install, restart, merge, push, Production change or use of the personal Chrome profile.

## Guarded workflow candidate (2026-10-22, SOURCE + REAL EDGE E2E VERIFIED)

- BrowserRuntime.runGuardedWorkflow() is internal candidate-only; NOT registered as an MCP tool and does not change the 27 default tool schemas. No installed Gateway uses it.
- Bounded declarative steps (1-5), only click, fill, set_checked, select. Each requires exact HTTP(S) expected_url, optional expected_text and after_text; no navigation, uploads, raw JavaScript or system-key actions.
- Starts from unconsumed page-scoped browser_observation_id. Holds per-session FIFO gate; before every action checks fresh snapshot guard and existing stale-token logic, then produces a new snapshot for the next action. The first user-supplied observation is used exactly once.
- Disallows snapshot element refs in compiled multi-step sequence; only bounded nonempty stable selector strings allowed. Never reinterprets old refs after DOM changes.
- Invalid future steps rejected before caller observation consumed; stale initial state, mismatching guards and postconditions fail closed. No replay after ambiguous dispatch. Fresh internal observations invalidated on error; already executed steps are never automatically rolled back.
- Current tests: TypeScript build PASS; Browser suite 64/64 PASS; repeatable real Microsoft Edge local headless fixture 10/10 scoped checks PASS, including fill/click DOM callback and wrong-URL preventing later click. Not a general website reliability guarantee.
- Open: independent code/security review, approval and auditing at an eventual MCP entrypoint, cancellation/deadline semantics, multi-hour crash and profile soak, controlled human takeover. Do not expose a tool or merge based on local tests alone.

## Human takeover boundary: optional in-process gate candidate; native UI NOT implemented

Candidate control-state and BrowserRuntime read/action gate are now implemented and test-driven, but there is no native local-user proof, authenticated Control Panel/HUD adapter, real D2 human takeover, or cross-tool enforcement. See [security review](ego-lite-handoff-security-review-20261022.md) for verified controls and remaining release RED blockers. See also [cross-tool quarantine review](ego-lite-cross-tool-quarantine-20261022.md) for 24-tool denial tests and the remaining cross-transport risk.

1. Ownership states: agent-owned -> pause requested -> human-owned -> locally confirmed resume requested -> agent-owned. Human-owned sessions must block Agent snapshots and mutations, protecting credentials entered by people.
2. Handoff drains in-flight operations through session gate before ownership changes, invalidates all Agent observations and pending action authorization. Late Agent requests fail.
3. Only a trusted LOCAL DeskMCP Control Panel/HUD event can confirm resume. A remote MCP caller must never set humanConfirmed, fake a resume, or reuse an old observation. After resume the Agent must get a fresh snapshot.
4. Visible interactive browser belongs to an Agent Desktop lease and dedicated profile. A user may switch to Agent Desktop to sign in; the Agent must never automatically switch or steal foreground Desktop 1.
5. HUD/lease/browser-process loss, UAC, lock screen and user Exit Agent Control all fail closed. Human-owned sessions require a deliberate idle lifetime rule, not the short Agent idle cleanup.
6. Real Windows native UI, foreground and desktop watcher, audit events and rejection tests are required before implementation can be approved. No user takeover E2E is claimed.

## Next proposed experiments

1. Real-browser concurrency with isolated test-only profiles and crash/reaper conditions. No personal Chrome profile.
2. Bounded workflow compiler with a fresh state and target guard before every mutation; no unbounded JavaScript execution.
3. Human takeover with explicit ownership, invalidation of agent observations and safe resume.
4. Versioned site-learning packs with origin scoping, reviewed provenance, expiry and no credentials or cookies.
5. Native Desktop 2 foreground isolation remains an independent engineering task, unaffected by browser-space guarantees.

No Ego Lite source code was copied into DeskMCP: this is an independent adaptation of the session coordination concept.
