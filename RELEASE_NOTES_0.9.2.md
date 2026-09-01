# DeskMCP 0.9.2

DeskMCP 0.9.2 adds an explicit session-only Fully Unlocked mode, hardens process-session lifecycle handling, and closes the Windows ARM64 release-validation gap without changing the stable 13-tool MCP surface.

## Highlights

- Added **Unlock** (`fully-unlocked`) alongside Read, Write, and Full.
- Fully Unlocked disables DeskMCP Workspace, sensitive-path, search-exclusion, and fresh-observation write guards for the current session while keeping audit logging and the host OS account permission boundary.
- Full and Fully Unlocked remain session-only and downgrade to a safe persisted profile after restart.
- Fixed exited Gateway-owned process sessions accumulating toward the 32-session cap.
- Prevented a capacity-race failure from leaving an unowned child process behind.
- Added policy/health fields that make the effective Workspace and observation-guard state externally visible.
- Isolated release and installer smoke tests onto temporary loopback ports and Control Panel singleton namespaces so validation can run while a development instance is active.
- Hardened the installer single-instance mutex smoke contract for native Windows ARM64 runners.
- Added a 30-second bounded retry window around installer atomic directory swaps so transient Windows file locks after runtime shutdown do not cause spurious upgrade/recovery failures. Test-mode failures persist the underlying exception type/message for CI diagnostics, and install/rollback/upgrade/recovery smoke subprocesses run on isolated control ports.
- Pruned non-target optional sharp/ripgrep binaries from Windows release stages and added assertions that reject foreign-platform native packages.

## Windows architectures

0.9.2 ships separate native **Windows x64** and **Windows ARM64** artifacts. The full ARM64 chain passes on GitHub's native Windows ARM64 runner, including release-stage runtime checks, the 13-tool MCP smoke test, single-instance behavior, process cleanup, install, rollback, upgrade, interrupted recovery, runtime startup, uninstall, and architecture-specific metadata.

## Update safety

The user-controlled safe-update path now includes manifest schema v2 checks, local size/SHA-256 validation, WinVerifyTrust, compiled publisher-pin enforcement, explicit install confirmation, rollback/recovery, and post-install version/profile verification. Automatic signed execution remains intentionally disabled until a production Authenticode signer and publisher pin are available and the target GitHub Release is immutable. Manual installer upgrades remain supported.

## Compatibility

- Public MCP tool count remains **13**.
- Existing Read/Write/Full behavior is preserved.
- Existing 0.9.x settings and DPAPI-protected Tunnel secrets are preserved during supported upgrades.
- Start-with-Windows preference is preserved across upgrades.

## Signing note

Windows Setup artifacts may still be distributed unsigned while SignPath Foundation approval is pending. Unsigned builds can show **Unknown Publisher / SmartScreen** warnings. No artifact should be represented as SignPath-signed unless it carries a valid signature from the approved production workflow.
