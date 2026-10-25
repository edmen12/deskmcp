# Real Desktop 2 — owner grant, revocation and teardown release gate

2026-10-25 | **SECURITY REVIEW — RED / NO PRODUCTION CUTOVER**

Baseline: isolated source branch `feat/real-d2-currentbase-integration-20261024@d795a0c`, production still `c2ad782`. This is a source review, **not** a new successful GUI E2E or a completed mitigation.

## Verified source facts

1. `src/http-server.ts` defines a 256-bit bearer and an expiry time for `/mcp/real-d2` and checks them with timing-safe equality. It does **not** bind the grant to a particular `AgentDesktopControlState.leaseId`, allocation `generation`, desktop GUID, or verified Job-owned process identity. The `clientId` is an internally asserted label, not independently proved per HTTP client. A holder of a valid bearer can access the owner-scoped MCP tools, and whether its requested lease is appropriate is left to the underlying active-session checks.
2. On expiry the route returns HTTP 403, but does **not** invoke a launch-owner revocation, stop the owned Job process, wait for the GUI descendant to exit, or stop the independent WinEvent observer. `RunningHttpServer.close()` closes the MCP handlers and socket, not the owned-application lifecycle. No automatic cleanup may be claimed from these code paths.
3. `src/desktop2-real-owned-mcp-tools.ts` keeps per-bridge opaque, one-use native permits; they expire at 30 seconds and are cleared after denial. The permit is not a replacement for authenticated lease ownership.
4. `src/desktop2-real-owned-control.ts` stops the independent observer via `stop(leaseId)`, but the HTTP server has no owner-lifecycle callback that sequences *owned GUI descendant exit first → in-flight native provider drained → observer stopped → HUD lease released*. In particular, stopping the observer while a GUI/operation remains active could create an unmonitored focus-steal gap.
5. The staging `JobHost → native GUI → MCP → callbacks` test previously passed on the older owner route. The newer bearer-isolated + self-contained staged ProcessHost **combined GUI E2E has not passed**; the recent attempt was denied by the pre-existing 1200 MB minimum (no GUI created).

## Required acceptance before activation

- Only a **trusted internal launch authority** may mint a grant, after a real HUD-ready allocation, and it must bind exact lease UUID, allocation generation, Windows desktop GUID, Job owner identity and single owner principal; no caller-provided title/PID/HWND is an identity proof.
- On **every** protected action, revalidate that allocation generation, HUD heartbeat, desktop GUID, Job owner and process tree still match. Reject wrong/reused/revoked leases before any provider dispatch; do not rely on bearer possession alone.
- Grant expiry, owner disconnect, native crash, HUD Exit and Gateway shutdown must synchronously **revoke new actions** and execute an audited, bounded cleanup: block new input; drain in-flight native operations while the independent observer is alive; terminate/confirm exact owned Job descendants; only then stop the independent observer; finally release that same HUD lease. If proof is missing, fail closed with a durable error and preserve the monitor rather than blind switch or global-input fallback.
- Explicit tests: wrong lease with valid bearer; same lease but wrong generation; HUD heartbeat lost; owner Job changed/terminated; concurrent other-client principal; expiry during in-flight action; Gateway stop during native action; failure of Job exit verification; observer stop failure; process restart; orphan recovery. Assert Desktop1 virtual desktop **and foreground focus** unchanged, no system clipboard use, all capabilities removed, and no leaked owner process.
- Keep all new mutation endpoints **unregistered** in installed Production until the full set passes on the exact installable Stage plus live Native D2 environment, including third-party WPF/WinUI/Electron safety tests.

## Operational state

No source release gate was cleared by this audit. The attempted lease/generation patch was not finished because the operation was blocked by tooling safety checks, and its partial changes were explicitly reverted; do not represent it as implemented. Current host memory was ~392 MB during this review, so no UI run was attempted and the 1200 MB threshold was not changed. No existing processes, Desktop 1, installed DeskMCP, or active HUD lease were modified for this review.
