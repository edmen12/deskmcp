# Ego Lite / DeskMCP — In-flight handoff barrier candidate (2026-10-22)

Status: CANDIDATE / COMMITTED as 69e2d47 on review/ego-lite-session-gate-20261022; NOT MERGED OR DEPLOYED. Source and tests are present in `review/ego-lite-session-gate-20261022` at `C:\Users\User\Desktop\DeskMCP-Ego-Lite-Review`. Do not merge or deploy.

## Actual changes

1. `src/browser-cross-tool-guard.ts`: one process-local, shared admission register for generic MCP and signed Artifact HTTP operations. `runNonBrowserOperation` admits synchronously and counts through completion; `withHandoffBarrier` synchronously blocks new admissions, drains prior operations, and only then invokes the Browser Runtime takeover request. Default bounded drain is 15 seconds; timeout leaves human takeover unrequested. Concurrent takeover barriers fail closed.
2. `src/browser-runtime.ts`: `crossToolGuard()` now returns one stable instance per Browser Runtime. `requestLocalBrowserHandoff` invokes the drain barrier before the existing browser-session FIFO/lease/ownership transition.
3. Existing audit helpers and tool handlers in `bridge-tools.ts`, `computer-use-tools.ts`, `process-tools.ts`, `dynamic-mcp-tools.ts`, `agent-desktop-tools.ts`, `task-tools.ts`, `skill-tools.ts`, `artifact-tools.ts` now register their action duration with the same guard.
4. `src/http-server.ts`: signed Artifact HTTP GET transfers register through stream finish/close, and new signed downloads are rejected while takeover is requested/human-owned. Response headers and already-started streams are handled separately so a midstream denial cannot be converted into a forged new response.
5. `tests/browser-runtime.test.ts`, `tests/browser-tools.test.ts` and `tests/artifact-http.test.ts`: deterministic late-result, request-drain, concurrent-request, timeout/no-transfer, and signed-HTTP handoff tests.

## Evidence as of this turn

- `npm run build` PASS (including TypeScript compile).
- `npm run test:browser` 77/77 PASS, after one earlier intermittent existing idle-session cleanup assertion failed and passed when rerun in isolation and in the full suite.
- `npm run test:fast` 148/148 PASS (includes 4/4 signed Artifact HTTP route tests).
- Direct `node --test dist/tests/artifact-http.test.js`: 4/4 PASS.
- Real isolated Microsoft Edge E2E rerun against the latest committed candidate: 10/10 PASS. Test-owned process count 0; temporary browser profile removed. This confirms the ordinary agent-only browser flow, NOT actual Human Takeover.
- Full `npm run test:integration` still BLOCKED at `prepare-tests` because `dotnet.exe` is absent in the configured Windows test environment.
- Attempt to launch last real Edge regression was BLOCKED with `Process session limit reached (32)`. Several known, finished test sessions were reviewed; no unrelated Agent process was terminated and Gateway was not restarted. Git commit also remains pending for this reason.

## Security limits / RED release blockers

- A local-control object is not a trusted human gesture; native Control Panel/HUD confirmation and authenticated local IPC are not implemented.
- Direct calls to the in-process handoff port can bypass this coordination if privileged code circumvents BrowserRuntime; guard is intended for its trusted orchestration path, not arbitrary code execution.
- The barrier tracks tool request duration, NOT background processes or independently running child processes after `desktop_start_process` returns. Nor does it provide a Windows kernel security boundary.
- OAuth callback and other HTTP paths, external plugins, direct local programs, credential capture/redaction, signed URL sharing and completed prior side effects still need independent threat-model review. The signed Artifact GET path itself is guarded when the candidate guard is explicitly injected.
- Browser Runtime remains independent of a trusted user-visible Windows Desktop 2 UI. No Desktop 1 non-interference test is claimed here.
- Human-owned session lifetime, crash cleanup, ownership record disposal, audit hardening, and release-level integration acceptance are open.
- Keep separate candidate worktree and do not change production, installed Gateway, Desktop 1, or other agents' work.

## Pending closeout

1. Restore legitimate DeskMCP process-session capacity without terminating unrelated Agent processes.
2. Re-run real Edge E2E and build/integration subset against HEAD; inspect `git diff --check`.
3. Commit only the reviewed candidate files; no merge or deployment without verified native local consent and cross-tool security acceptance.
