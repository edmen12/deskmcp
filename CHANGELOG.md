# Changelog

All notable changes to DeskMCP are documented here.

## Unreleased

## 0.9.10 — 2026-09-09

### Changed

- `desktop_start_process` now accepts an optional `agent_desktop_lease_id`. When present, DeskMCP validates the lease first, keeps the owned process session inside the normal ProcessHost ownership boundary, and constrains visible windows from the root process and descendants to the lease desktop.
- Agent Desktop background process launch now fails closed if process-tree placement or final desktop verification fails. The just-started owned session is removed and its owned process tree is terminated instead of leaving GUI state on the wrong desktop.
- Administrator launch with `agent_desktop_lease_id` is intentionally rejected for now so a cross-integrity child cannot silently escape Agent Desktop isolation.

### Fixed

- Fixed Agent Desktop GUI descendants such as AQP/MT5 being able to appear on a different Windows virtual desktop than the Agent Control lease. `DeskMCP.AgentDesktopHost` now follows the owned process tree and moves/verifies descendant top-level windows on the lease desktop instead of handling only the shell/root window.
- Fixed a HUD race where switching back to Desktop 1 during overlay creation could make a still-valid Agent Desktop lease look changed/revoked. Lease validity now depends on the lease state itself; the currently viewed desktop only controls HUD visibility.

### Validation

- Gateway/runtime regression suite: 105 passed, 0 failed.
- Agent Desktop focused regression suite: 5 passed, 0 failed.
- Real Windows full-chain GUI E2E passed through MCP `desktop_start_process` → Agent Desktop lease → DeskMCP backend bridge → `DeskMCP.ProcessHost` → PowerShell → parent GUI → child WinForms GUI, with the final window verified on the target Agent Desktop.
- Version consistency gate passes for 0.9.10.

## 0.9.9 — 2026-09-09

### Added

- Added a multi-desktop Agent Desktop pool. Users can bind Desktop 2 or later as independent Agent slots; DeskMCP allocates the first free bound desktop to each new Agent Control lease so concurrent agents no longer compete for one shared desktop.
- Added per-lease desktop ownership to Agent Desktop state. Each active lease now carries its own desktop id/number, task metadata, HUD heartbeat, Browser ownership, and independent stop/revoke lifecycle.
- Added automatic return to Desktop 1 after binding a desktop into the Agent pool. Desktop 1 remains permanently reserved for the user and cannot be bound.

### Changed

- Agent Desktop Browser sessions now live for the full Agent Control lease. A lease-owned Browser cannot be closed independently by an agent; it remains open with page/login state intact until that lease exits, completes, or is revoked.
- Agent Desktop safety HUD/blue edge are scoped to the currently viewed controlled desktop. Returning to Desktop 1 hides Agent overlays while agents on Desktop 2/3/4+ continue running in the background.
- Extended release metadata with `agentDesktopContract=2`, `agentDesktopPoolContract=1`, and `browserLeaseLifetimeContract=1` so x64/ARM64 packaging rejects older single-desktop or early-browser-cleanup behavior.

### Fixed

- Restored the official DeskMCP Tray icon in Windows single-file builds. The original `DeskMCP.ico` is now compiled as a .NET embedded manifest resource, so the Tray no longer depends on an external `brand\DeskMCP.ico` file or WPF pack URI behavior.
- Fixed the first Tray hotfix implementation failing only in published single-file Windows executables: WPF pack resources worked in the normal DLL build but were not reliable for the self-test inside the bundled EXE.
- Added an embedded Tray icon release contract and runtime self-test so x64/ARM64 release-stage validation fails if the official Tray resource disappears again.

### Validation

- WPF Release build passes with 0 warnings and 0 errors.
- Embedded Tray icon self-test passes while the single-file publish contains `DeskMCP.exe` and no external `brand\DeskMCP.ico`.
- Agent Desktop pool regression verifies two bound desktops receive two simultaneous leases and a further lease reports busy only when all slots are occupied.
- Agent Browser regression verifies a lease-owned Browser rejects direct close and remains alive until its Agent Control lease is revoked.
- Gateway/runtime regression suite: 104 passed, 0 failed.

## 0.9.8 — 2026-09-09

### Added

- Added Agent Desktop isolation on Windows so DeskMCP can move owned browser windows to a dedicated virtual desktop while keeping the user's current desktop free of Agent HUD/edge overlays. The Agent Desktop control bar and blue edge indicator are shown only on the bound virtual desktop.
- Added Task Room lifecycle binding for Agent Desktop. Completing the matching recoverable task now revokes that Agent Desktop lease, closes browser sessions owned by the lease, removes the HUD, and returns Agent Desktop to inactive without touching unrelated tasks or browser sessions.
- Added a pre-UAC administrator-request disclosure for agent-initiated elevation that shows the real shell/target command with sensitive values redacted. The disclosure now follows the DeskMCP panel's current-monitor, taskbar-aware bottom-right placement, including taskbar auto-hide handling.

### Changed

