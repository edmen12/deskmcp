# DeskMCP Ego Lite — Background process preflight and trusted local consent contract
Date: 2026-10-22 (MYT)
Branch: review/ego-lite-session-gate-20261022
Status: CANDIDATE / SOURCE + TESTS / NO PRODUCTION DEPLOYMENT

## What changed

- New src/browser-process-handoff-preflight.ts checks ProcessSessionRegistry-owned sessions against the native DesktopBackendBridge process inventory, while the existing cross-tool request drain barrier is held.
- src/browser-runtime.ts accepts an optional ownedProcessHandoffPreflight callback and invokes it between the dedicated Agent Desktop lease check and the actual handoff authority transition. Only BrowserRuntime-owned browser process session IDs may be excluded from the block condition.
- src/index.ts supplies the preflight callback from the existing native bridge and process session registry. The installed Runtime still does NOT supply a trusted handoffAgent, hence this does NOT activate user-facing takeover.
- Active non-browser Gateway-owned processes, pending unregistered process starts, process inventory errors and unrecognized response format all refuse transfer. Preflight never terminates a process.
- Tests: tests/browser-process-handoff-preflight.test.ts covers active job refusal, verified completed job, pending starts, malformed inventories and native listing failure. tests/browser-runtime.test.ts verifies requestLocalBrowserHandoff blocks a still-running owned job and succeeds after native-confirmed termination.

## Evidence

- npm run typecheck PASS prior to new tests.
- npm run test:fast 153/153 PASS (includes five new process preflight tests).
- npm run test:browser 78/78 PASS (includes injected real BrowserRuntime requestLocalBrowserHandoff check).
- Real Windows Desktop 2 interactive handoff, trusted local UI and production process lifetime are NOT tested here.
- Full npm run test:integration still BLOCKED by missing dotnet.exe in the isolated candidate worktree (historical blocker, not a claim that the code failed).

## Important limitation

Only owned, Gateway-tracked processes are tested. External programs, other plugins/agents, already detached process trees, scheduled tasks, arbitrary other terminals and OS-native input streams are outside the check. Browser exclusion uses the Runtime's current process-session mapping, not a user-controlled list. Inventory errors must fail closed.

## Native Control Panel/HUD handback: implementation acceptance contract (NOT YET IMPLEMENTED)

1. A trusted user-visible HUD/control panel on the actual user-selected Agent Desktop must present an explicit takeover request, target Session ID, profile and website origin (with secrets redacted). The existing Agent Desktop lease heartbeat cannot by itself attest a user click.
2. Only an authenticated native control channel with a genuinely UI-created, one-time acknowledgement may move handoff-requested → human, and human → agent. Never accept an arbitrary remote MCP Boolean such as humanConfirmed.
3. The local approver capability MUST NOT be returned to, mirrored by, or made executable through remote MCP tools; same-user OS processes can access ordinary local pipes, so Windows ACL alone is insufficient. Require a carefully designed native UI trust model and independent abuse tests, rather than treating a pipe name as identity.
4. A local handback must invalidate every previous Observation and control epoch. Fresh snapshots need credential/form-value redaction; the UI should explain that an Agent could otherwise read content typed by the human.
5. Handback must be denied when the target Agent Desktop lease is stale, native HUD is not current, browser profile/process ownership cannot be proven, Desktop 1 was unexpectedly activated, or cross-tool tool/HTTP operations or owned background processes remain active.
6. Crash/loss of HUD, browser exit, lock screen, ownership exception or OS desktop disagreement must keep Agent control revoked. Recovery requires an explicit local UI path; no remote fallback that silently unlocks the browser.
7. Audits must record request, local UI presentation, human acceptance/rejection, handback, timeout and revocation outcomes without storing credentials or signed URL query secrets.

## Strict release gates still RED

- No working, build-verified native Control Panel/HUD UI for accepting and returning control.
- No Windows native Desktop 2/user-visible end-to-end login test proving Desktop 1 retains focus without agent-triggered switching.
- No comprehensive cross-provider/OS-level isolation, process-tree-wide monitoring, privacy masking or trusted human-attestation security assessment.
- Do not merge, install, restart, push, or deploy this candidate on the basis of these unit tests.
