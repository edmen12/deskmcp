# Windows Computer Use

DeskMCP Windows Computer Use is a local, policy-gated UI automation layer for agents. The remote MCP surface belongs to DeskMCP; Microsoft WinApp CLI is a pinned, replaceable Windows backend rather than the public protocol.

## Tool flow

Use the tools in this order:

1. `desktop_ui_windows` — discover visible app windows and receive opaque `window_id` capabilities.
2. `desktop_ui_snapshot` — inspect a window and receive a fresh `computer_observation_id`; optionally request a PNG screenshot.
3. `desktop_ui_action` — perform exactly one action using that fresh observation.
4. Re-observe before the next action. A successful or partially attempted action invalidates sibling observations for the same window.

The intended loop is **observe → act once → observe again**. Do not cache selectors or UI state across unrelated changes.

## UI Automation first

Prefer semantic actions when the target supports them:

- `invoke` for buttons and invokable controls.
- `set_value` for editable values.
- `click`, `hover`, `scroll`, `send_keys`, and `drag` only when semantic UI Automation is insufficient.

Snapshots default to the interactive UI Automation tree without a screenshot. Request `include_screenshot=true` only when visual context is needed. This reduces image bandwidth, model tokens, focus changes, and coordinate mistakes.

## Observation safety

`desktop_ui_snapshot` returns a short-lived opaque `computer_observation_id`.

- Observation TTL: 30 seconds.
- Observations are one-time capabilities.
- An observation is bound to one opaque `window_id`.
- The first action on a window advances its state generation and invalidates sibling observations created from the old state.
- Window capabilities are validated against the live HWND, process ID, process name, and window class internally. These native identifiers are not part of the public window capability.
- All GUI operations share one Gateway-process coordinator, so multiple MCP clients cannot concurrently mutate the desktop.

This prevents two agents from observing the same button and both acting later after one of them has already changed the UI.

## Permission profiles

Computer Use is discoverable in the stable MCP schema but executable only in:

- **Full Control** — session-only; normal Windows integrity/UAC boundaries remain enforced.
- **Fully Unlocked** — session-only; additionally permits explicitly requested system-wide key injection.

Read-only and Workspace Write reject Computer Use calls locally.

The MCP surface intentionally does not expose WinApp's `post-message` keyboard transport because it can cross Windows integrity levels. DeskMCP uses Windows `send-input` for injected keyboard input. System-wide keys require Fully Unlocked.

## UAC, lock screen, and Secure Desktop

DeskMCP Computer Use does not bypass:

- Windows ACLs.
- User Account Control.
- UAC Secure Desktop.
- The Windows lock screen.
- Host-session isolation.

If Windows switches to Secure Desktop for UAC, normal desktop UI automation must fail rather than attempt to synthesize consent. Administrator process elevation continues to use DeskMCP's separate ProcessHost/UAC flow.

## Backend and packaging

Windows releases pin Microsoft WinApp CLI **v0.5.0** from its official GitHub Release assets.

Release staging verifies:

- Upstream x64/ARM64 archive SHA-256.
- `winapp.exe` PE architecture.
- `libSkiaSharp.dll` PE architecture.
- Extracted-file SHA-256 values.
- Version marker and upstream archive provenance.
- MIT license preservation.

The installed payload stores the backend under `gateway/winapp/`. Critical backend files and provenance markers are included in `install-integrity.sha256`.

DeskMCP also sets `WINAPP_CLI_TELEMETRY_OPTOUT=1` for backend processes.

## Action result privacy

DeskMCP does not forward the backend's raw action response to the remote client. The public action result contains DeskMCP-owned status plus the requested post-action observation. This prevents native backend implementation details from becoming part of the public API or leaking native window/process identifiers accidentally.

Screenshots are captured to a temporary PNG path, read into the MCP response, and removed immediately after capture. Audit logging is metadata-only and does not record screenshot pixels, file contents, terminal I/O, API keys, or native process/window identifiers.

## Current scope

This P0 implementation targets Windows x64 and Windows ARM64. It is selector/UIA-first rather than OCR-first. Visual/OCR fallback and reusable recorded workflows can be added later behind the same DeskMCP tool contract without changing the safety model above.
