# Changelog

All notable changes to DeskMCP are documented here.

## Unreleased

### Changed

- Simplified the Windows updater to a one-click **Update Now** flow: DeskMCP downloads the fixed-repository immutable release asset, verifies size and SHA-256, then launches Setup without a second install confirmation inside DeskMCP.
- Decoupled updater availability from Authenticode. Unsigned artifacts that pass the source/integrity gates are eligible for user-initiated execution; valid signatures add publisher verification, while invalid signatures or configured publisher-pin mismatches are blocked.
- Removed unsigned/publisher-signature status from the normal update UI; signing state remains an internal security/logging concern and Windows may still show its own SmartScreen or publisher UI.
- Hardened multi-agent file mutation safety: `desktop_read_file` now returns a one-time path/version-bound `observation_id`; edit, move, and existing-file writes consume that capability, and same-path mutations are serialized to prevent concurrent lost updates.
- Added agent-safe runtime and multi-client stress harnesses that isolate ports, state, Startup shortcuts, Tunnel profiles, singleton namespaces, and owned process trees from any DeskMCP instance already in use.
- Hardened Full Control process ownership for concurrent agents: active state now follows Desktop Commander's session registry rather than OS PID liveness guesses, completed sessions remain readable in bounded history, start reservations enforce the 32-session ceiling before spawn, and stress coverage now includes 40-way start bursts, read/terminate races, Desktop Commander crash recovery, and Gateway-owned shutdown cleanup.

## 0.9.2 — 2026-09-01

### Added

- Added a session-only **Unlock** (`fully-unlocked`) permission profile for explicit advanced use. It disables DeskMCP Workspace, sensitive-path, search-exclusion, and fresh-observation write guards while retaining audit logging and the host OS account permission boundary.
- Added matching Windows and macOS permission UI, explicit risk confirmation, and health/policy fields that report whether Workspace and observation guards are actually enforced.

### Security

- Defined the safe-update trust contract: immutable stable GitHub releases, matching asset/manifest/local SHA-256, and valid pinned-publisher Authenticode before user-confirmed automatic execution is eligible.
- Added manifest schema v2 update invariants and metadata/execution/post-install policy tests.
- Added the user-controlled updater execution path: `.partial` download, local size/SHA-256 verification, WinVerifyTrust chain validation with revocation checking, compiled certificate SHA-256 publisher pins, explicit install, and fail-closed post-install version/profile verification.
- Added installer rollback for failures after the prior install is backed up, plus recovery from interrupted `.install-*` / `.backup-*` states.
- Upgrade Setup now preserves an existing **Start with Windows** choice instead of defaulting it back on.
- Prepared SignPath Foundation OSS signing: public code-signing/privacy policies, GitHub-hosted unsigned release-candidate provenance workflow, and signed-artifact finalization with Authenticode/timestamp verification and post-sign readiness.

### Fixed

- Reap exited Gateway-owned process sessions before enforcing the 32-session cap, and fail safely before spawning when capacity is exhausted so a rejected start cannot orphan a process.
- Isolated release-stage and installed-runtime smoke tests onto temporary loopback ports and singleton namespaces, allowing release validation to run while the development Control Panel is active.
- Hardened installer mutex smoke synchronization so native ARM64 validation checks the actual single-instance contract, waits for a complete readiness handshake instead of racing an empty file, and no longer depends on fragile process-ID timing.
- Hardened installer upgrades and recovery with a 30-second bounded retry window around atomic directory swaps when transient Windows file locks linger after runtime shutdown. Installer test modes now persist the underlying exception type/message for CI diagnostics, and install/rollback/upgrade/recovery smoke subprocesses use isolated control ports so validation cannot stop an unrelated development Gateway.

### Changed

- Automatic updater execution remains disabled while SignPath Foundation approval is pending and until an independently verified production signer certificate is compiled into the publisher-pin set; manual installer upgrades stay supported.

## 0.9.1 — 2026-08-29

### Changed

- Unified MCP server/client metadata and runtime log prefixes under the DeskMCP brand.
- Added Windows file-version metadata for the Control Panel, Setup, and Uninstaller.
- Made release, smoke-test, signing, readiness, and manifest tooling derive the current package version instead of hard-coding 0.9.0.
- Added a build-time version-consistency gate across package, Gateway, WPF, Installer, and Uninstaller versions.
- Made README and User Guide installer examples evergreen instead of release-number-specific.

### Fixed

- Cleaned source formatting artifacts that had survived earlier automated edits.
- Corrected stale release-policy and package metadata documentation discovered after the 0.9.0 public release.

## 0.9.0 — 2026-08-29

### Added

- Self-contained Windows x64 Setup with per-user installation and no administrator requirement.
- First Run Wizard for Workspace, OpenAI Tunnel, and ChatGPT plugin connection.
- 13-tool stable MCP surface across Read, Write, and Full profiles.
- Windows DPAPI protection for the Tunnel Runtime API Key.
- Single-instance Control Panel with tray integration and global shortcut support.
- Release-stage, installer, license-inventory, SHA-256, and readiness automation.

### Security

- Gateway binds only to `127.0.0.1`.
- Sensitive paths are denied by default and excluded before ripgrep content search.
- Filesystem paths receive lexical and canonical boundary checks.
- Writes use read-before-write observations to reject stale modifications.
- Full Control is session-only and does not persist across restarts.
- Process tools expose Gateway-owned opaque sessions instead of arbitrary Windows PID control.

### Fixed

- Prevented duplicate Gateway launch storms during slow cold starts.
- Prevented orphan Desktop Commander processes and release-stage directory locks.
- Clarified tray exit semantics between closing the UI and quitting DeskMCP services.
- Moved user settings, logs, and secrets out of the installation directory.
- Migrated the Control Panel to .NET 10 and removed obsolete PowerShell Control Panel implementations.

### Packaging

- Bundles Node.js 24.19.0 and OpenAI tunnel-client v0.0.13.
- Production npm audit currently reports zero vulnerabilities.
- Third-party notices are generated from the actual Windows release tree.
- Final release metadata includes `SHA256SUMS.txt` and `release-manifest.json`.

### Known limitations

- Windows x64 only; no ARM64 package in 0.9.0.
- No automatic updater; upgrades use a new installer.
- Current Setup remains unsigned until a production Authenticode certificate is supplied.
- Some upstream transitive dependencies are deprecated even though production audit is currently clean.
