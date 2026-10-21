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
- Real Chromium multi-agent stress, user handoff, installed runtime, full E2E and true Windows Desktop 2 have NOT been verified. No install, restart, merge, push, or Production modification.

## Next proposed experiments

1. Real-browser concurrency with isolated test-only profiles and crash/reaper conditions. No personal Chrome profile.
2. Bounded workflow compiler with a fresh state and target guard before every mutation; no unbounded JavaScript execution.
3. Human takeover with explicit ownership, invalidation of agent observations and safe resume.
4. Versioned site-learning packs with origin scoping, reviewed provenance, expiry and no credentials or cookies.
5. Native Desktop 2 foreground isolation remains an independent engineering task, unaffected by browser-space guarantees.

No Ego Lite source code was copied into DeskMCP: this is an independent adaptation of the session coordination concept.