- Converted `DeskMCP.ProcessHost` to .NET 10 self-contained single-file packaging and added release contracts that reject stray `.dll`, `.deps.json`, and `.runtimeconfig.json` dependencies.
- Reworked the Windows uninstaller host to reuse the same published DeskMCP single-file binary instead of shipping a separate executable, preserving the existing uninstall flow while reducing Application Control friction.
- Extended version consistency checks to include ProcessHost, AgentDesktopHost, and Dynamic MCP client metadata so every shipped runtime component reports the same release version.
- Updated Windows x64 CI self-tests to execute the published release-stage DeskMCP binary, matching the ARM64 validation path instead of relying on the internal WPF build output layout.

### Fixed

- Fixed AgentDesktopHost parsing of boolean flags such as `--show-no-activate`, which previously could fail a valid move-to-Agent-Desktop operation with an incomplete-argument error.
- Fixed release-stage ProcessHost startup failures caused by missing `hostpolicy.dll` when the published host was treated as framework-dependent.
- Fixed Windows Application Control blocking the old standalone uninstaller executable by eliminating the second uninstaller binary.
- Fixed the administrator-request disclosure appearing near the top of the display instead of directly above the taskbar in the bottom-right corner.

### Validation

- Gateway/runtime test suite: 102 passed, 0 failed.
- Agent Desktop + Browser native E2E passed on Windows, including Desktop 2 window ownership, Desktop 1 HUD isolation, blue-edge/control visibility, browser CDP activity, return-to-Desktop-1 cleanup, and task-completion auto-exit.
- Windows x64, native Windows ARM64, and macOS ARM64 main-branch CI passed on the merged release code.

## 0.9.7 — 2026-09-08

### Added

- Added recoverable task state through `desktop_task_manage`, including persisted steps, checkpoints, block/resume, evidence-based final review, an explicit completion gate, and Workspace-bound Task Rooms with opaque per-room capabilities so parallel chat windows do not share task state by default.
- Added verified expiring artifacts through `desktop_artifact_manage`, including Workspace-policy publication, SHA-256/size verification, bounded chunk reads, retention cleanup, and signed download URLs that default to loopback.
- Added a dynamic Streamable HTTP MCP facade with `desktop_mcp_manage`, `desktop_mcp_tool_search`, `desktop_mcp_tool_inspect`, and `desktop_mcp_tool_call`, expanding the stable DeskMCP surface from 16 to 22 tools without flattening arbitrary upstream MCP schemas into the top-level tool list.
- Added isolated Browser Automation through `desktop_browser_session`, `desktop_browser_snapshot`, and `desktop_browser_act`, expanding the stable DeskMCP surface from 22 to 25 tools with dedicated DeskMCP profiles, loopback CDP, typed page snapshots/actions, and screenshot publication through the verified Artifact store.
- Added versioned model-readable Skills through `desktop_skill_manage`, expanding the stable DeskMCP surface from 25 to 26 tools with local Workspace validation/install, immutable content digests, active-version switching/rollback, bounded resource reads, and remote HTTPS + caller-supplied SHA-256 validation/install under Full or Unlock. Skill scripts remain inert resources and are never auto-executed by this subsystem.

### Changed

- Simplified the Windows updater to a one-click **Update Now** flow: DeskMCP downloads the fixed-repository immutable release asset, verifies size and SHA-256, then launches Setup without a second install confirmation inside DeskMCP.
- Decoupled updater availability from Authenticode. Unsigned artifacts that pass the source/integrity gates are eligible for user-initiated execution; valid signatures add publisher verification, while invalid signatures or configured publisher-pin mismatches are blocked.
- Removed unsigned/publisher-signature status from the normal update UI; signing state remains an internal security/logging concern and Windows may still show its own SmartScreen or publisher UI.
- Hardened multi-agent file mutation safety: `desktop_read_file` now returns a one-time path/version-bound `observation_id`; edit, move, and existing-file writes consume that capability, and same-path mutations are serialized to prevent concurrent lost updates.
- Scoped recoverable tasks into explicit Task Rooms. Normal task list/get/mutation calls now require the room capability; room discovery is limited to the selected Workspace and intentionally omits task ids. Context loss can be recovered explicitly by exact task id or by exact context id plus matching label without invalidating other still-active capabilities.
- Added agent-safe runtime and multi-client stress harnesses that isolate ports, state, Startup shortcuts, Tunnel profiles, singleton namespaces, and owned process trees from any DeskMCP instance already in use.
- Hardened Full Control process ownership for concurrent agents: active state now follows DeskMCP backend's session registry rather than OS PID liveness guesses, completed sessions remain readable in bounded history, start reservations enforce the 32-session ceiling before spawn, and stress coverage now includes 40-way start bursts, read/terminate races, DeskMCP backend crash recovery, and Gateway-owned shutdown cleanup.
- Added `DeskMCP.ProcessHost` with a Windows Job Object (`KILL_ON_JOB_CLOSE`) for Full Control commands, so owned child/grandchild processes are kernel-cleaned when the root session, DeskMCP backend, or Gateway disappears without exposing direct PID-tree termination to MCP callers.
- Prevented a verified update from launching Setup after the user has already begun quitting DeskMCP; shutdown now gates every update entry/continuation, discards a just-finished verified download, and avoids touching closing UI state.

