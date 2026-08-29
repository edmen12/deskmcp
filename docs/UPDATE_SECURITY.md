# DeskMCP Update Security Contract

This document defines the trust model for future DeskMCP update checks and installation. It is a security contract, not permission to silently self-update.

## Current status

DeskMCP still supports manual installer upgrades as the universal fallback. Automatic execution is intentionally gated until future releases satisfy every trust requirement below.

Existing releases that were published before GitHub release immutability is enabled are **manual-only** for updater purposes. GitHub documents that release immutability applies only to future releases.

## Security invariants

An update must never:

- change the persisted permission profile;
- persist Full Control;
- change the selected Workspace without explicit user action;
- change the user's **Start with Windows** choice during an upgrade unless the user changes it in Setup;
- overwrite `%APPDATA%\DesktopMCP` or `%LOCALAPPDATA%\DesktopMCP` user data as part of program-file replacement;
- execute an artifact whose identity or integrity cannot be verified;
- turn a mutable or unsigned release into an unattended install;
- remove the manual installer fallback.

Read and Write are the only persisted profiles. Full Control remains session-only and is lost across restart/update by design.
## Trust anchors

DeskMCP uses layered trust rather than trusting a downloaded filename or a hash published beside the same mutable file.

1. **Repository identity** is fixed to `edmen12/deskmcp`.
2. **Stable release identity** requires a non-draft, non-prerelease release whose tag is exactly `v<manifest.version>`.
3. **Release immutability** is required before an updater may treat GitHub metadata as a protected release record.
4. **Artifact integrity** requires GitHub's release-asset `digest`, the release manifest SHA-256, and the locally computed SHA-256 to match exactly.
5. **Windows publisher identity** is required before automatic execution: Authenticode must be valid and the signer must match the publisher identity pinned in the installed DeskMCP version.
6. **Local policy state** is authoritative: execution preflight records the current persisted Read/Write profile, and post-install verification must observe that same profile before normal Gateway startup resumes.

The `authenticodeStatus` string inside `release-manifest.json` is informational only. It is never accepted as proof of signature validity; Windows must verify the downloaded executable locally.

## Decision matrix

| Release state | Updater action |
| --- | --- |
| Invalid tag/product/target/hash/size | Reject; do not execute |
| Draft or prerelease on stable channel | Reject |
| Newer but mutable release | Show manual release link only |
| Immutable but unsigned release | Verified download may be described, but execution remains manual-only |
| Immutable + valid SHA-256 + valid pinned-publisher Authenticode | Eligible for a user-confirmed install |
| Any candidate that changes persisted profile | Reject automatic execution |
## User-controlled update flow

The first implementation should be deliberately conservative:

1. The user chooses **Check for updates**. No background installer execution is allowed.
2. DeskMCP queries the latest stable release from the fixed GitHub repository.
3. Metadata is evaluated with `src/update-policy.ts`.
4. A mutable, legacy-schema, unsigned, or otherwise ineligible release is shown as **manual-only** with a link to the GitHub Release page.
5. An eligible artifact is downloaded to a version-specific `.partial` file under `%LOCALAPPDATA%\DesktopMCP\updates\`.
6. The completed file is closed, SHA-256 and size are checked, then it is atomically renamed out of `.partial` state.
7. Windows Authenticode verification runs on the local file and checks the pinned publisher policy.
8. Only then may the UI enable **Install update**. Installation still requires an explicit user click.
9. DeskMCP records the safe persisted Read/Write profile, stops only its owned services, launches Setup, and exits the Control Panel.
10. After restart, post-install verification compares the persisted profile with the recorded value **before normal Gateway startup resumes**. A mismatch is a security error; Full Control is never restored automatically.

Automatic background download can be considered later as a separate opt-in feature, but it must not weaken the execution gates above.
## Failure and recovery behavior

- **Network interruption:** keep only a `.partial` file; never execute it. A later retry may replace or resume it only after revalidation.
- **Missing or malformed manifest:** manual-only or reject; never infer trust from the filename.
- **Digest/size mismatch:** delete the downloaded candidate and reject it.
- **Mutable release:** do not auto-execute, even if its current digest matches.
- **Invalid Authenticode or unexpected publisher:** do not auto-execute. The user may still use the normal manual release workflow at their own discretion.
- **Installer failure after the old program directory is backed up:** restore the previous program directory.
- **Interrupted installer leaving `.install-*` / `.backup-*`:** the next Setup cleans partial staging and restores the newest valid prior backup when the live install is missing or invalid.
- **Post-install profile mismatch:** treat it as a security error and do not resume normal Gateway startup under the unexpected profile. Recovery must preserve or explicitly restore the recorded safe profile; never escalate permissions to make startup succeed.
- **Post-install runtime regression:** do not silently alter permissions to recover. Keep manual reinstall of a previous verified installer as the recovery path.

User data is intentionally outside the program directory, so program rollback does not need to rewrite settings, DPAPI secrets, logs, or the Workspace.

## Release requirements

Future update-capable releases should be created as drafts, have every asset attached, and only then be published after release immutability is enabled. The release must include:

- `DeskMCP-Setup-<version>.exe`;
- `release-manifest.json` schema v2 or newer;
- `SHA256SUMS.txt`;
- GitHub asset digests for all attached assets;
- Authenticode when automatic execution is intended.
## Threat model

The design addresses:

- corrupted, truncated, or substituted downloads;
- mutable release assets or moved release tags;
- downgrade/replay attempts;
- wrong architecture or wrong product artifacts;
- a release manifest that disagrees with GitHub asset metadata;
- accidental permission escalation during update;
- interrupted program-directory replacement;
- unsigned or incorrectly signed artifacts being executed automatically.

A fully compromised local Windows account is outside this updater's trust boundary. A compromised GitHub maintainer account can publish a new malicious release, but it still cannot pass the automatic execution gate without the separately protected Authenticode publisher credential. Until #6 is completed, unsigned releases therefore remain manual-only.

## Implementation phases

- **Now:** update contract, manifest schema, metadata/execution policy tests, installer rollback and interrupted-install recovery.
- **Before automatic execution:** complete #6, pin the accepted publisher identity, and enable GitHub release immutability for future releases.
- **Then:** add Control Panel check/download/install UI using this contract; do not add a second weaker path.

## Official references

- GitHub immutable releases: https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases
- GitHub release integrity verification: https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity
- GitHub release REST API and asset `digest`: https://docs.github.com/en/rest/releases/releases
- Microsoft WinVerifyTrust / Authenticode policy: https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-winverifytrust
- Microsoft SignTool: https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool
