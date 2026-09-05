# DeskMCP 0.9.5

## Highlights

- Decouples Windows console visibility from privilege elevation. `window_mode` controls only whether CMD / PowerShell is visible; `elevation: "admin"` controls UAC.
- Adds supported `hidden + admin` execution: Windows shows the normal secure-desktop UAC prompt, then runs the administrator command without an extra CMD / PowerShell window.
- Keeps `visible + admin` for cases where a real administrator console should remain visible after UAC approval.
- Adds an optional administrator-request disclosure HUD before UAC so the local user can see the real shell and a redacted command summary before approving DeskMCP Elevated Command Host.
- Adds a Settings toggle for the disclosure HUD. It defaults to On; disabling it skips the HUD and goes directly to Windows UAC.
- Hard-isolates release-stage, installer and stability smoke runtimes from the real DeskMCP Tunnel so validation cannot take over the user's Remote MCP route.

## Administrator request transparency

When enabled, DeskMCP shows a short non-interactive disclosure before invoking Windows `runas`. The HUD does not approve or replace UAC and requires no extra click. Obvious password, token, API-key, secret and Authorization values are redacted from the displayed command summary.

The Windows UAC decision remains the only approval step. DeskMCP does not disable Secure Desktop and does not auto-approve elevation.

## Release hardening

- Agent-safe runtime isolation contract upgraded to v2 with a hard `DESKTOP_MCP_DISABLE_TUNNEL` test kill switch.
- Isolated smoke runtimes do not read the real Tunnel key/profile, query the real Tunnel runtime, start `tunnel-client`, stop a live Tunnel, or change the user's Remote MCP route.
- Tunnel profile generation now uses the actual configured Gateway port instead of a hard-coded development port.
- Runtime stability validation now derives pinned Node/Tunnel targets from the canonical release-target configuration instead of stale hard-coded paths.
- `DeskMCP.ProcessHost` version metadata is aligned to 0.9.5 and identifies the executable as `DeskMCP Elevated Command Host`.

## Validation

- `npm test`: 45/45 passed on Windows x64.
- `ELEVATION_DISCLOSURE_SELF_TEST=PASS`.
- `PROCESS_HOST_HIDDEN_ADMIN=PASS`.
- WPF build: 0 warnings / 0 errors.
- Release-stage smoke: PASS with `SMOKE_TUNNEL_PROCESS_COUNT=0`.
- Runtime stability: 5/5 spaced Gateway crash recoveries, 4/4 Gateway crash-storm recoveries and 5/5 Desktop Commander crash recoveries.
- Installer smoke: install, injected-failure rollback, upgrade, interrupted-upgrade recovery, installed runtime and uninstall all pass.
- Production npm audit: 0 vulnerabilities; production Node package inventory: 501; unresolved licenses: 0.

## Notes

- DeskMCP still relies on the standard Windows `runas` / UAC boundary and never bypasses local user approval.
- The current Windows installer remains unsigned while SignPath Foundation OSS signing approval is pending. Do not interpret this release as Authenticode-signed.
- macOS ProcessHost parity work is intentionally not included in 0.9.5; it is planned for the 0.9.6 line after real macOS ARM64 validation.