### Security

- Dynamic MCP persists environment-variable names instead of secret values, rejects remote plain HTTP and URL-embedded credentials, and requires session-only Full or Unlock for refresh/live upstream calls. Stdio MCP spawning is intentionally not exposed because it would bypass the existing owned-process boundary.
- Artifact publication is constrained by DeskMCP filesystem policy; copied payloads are checked against persisted SHA-256/size metadata before reads, retention is bounded, and signed URLs default to loopback unless an HTTP(S) base is explicitly configured.
- Task Room capability secrets are persisted only as SHA-256 hashes, are bound to a fingerprint of the selected Workspace roots, and are never written to the metadata-only audit log. Read-only can discover rooms and inspect tasks only with an existing capability; creating/reattaching rooms and mutating tasks now correctly require Write or higher.
- Skill packages reject traversal, symlinks, encrypted ZIP entries, Windows-unsafe paths, oversized expansion, mutable declared-version/digest conflicts, and tampered registry version ids. Local installs remain Workspace-policy bound; remote Skill operations require session-only Full or Unlock, HTTPS without embedded credentials, and a caller-supplied SHA-256.
- Browser Automation requires session-only Full or Unlock plus a locally configured browser executable. DeskMCP never attaches to an existing personal CDP session; each browser uses a DeskMCP-owned profile, loopback-only random CDP port, and the existing ProcessHost/Windows Job Object ownership chain so browser descendants cannot daemonize beyond the owned session.

### Fixed

- Prevented dynamic MCP refresh from overwriting concurrent server configuration changes by merging only discovery fields back into the latest registry state.
- Hardened release-stage WinApp version probing so informational stderr update notices do not fail PowerShell smoke tests or get mistaken for the pinned runtime version.
- Fixed owned Chromium startup on Windows by keeping the browser root process explicitly awaited under ProcessHost; GUI browser startup can no longer return early and lose its Job Object before publishing `DevToolsActivePort`.

## 0.9.6 — 2026-09-07

### Changed

- Removed Desktop Commander branding traces from DeskMCP-owned UI, health responses, logs, source identifiers, tests, CI, documentation, and architecture assets while preserving the complete 16-tool MCP surface and the underlying `@wonderwhy-er/desktop-commander` runtime dependency.
- Renamed DeskMCP-owned backend bridge and health terminology to implementation-neutral DeskMCP backend / desktop runtime naming without changing tool behavior.

### Fixed

- Stabilized completed-process output validation by tolerating the short bounded delay between process exit and final session-output availability, reducing false CI failures without masking real process errors.

## 0.9.5 — 2026-09-06

### Added

- Added Windows Computer Use with `desktop_ui_windows`, `desktop_ui_snapshot`, and `desktop_ui_action`, expanding the Windows MCP surface from 13 to 16 tools.
- Added pinned Microsoft WinApp CLI v0.5.0 x64/ARM64 packaging with upstream SHA-256 provenance, PE architecture checks, extracted-file integrity, MIT notice preservation, and installed-runtime validation.
- Added an optional administrator-request disclosure HUD before Windows UAC, with sensitive command values redacted and a Settings toggle that defaults to On.
- Added a reliable current-user installer path for unattended per-user installation while retaining normal shortcuts, uninstall registration, startup preference, rollback and recovery behavior.

### Changed

- Decoupled Windows console visibility from privilege elevation so `hidden + admin`, `visible + admin`, `hidden + standard`, and `visible + standard` are all supported combinations on Windows.
- Windows Computer Use is UI Automation first, uses opaque window capabilities and short-lived one-time `computer_observation_id` guards, and serializes GUI operations across MCP clients.
- Windows builds now clean `dist` before TypeScript compilation and release staging packages only `dist/src`, preventing stale compiled tests from entering production installers.
- Release-stage, installer and stability smoke runtimes now hard-disable Tunnel access and use isolated state/ports so validation cannot alter the user's live Remote MCP route.

### Security

- Computer Use requires session-only Full Control or Fully Unlocked, does not bypass Windows ACLs/UAC/Secure Desktop, and does not expose WinApp's cross-integrity `post-message` keyboard transport.
- Computer Use backend-internal fields are projected through a DeskMCP-owned allowlist; public window capabilities do not expose HWND/PID targets.
- WinApp executable, companion SkiaSharp runtime, version/provenance markers and license are covered by release-stage and installer integrity validation.

### Fixed

- Fixed administrator elevation being incorrectly coupled to visible console mode.
- Fixed release smoke paths that could observe or interfere with a real Tunnel runtime or hard-coded Gateway port.
- Fixed runtime stability scripts using stale hard-coded Node/Tunnel paths instead of canonical release-target configuration.
- Fixed stale compiled test artifacts surviving source deletion by cleaning `dist` before builds.

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
- Prevented orphan DeskMCP backend processes and release-stage directory locks.
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
