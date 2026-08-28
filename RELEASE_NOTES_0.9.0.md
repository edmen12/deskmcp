# DeskMCP 0.9.0

DeskMCP 0.9.0 is the first packaged Windows x64 release candidate focused on a simple install-and-connect workflow.

## What users get

- One self-contained per-user Setup executable.
- No Node.js, npm, .NET, Git, or source checkout required for end users.
- First Run Wizard for selecting a Workspace and configuring an OpenAI Tunnel.
- Direct ChatGPT plugin connection instructions with an expected 13-tool scan result.
- Read-only by default, with local Write and session-only Full permission profiles.
- Tray controls for restart, Tunnel access, and explicit quit semantics.

## Install

1. Run `DeskMCP-Setup-0.9.0.exe`.
2. Choose the Workspace DeskMCP may access.
3. Paste the OpenAI Tunnel ID and Runtime API Key, or configure them later.
4. In ChatGPT choose New plugin → Tunnel → No auth, select the Tunnel, accept the confirmation, then Scan tools.

## Verify

Use the published `SHA256SUMS.txt` or `release-manifest.json` to verify the Setup SHA-256 before running it.

## Security model

- Gateway HTTP listens only on `127.0.0.1:8765`.
- Filesystem access is restricted to the locally selected Workspace.
- Sensitive paths such as `.env`, `.ssh`, `.gnupg`, and `.aws/credentials` are denied by default.
- Sensitive exclusions are applied before ripgrep reads candidate file contents.
- Runtime API keys are protected with Windows DPAPI and are not stored in `settings.json`.
- Full Control does not persist across restarts.

## Release status

The current build is technically validated for install, upgrade, runtime, and uninstall, but it is **not yet a public open-source release** because:

- The project-level LICENSE is still an owner decision.
- The Setup executable has not yet been production Authenticode-signed.

Additional documented limitations: Windows x64 only, no automatic updater, and upstream transitive deprecation warnings remain. See `RELEASE_CHECKLIST.md`, `SECURITY.md`, and `THIRD_PARTY_NOTICES.md`.
