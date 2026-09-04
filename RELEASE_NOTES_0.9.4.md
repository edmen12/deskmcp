# DeskMCP 0.9.4

## Highlights

- Adds explicit visible Windows console sessions to `desktop_start_process` while keeping hidden background execution as the default.
- Adds opt-in administrator console launch through the native Windows `runas` UAC flow.
- Keeps elevated and visible process trees owned by DeskMCP so session termination still cleans up descendants.
- Improves elevated ProcessHost error propagation instead of returning an unexplained exit code.

## New process options

`desktop_start_process` now accepts:

- `window_mode: "hidden" | "visible"` — defaults to `hidden`.
- `elevation: "standard" | "admin"` — defaults to `standard`.

`elevation: "admin"` requires `window_mode: "visible"` and Windows. The local user must approve the normal secure-desktop UAC prompt. DeskMCP does not bypass UAC.

Visible console sessions receive interactive keyboard input directly from their Windows console. `desktop_interact_process` remains for hidden DeskMCP-managed terminal sessions.

## Validation

- ProcessHost Windows x64 build: PASS.
- Gateway/Node test suite: 43/43 PASS.
- Hidden console probe: no visible console window.
- Visible standard console probe: visible console window confirmed.
- Visible administrator probe: administrator token and visible console confirmed after UAC approval.
