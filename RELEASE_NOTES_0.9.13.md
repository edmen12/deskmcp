DeskMCP 0.9.13 is a focused Agent Desktop safety and lease-allocation patch on top of 0.9.12.

## What changed

- Agent Desktop tool guidance now tells agents not to acquire a desktop for filesystem, terminal, MCP/network-only, code-review, or Task Room work.
- Agents should acquire a lease only immediately before real GUI interaction or a visible browser session, and release it as soon as that work is complete.
- Desktop 1 is reserved for the local user at both layers: the Windows Control Panel refuses to bind it and the Gateway refuses to allocate any binding that currently resolves to Desktop 1.
- Regression tests now cover Windows virtual-desktop renumbering so a formerly valid bound desktop that becomes Desktop 1 is unavailable to agents.

## Validation target

The patch must pass the version-consistency gate, the full Gateway/runtime suite, WPF build, installer/UI checks, release-stage provenance checks, installer smoke, update-security/runtime reliability checks, and final release readiness before publication.
