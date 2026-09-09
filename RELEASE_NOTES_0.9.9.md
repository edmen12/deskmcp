# DeskMCP 0.9.9

DeskMCP 0.9.9 fixes Tray branding in Windows single-file builds and expands Agent Desktop for safe multi-agent parallel use.

## Added

- Added an Agent Desktop pool: bind Desktop 2 or later as independent slots and DeskMCP allocates the first free slot to each Agent Control lease.
- Added per-lease desktop ownership so multiple agents can control different Windows virtual desktops concurrently without stealing one another's HUD, Browser, task, or control state.
- Binding a desktop into the Agent pool now returns the user to Desktop 1 automatically. Desktop 1 remains reserved and cannot be bound.

## Changed

- Browser sessions attached to an Agent Desktop lease now remain open for the full Agent Control lifetime, preserving page and login state between browser operations.
- Lease-owned Browser sessions reject direct close requests and are cleaned only when the corresponding Agent Control lease exits, completes, or is revoked.
- Blue-edge/HUD visibility follows the controlled desktop currently being viewed; Desktop 1 stays free of Agent overlays while background Agent desktops continue running.

## Fixed

- Restored the official DeskMCP Tray icon for Windows single-file builds.
- The official `DeskMCP.ico` is now a .NET embedded manifest resource instead of relying on an external `brand\DeskMCP.ico` file or WPF pack URI behavior.
- Added `--tray-icon-self-test` and release contracts for embedded Tray branding, multi-desktop Agent allocation, and Browser lease lifetime.

## Validation

- WPF Release build: 0 warnings, 0 errors.
- Embedded Tray icon self-test: pass.
- Single-file publish contains `DeskMCP.exe` while external `brand\DeskMCP.ico` is absent.
- Agent Desktop pool regression: two bound desktops accept two simultaneous leases; a further lease reports busy only when all slots are occupied.
- Agent Browser regression: direct close is rejected while the lease is active; Browser cleanup occurs after lease exit/revoke.
- Gateway/runtime regression suite: 104 passed, 0 failed.

Windows x64, native Windows ARM64, macOS ARM64, installer smoke, release readiness, and final immutable release verification remain required before publication.
