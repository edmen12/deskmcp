<p align="center">
  <img src="docs/images/hero.svg" alt="DeskMCP — Your desktop. Connected to AI." width="100%" />
</p>

<p align="center">
  <a href="https://github.com/edmen12/deskmcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/edmen12/deskmcp/actions/workflows/ci.yml/badge.svg?branch=main" /></a>
  <a href="https://github.com/edmen12/deskmcp/releases/latest"><img alt="Latest Release" src="https://img.shields.io/github/v/release/edmen12/deskmcp?display_name=tag" /></a>
  <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-22B8FF" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20x64-2563EB" />
  <img alt="MCP tools" src="https://img.shields.io/badge/MCP%20tools-13-2DE0D8" />
</p>

# DeskMCP

**DeskMCP is an open-source local-first MCP policy gateway that gives ChatGPT controlled access to local files and terminal sessions.** It runs policy enforcement on your computer, exposes a stable MCP tool surface, and connects through an OpenAI Tunnel while keeping the local MCP endpoint bound to `127.0.0.1`.

The default profile is **Read-only**. Filesystem access is scoped to a workspace you choose locally, sensitive paths are excluded before search, and elevated process capabilities are session-owned rather than arbitrary PID control.

> **Personal open-source project by [edmen12](https://github.com/edmen12).**

## Why DeskMCP?

| | |
| --- | --- |
| **Local-first** | The Gateway and policy enforcement run on your computer. |
| **Workspace scoped** | Safe profiles keep file tools inside the folder you explicitly select. |
| **Secure by default** | First run starts in Read-only mode; Full Control and Fully Unlocked are never persisted. |
| **Easy to install** | The self-contained Setup does not require Node.js, npm, .NET, Git, or a source checkout. |
## Product preview

<p align="center">
  <img src="docs/images/control-panel.png" alt="DeskMCP Control Panel" width="430" />
</p>

The tray Control Panel shows Gateway/Tunnel health, the active permission profile, the selected workspace, Windows startup settings, and Tunnel configuration without exposing secrets.

## Windows quick start

<p align="center">
  <img src="docs/images/quick-start.svg" alt="DeskMCP Quick Start" width="100%" />
</p>

1. Download `DeskMCP-Setup-<version>.exe` from the [latest GitHub Release](https://github.com/edmen12/deskmcp/releases/latest) and run it.
2. Choose the workspace DeskMCP may access.
3. In OpenAI Platform, create a Tunnel and copy its **Tunnel ID** and **Runtime API Key** into First Run.
4. In ChatGPT open **Plugins → New plugin**.
5. Use **Name: DeskMCP**, **Connection: Tunnel**, **Auth: No auth**.
6. Select the Tunnel, check **I understand and want to continue**, then **Scan tools**.

Expected result: **13 DeskMCP tools**.

The Runtime API Key is protected with Windows DPAPI and is not written to `settings.json`. Secret writes are verified by immediate DPAPI readback; settings use atomic replacement with a recoverable backup. You can skip Tunnel setup during First Run and configure it later.
## Architecture

<p align="center">
  <img src="docs/images/architecture.svg" alt="DeskMCP architecture and security boundary" width="100%" />
</p>

```text
ChatGPT
  ↕ OpenAI Tunnel
DeskMCP Gateway  (127.0.0.1:8765)
  ↕ local policy enforcement
Desktop Commander
  ↳ selected workspace
  ↳ Gateway-owned process sessions
```

The Tunnel provides the remote transport. The policy decision still happens locally before a filesystem or process action is forwarded to Desktop Commander.

## Permission profiles

- **Read** — default; read, list, metadata and bounded search only inside the selected Workspace.
- **Write** — adds guarded create/edit/write/move operations inside the selected Workspace.
- **Full** — session-only; keeps the Workspace filesystem boundary and adds terminal/process sessions that run with the current Windows user permissions.
- **Unlock** (`fully-unlocked`) — session-only; disables DeskMCP Workspace, sensitive-path and fresh-observation write guards. Filesystem tools and terminal commands can reach anything the current Windows account is permitted to access.

`Full` and `Unlock` are never persisted. Restarting DeskMCP returns to the last safe persisted profile: **Read** or **Write**. Unlock does not bypass Windows ACL/UAC or any remote-client safety policy; it only removes DeskMCP's own local sandbox boundaries.
## Tool surface

DeskMCP currently exposes a stable **13-tool** MCP surface:

```text
desktop_policy_status
desktop_read_file
desktop_list_directory
desktop_get_file_info
desktop_search
desktop_create_directory
desktop_write_file
desktop_edit_file
desktop_move_file
desktop_start_process
desktop_read_process
desktop_interact_process
desktop_terminate_process
```

The schemas stay discoverable across profiles so the remote connection remains stable. **Discoverable does not mean permitted**: every invocation is still checked by the local DeskMCP policy before it can execute.

## Security model

- Gateway HTTP binds only to `127.0.0.1:8765`.
- In Read, Write and Full, allowed filesystem access is restricted to the locally selected Workspace and lexical/canonical path checks block symlink/junction escapes.
- Sensitive paths such as `.env`, `.npmrc`, `.pypirc`, `.netrc`, `.ssh`, `.gnupg`, and `.aws/credentials` are denied by default, and search excludes them before Desktop Commander/ripgrep reads candidates.
- In Read/Write/Full, writes use read-before-write observations and reject stale changes; the observation cache is bounded to 1024 entries and eviction never widens write permission.
- Unlock intentionally disables those three DeskMCP filesystem protections for the current session. Audit remains enabled and Windows account permissions remain the final local boundary.
- Process tools use opaque Gateway-owned session IDs instead of exposing arbitrary Windows PID control. The registry keeps at most 32 live owned sessions and automatically reaps exited sessions before enforcing the cap; arbitrary system process operations, when needed in Unlock, are performed through the terminal under Windows permissions.
- Audit records metadata only; it does not record file contents, terminal input/output, Authorization headers, API keys, or real process PIDs. Writes are serialized and rotate at 10 MB with four bounded backups.

Security reports should use [GitHub Private vulnerability reporting](https://github.com/edmen12/deskmcp/security/advisories/new), not a public issue.

User data lives under:

```text
%APPDATA%\DesktopMCP\settings.json
%LOCALAPPDATA%\DesktopMCP\secrets\tunnel-runtime-key.dpapi
%LOCALAPPDATA%\DesktopMCP\logs\audit.jsonl
%LOCALAPPDATA%\DesktopMCP\workspace\
```

These internal paths intentionally retain `DesktopMCP` for upgrade compatibility even though the public product name is **DeskMCP**.

## Tray behavior

- **Quit Control Panel (Keep Services Running)** closes only the UI.
- **Quit DeskMCP** stops the Gateway and any Tunnel process owned by this Panel, then closes the UI.
- Externally managed Tunnel processes are not killed by DeskMCP.

Uninstall removes program files. Settings, secrets, logs and the default Workspace are kept unless the user explicitly chooses to purge user data.

## Developer workflow

End-user requirements and source-development requirements are intentionally separate.
```powershell
npm.cmd ci --ignore-scripts
npm.cmd test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\control-panel\wpf\validate.ps1
```

For local development, `control-panel\wpf\launch.cmd` builds the Gateway and .NET 10 Control Panel, then starts the current development build.

Build the complete Windows release with:

```cmd
scripts\build-installer.cmd
```

The release pipeline performs Gateway build, self-contained WPF publish, production-only dependency install, third-party license inventory/notices generation, stage smoke, 13-tool validation, Single Instance validation, orphan/lock checks, branded Setup compilation, critical-file SHA-256 integrity generation, injected-failure rollback, corrupt/interrupted-install recovery, install → upgrade → runtime → uninstall smoke, and final release metadata generation.

Generated artifacts live under ignored `runtime\release\` and should be attached to GitHub Releases instead of committed.

## Release verification

A completed release build writes `SHA256SUMS.txt` and `release-manifest.json` beside the final installer.

```powershell
Get-FileHash .\runtime\release\DeskMCP-Setup-<version>.exe -Algorithm SHA256
```

Compare the result with `SHA256SUMS.txt` before running an unsigned build.
## Code signing policy

DeskMCP has submitted its application to the SignPath Foundation open-source signing program and is awaiting project approval. See [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md) for the signing roles, provenance rules, approval policy, and publisher-pin model.

**Pending project approval:** Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). No release is represented as SignPath-signed until it carries a valid signature from the approved signing workflow.

Privacy and network behavior are documented in [PRIVACY.md](PRIVACY.md).

## Current limitations

- DeskMCP 0.9.2 includes separate native Windows x64 and Windows ARM64 release artifacts. Both architectures pass the full release-stage, install, upgrade, rollback/recovery, runtime, and uninstall validation chain; the Windows artifacts remain unsigned while the SignPath Foundation application is pending.
- A native macOS ARM64 menu-bar client, release stage, and downloadable **Developer Preview** artifact pass on Apple Silicon CI. The preview is ad-hoc signed and not notarized; a general-user macOS release still requires Developer ID signing and notarization. See [macOS Developer Preview](docs/MACOS_DEVELOPER_PREVIEW.md).
- Settings now implement the user-controlled safe-update flow through download, local SHA-256/size verification, WinVerifyTrust, compiled publisher-pin checking, explicit install, and post-install version/profile verification. Current builds keep automatic execution disabled because no production Authenticode publisher pin is compiled in; manual installer upgrades remain available.
- The open-source Windows Setup may be distributed unsigned; Windows can show **Unknown Publisher / SmartScreen** warnings until a release signing identity is configured.
- Some transitive npm dependencies emit deprecation warnings even though the current production `npm audit` reports zero vulnerabilities.

## Roadmap

Current and post-0.9.2 work is tracked publicly with explicit acceptance criteria:

- 🚧 [#5 — Fresh Windows user end-to-end validation](https://github.com/edmen12/deskmcp/issues/5) — still requires a clean-user install/startup/First Run/uninstall pass outside the development account.
- 🚧 [#6 — Optional Authenticode signing](https://github.com/edmen12/deskmcp/issues/6) — SignPath Foundation approval, first signed artifact verification, and production publisher pin remain pending.
- ✅ [#7 — Windows ARM64 packaging and validation](https://github.com/edmen12/deskmcp/issues/7) — target-aware runtime/installer pipeline and native Windows ARM64 full-chain validation pass on both the feature branch and merged main commit; issue closed.
- ✅ [#8 — Safe update mechanism](https://github.com/edmen12/deskmcp/issues/8) — trust validation, verified download, rollback/recovery, profile preservation, failure handling, and manual fallback are implemented; issue closed. Production signing remains tracked by #6 and #10.
- ✅ [#9 — Desktop Commander cold-start variance](https://github.com/edmen12/deskmcp/issues/9) — profiled, attributed to upstream initialization variance, surfaced with startup diagnostics, and closed.
- 🚧 [#10 — User-controlled signed updater UI](https://github.com/edmen12/deskmcp/issues/10) — explicit update UX exists, while automatic signed execution remains intentionally blocked until the Authenticode/publisher-pin trust chain is live.

## Support DeskMCP

DeskMCP is free and open-source. If it saves you time and you would like to support ongoing maintenance, you can sponsor the project through **GitHub Sponsors** once the `edmen12` Sponsors profile is approved.

Sponsorship is entirely optional and never changes access to DeskMCP, feature availability, security treatment, or support priority. The repository funding button is configured in `.github/FUNDING.yml`.

## Support

Start with [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md). For reproducible bugs, feature requests, and private security reporting, see [`SUPPORT.md`](SUPPORT.md). Never post Tunnel runtime keys, API keys, or private file contents in a public issue.

## Project files

- [`SUPPORT.md`](SUPPORT.md) — support channels and reporting guidance
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting and security boundaries
- [PRIVACY.md](PRIVACY.md) — local data and user-controlled network behavior
- [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md) — SignPath roles, build provenance, approval and publisher-pin policy
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution workflow
- [`CHANGELOG.md`](CHANGELOG.md) — project changes
- [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) — release QA
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — bundled dependency licensing
- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — illustrated installation and usage guide
- [`docs/MACOS_DEVELOPER_PREVIEW.md`](docs/MACOS_DEVELOPER_PREVIEW.md) — Apple Silicon Developer Preview download, checksum, and Gatekeeper guidance
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — common setup and recovery paths
- [`docs/UPDATE_SECURITY.md`](docs/UPDATE_SECURITY.md) — update trust model, execution gates, and rollback/recovery contract
- [docs/SIGNPATH_APPLICATION.md](docs/SIGNPATH_APPLICATION.md) — SignPath Foundation application status and post-approval integration plan
- [`docs/BRAND.md`](docs/BRAND.md) — DeskMCP visual identity and brand rules

## License

DeskMCP is licensed under the **Apache License 2.0**. See [`LICENSE`](LICENSE).

Third-party components retain their own licenses; see `THIRD_PARTY_NOTICES.md` and the license files bundled with the release.

---

<p align="center">Built as a personal open-source project by <a href="https://github.com/edmen12">edmen12</a>.</p>
