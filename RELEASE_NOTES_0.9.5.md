# DeskMCP 0.9.5

## Fixed

- Decoupled Windows console visibility from privilege elevation. `window_mode` now controls only whether CMD / PowerShell is visible, while `elevation: "admin"` controls UAC.
- Added supported `hidden + admin` execution: Windows shows the normal UAC prompt, then runs the elevated command without an extra CMD / PowerShell window.
- Kept `visible + admin` for cases where a real administrator console should remain visible after UAC approval.
- Added a compiled ProcessHost smoke test covering hidden elevated execution without bypassing UAC.
- Preserved DeskMCP Job Object ownership for elevated process trees and UAC cancellation/denial reporting.

## Validation

- `npm test`: 45/45 passed on Windows x64.
- `PROCESS_HOST_HIDDEN_ADMIN=PASS`.
- Version consistency checks pass at 0.9.5.

## Notes

- DeskMCP still relies on the standard Windows `runas` / UAC boundary and does not auto-approve elevation.
- This release does not change the existing `v0.9.4` GitHub tag or assets.
