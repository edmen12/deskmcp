## Cross-tool quarantine candidate — 2026-10-22

Status: SOURCE + UNIT / MCP INTEGRATION VERIFIED; NOT INSTALLED; HUMAN TAKEOVER RELEASE STILL RED.

### Implementation

- Optional BrowserHandoffAgentPort.anySessionReserved() is true while any browser is handoff-requested or human-owned.
- BrowserRuntime.crossToolGuard() derives the same in-process authority. The HTTP/MCP assembly automatically wires it to generic registrars when an authority is supplied; the current installed Gateway supplies no trusted local authority, so it remains disabled.
- During a reservation, all **24 non-browser DeskMCP MCP tool registrations** reject new requests through their audited handlers: filesystem and search (9), process (4), native Computer Use (3), Task (1), Skill (1), Artifact (1), Agent Desktop (1), Dynamic MCP (4). The remaining 3 Browser tools retain per-session ownership checking.
- Cross-tool denial is deliberately broad: unrelated automation also pauses. This avoids relying on guessed window titles/PIDs before an authoritative per-process/window ownership registry exists.
- Generic handlers check both before the tool action and again after awaited action completion before returning results. This reduces the risk of a response started earlier leaking after handoff, but **does not cancel or reverse actions already dispatched**.
- The authorization check throws PolicyDeniedError, which is recorded by the existing audit handling as a denied call. No remote tool grants handback rights.

### Fresh verification

- npm run test:browser: 72/72 PASS.
- End-to-end MCP test enumerates 27 registered DeskMCP tools and individually invokes every non-browser tool with valid input. All 24 are rejected during handoff request; policy status returns to normal following the test's trusted-port reject transition.
- A second MCP test deliberately pauses an in-flight dynamic search, begins handoff, then releases the search: late content is rejected and suppressed before returning to the client.
- Previous real Edge headless test demonstrates normal agent-only behavior; it does **not** exercise trusted human UI, native Desktop 2, or real user credentials.

### OPEN / RED

1. No trusted local UI/IPC authorization or genuine user handback attestation. The test uses a privileged in-process fake local port.
2. In-flight side effects and native UI action execution are not serialized with handoff transitions. Response suppression is insufficient; an explicit shared ownership/operation barrier and cancellation model are needed.
3. Native process/terminal operations, other provider integrations, already-running tasks, and external applications may bypass this model outside the 27 current MCP entrypoints. This is not an OS sandbox.
4. Public signed Artifact HTTP download links and other HTTP routes require separate privacy review; they are outside MCP tool handler quarantines.
5. No authoritative Chromium process/window-child registry: the prototype temporarily blocks all generic tools rather than precisely identifying owned windows.
6. No live Windows Win+Tab Desktop 2 / no Desktop 1 foreground interference validation; native lease semantics must be reconciled.
7. Pending ownership record cleanup, user-visible approval/revocation audit, crash lifecycle, credential masking and safe idle timeout policy.

Decision: DO NOT MERGE TO MAIN, REGISTER TAKEOVER MCP, INSTALL, RESTART, OR CLAIM PRODUCTION READINESS until explicit cross-transport/native UI security review.
## Final verification

- npm run test:browser: 72/72 PASS.
- npm run test:fast: 146/146 PASS.
- Real isolated headless Microsoft Edge browser: 10/10 scoped PASS; cleanup confirmed no test browser processes and no retained profile.
- HTTP/Control integration subset: 2/2 PASS.
- Full npm run test:integration: BLOCKED before test execution at prepare-tests, no dotnet.exe discoverable in this environment. No package or SDK installation performed. Do not misreport this as a failing implementation test or completed integration.
- All 27 MCP tools enumerated in the candidate integration fixture: 24 non-Browser calls denied during requested handoff; 3 Browser entries rely on the per-session Browser Runtime gate. A deliberately delayed dynamic MCP read demonstrates late result suppression.
