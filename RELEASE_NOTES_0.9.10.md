# DeskMCP 0.9.10

DeskMCP 0.9.10 fixes Agent Desktop process placement so GUI descendants launched through `desktop_start_process` stay on the virtual desktop owned by the active Agent Control lease.

## Changed

- `desktop_start_process` now supports `agent_desktop_lease_id` for Agent Desktop-aware process launch.
- DeskMCP validates the lease before launch, keeps the process under the existing ProcessHost ownership boundary, then moves and verifies top-level windows from the owned process tree on the lease desktop.
- Placement failure is fail-closed: the new process session is forgotten and the owned process tree is terminated instead of allowing GUI state to remain on another desktop.
- Administrator launch with `agent_desktop_lease_id` is intentionally rejected until cross-integrity Agent Desktop isolation has a verified design.

## Fixed

- Fixed AQP/MT5-style child GUI processes appearing on a different Windows virtual desktop than the Agent Control lease.
- Fixed the Agent Desktop safety HUD race where switching to Desktop 1 while the overlay was being created could incorrectly make a valid lease look changed or revoked.

## Validation

- Gateway/runtime regression suite: 105 passed, 0 failed.
- Agent Desktop focused regression suite: 5 passed, 0 failed.
- Version consistency gate: `VERSION_CONSISTENCY_OK=0.9.10`.
- Real Windows full-chain E2E passed through MCP `desktop_start_process` → `agent_desktop_lease_id` → DeskMCP backend bridge → `DeskMCP.ProcessHost` → PowerShell → parent GUI → child WinForms GUI, with the final child GUI verified on the target Agent Desktop.

Windows x64, native Windows ARM64, macOS ARM64, installer smoke, exact-main verification, and immutable GitHub Release verification remain required before publication.
