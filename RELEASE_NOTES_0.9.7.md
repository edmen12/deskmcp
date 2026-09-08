# DeskMCP 0.9.7

DeskMCP 0.9.7 expands the local-first agent runtime while keeping the remote MCP surface fixed and policy-controlled. The Windows tool surface is now 26 tools.

## Added

- Added Workspace-bound Recoverable Task Rooms through `desktop_task_manage`. Parallel chat windows are isolated by opaque room capabilities by default, and interrupted work can be explicitly recovered without guessing the latest task.
- Added verified expiring Artifacts through `desktop_artifact_manage`, including SHA-256/size verification, bounded reads, retention cleanup, and signed download URLs that default to loopback.
- Added the fixed Dynamic MCP facade through `desktop_mcp_manage`, `desktop_mcp_tool_search`, `desktop_mcp_tool_inspect`, and `desktop_mcp_tool_call` so configured upstream MCP servers do not expand DeskMCP's top-level schema.
- Added isolated Browser Automation through `desktop_browser_session`, `desktop_browser_snapshot`, and `desktop_browser_act`, with DeskMCP-owned profiles, loopback CDP, owned-process cleanup, and screenshot publication through the Artifact store.
- Added versioned model-readable Skills through `desktop_skill_manage`, including local Workspace validation/install, immutable content digests, active-version switching/rollback, bounded resource reads, and remote HTTPS + caller-supplied SHA-256 validation/install under Full or Unlock.

## Security and reliability

- Task Room capability secrets are persisted only as SHA-256 hashes and are bound to the selected Workspace fingerprint. Normal task list/get/mutation operations require the current room capability.
- Multi-agent file writes now consume one-time path/version-bound observation capabilities, preventing concurrent agents from silently overwriting the same observed file version.
- Dynamic MCP rejects remote plain HTTP and URL-embedded credentials, persists environment-variable names instead of secret values, and requires session-only Full or Unlock for refresh/live upstream calls.
- Skill packages reject path traversal, symlinks, encrypted ZIP entries, Windows-unsafe paths, oversized expansion, mutable declared-version/digest conflicts, and tampered registry version ids. Skill scripts are stored as resources and are never auto-executed by the Skill subsystem.
- Browser Automation never attaches to an existing personal CDP session and keeps Chromium descendants inside DeskMCP's existing ProcessHost / Windows Job Object ownership chain.
- Full Control process ownership now follows DeskMCP-owned sessions, including start reservations, bounded inactive history, PID-reuse invalidation, and Gateway-owned shutdown cleanup.

## Changed

- Simplified the verified Windows updater to a one-click **Update Now** flow after source/integrity validation.
- Unsigned artifacts that pass the immutable-source, size, and SHA-256 gates are eligible for user-initiated installation; valid Authenticode signatures add publisher verification, while invalid signatures or configured publisher-pin mismatches remain blocked.

## Release validation

- Standard Gateway/runtime test suite: 95 passed, 0 failed.
- Windows x64 release stage and 26-tool runtime smoke pass, including Task Room, Skills, Browser, Single Instance, isolated state, and pre-existing-process preservation checks.
- Windows x64 installer full chain passes clean install, injected rollback, upgrade, interrupted-install recovery, runtime verification, and uninstall with exit code 0.
- Production npm audit reports 0 vulnerabilities; 502 production packages are inventoried with 0 unresolved licenses.
- Windows ARM64 release-stage cross-build passes locally with native ARM64 PE validation. Final ARM64 runtime/installer validation is gated on the repository's native `windows-11-arm` CI job before release publication.
