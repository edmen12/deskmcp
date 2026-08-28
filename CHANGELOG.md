# Changelog

All notable changes to DeskMCP are documented here.

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
- A project-level open-source LICENSE has not yet been selected.
- Some upstream transitive dependencies are deprecated even though production audit is currently clean.
