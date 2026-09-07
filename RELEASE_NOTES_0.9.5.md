# DeskMCP 0.9.5

## Highlights

- Adds guarded **Windows Computer Use** with `desktop_ui_windows`, `desktop_ui_snapshot`, and `desktop_ui_action`, expanding the stable Windows MCP surface from 13 to 16 tools.
- Uses a UI Automation-first interaction model with optional PNG screenshots, opaque `window_id` capabilities, one-time short-lived `computer_observation_id` guards, and process-wide GUI serialization so concurrent agents cannot keep acting from stale UI state.
- Bundles pinned Microsoft WinApp CLI v0.5.0 for Windows x64/ARM64 with upstream SHA-256 provenance, PE architecture validation, extracted-file hashes, MIT notice preservation, installer integrity coverage, and release/runtime smoke gates.
- Decouples Windows console visibility from privilege elevation. `window_mode` controls only whether CMD / PowerShell is visible; `elevation: "admin"` controls UAC.
- Adds supported `hidden + admin` execution: Windows shows the normal secure-desktop UAC prompt, then runs the administrator command without an extra CMD / PowerShell window.
- Keeps `visible + admin` for cases where a real administrator console should remain visible after UAC approval.
- Adds an optional administrator-request disclosure HUD before UAC so the local user can see the real shell and a redacted command summary before approving DeskMCP Elevated Command Host.
- Adds a Settings toggle for the disclosure HUD. It defaults to On; disabling it skips the HUD and goes directly to Windows UAC.
- Hard-isolates release-stage, installer and stability smoke runtimes from the real DeskMCP Tunnel so validation cannot take over the user's Remote MCP route.

## Windows Computer Use

DeskMCP 0.9.5 adds a Windows-only Computer Use backend while keeping the MCP contract independent from the underlying automation implementation.

- `desktop_ui_windows` discovers visible application windows and returns opaque capabilities instead of HWND/PID targets.
- `desktop_ui_snapshot` returns a fresh one-time `computer_observation_id`, a normalized UI Automation element view, and an optional PNG screenshot.
- `desktop_ui_action` performs one semantic action such as invoke, set value, click, hover, scroll, keyboard input, drag, or wait.
- UI Automation actions are preferred over injected input. Screenshot capture is optional so agents do not pay the image/token cost on every step.
- Observations expire quickly and are single-use. The first action on a window invalidates sibling observations from the same UI state.
- GUI operations share one Gateway-level coordinator so multiple MCP clients cannot mutate the desktop concurrently.
- Backend-internal WinApp fields are projected through a DeskMCP-owned allowlist rather than becoming part of the public MCP contract.
- Interactive and tree-form WinApp inspection output are normalized to one stable DeskMCP element schema.
- Computer Use requires session-only Full Control or Fully Unlocked. It does not bypass Windows ACLs, the lock screen, UAC, or UAC Secure Desktop.
- The MCP surface uses `send-input` for injected keyboard input and does not expose WinApp's cross-integrity `post-message` keyboard transport. Explicitly requested system-wide keys require Fully Unlocked.

## Administrator request transparency

When enabled, DeskMCP shows a short non-interactive disclosure before invoking Windows `runas`. The HUD does not approve or replace UAC and requires no extra click. Obvious password, token, API-key, secret and Authorization values are redacted from the displayed command summary.

The Windows UAC decision remains the only approval step. DeskMCP does not disable Secure Desktop and does not auto-approve elevation.

## Release hardening

- Agent-safe runtime isolation contract upgraded to v2 with a hard `DESKTOP_MCP_DISABLE_TUNNEL` test kill switch.
- Isolated smoke runtimes do not read the real Tunnel key/profile, query the real Tunnel runtime, start `tunnel-client`, stop a live Tunnel, or change the user's Remote MCP route.
- Tunnel profile generation now uses the actual configured Gateway port instead of a hard-coded development port.
- Runtime stability validation now derives pinned Node/Tunnel targets from the canonical release-target configuration instead of stale hard-coded paths.
- Windows builds clean `dist` before TypeScript compilation, and release staging packages only `dist/src`, preventing stale compiled tests from surviving source deletion or entering production installers.
- WinApp executable, SkiaSharp companion runtime, backend version/provenance files and MIT license are part of release-stage and installed-runtime integrity checks.
- `DeskMCP.ProcessHost` version metadata is aligned to 0.9.5 and identifies the executable as `DeskMCP Elevated Command Host`.
- Adds a supported current-user installer path while retaining atomic backup, rollback and interrupted-install recovery behavior.

## Validation

- `npm test`: 55/55 passed on Windows x64.
- Real MCP Computer Use E2E: PASS, including opaque window IDs, UIA snapshot/action, stale-observation rejection, non-interactive tree normalization, and PNG screenshot output.
- `ELEVATION_DISCLOSURE_SELF_TEST=PASS`.
- `PROCESS_HOST_HIDDEN_ADMIN=PASS`.
- WPF build: 0 warnings / 0 errors, including First Run and Full/Unlock modal capture validation.
- Release-stage smoke: PASS with WinApp v0.5.0 payload integrity, 16-tool validation, and `SMOKE_TUNNEL_PROCESS_COUNT=0`.
- Runtime stability: 5/5 spaced Gateway crash recoveries, 4/4 Gateway crash-storm recoveries and 5/5 DeskMCP backend crash recoveries.
- Installer smoke: install, injected-failure rollback, upgrade, interrupted-upgrade recovery, installed Computer Use runtime and uninstall all pass on Windows x64.
- Production npm audit: 0 vulnerabilities; production Node package inventory: 501; unresolved licenses: 0.
- Public release readiness: `BLOCKERS=0`.

## Notes

- Windows Computer Use is included in 0.9.5. macOS Computer Use is not included.
- macOS ProcessHost parity work remains intentionally held until the Apple Developer ID signing/notarization release path is available.
- DeskMCP still relies on the standard Windows `runas` / UAC boundary and never bypasses local user approval.
- The current Windows installer remains unsigned while SignPath Foundation OSS signing approval is pending. Do not interpret this release as Authenticode-signed.
