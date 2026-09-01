# DeskMCP Update Security Contract

This document defines the DeskMCP update trust model. It is a security contract for user-initiated updates, not permission to silently self-update.

## Current status

DeskMCP supports manual installer upgrades as a universal fallback and a user-initiated Control Panel updater for eligible Windows releases.

The normal flow is deliberately simple: DeskMCP checks the fixed GitHub repository, shows that a newer version is available, and lets the user choose **Update Now**. One click downloads the candidate, performs the security checks below, and launches Setup if verification succeeds.

DeskMCP does not require Authenticode merely to make the updater functional. Code signing is a separate publisher-identity layer on top of the source and integrity checks.

Existing releases that were published before GitHub release immutability is enabled remain **manual-only** for updater purposes. GitHub release immutability only protects releases created under that policy.

### Transition from the public 0.9.2 updater

The already-published 0.9.2 Windows client contains the older Authenticode/publisher-pin hard gate. Because updater policy is compiled into the installed client, that released binary cannot gain the assisted unsigned path retroactively. The first release containing this new updater therefore requires a one-time manual installer upgrade for users coming from public 0.9.2 (and older builds with the same gate). After that transition release is installed, later eligible immutable releases can use the one-click **Update Now** path described here.

Do not replace or mutate the existing v0.9.2 release asset to bypass this transition. Publish the new updater as a new version and make future update-capable releases immutable.

## Security invariants

An update must never:

- change the persisted permission profile;
- persist Full Control;
- change the selected Workspace without explicit user action;
- change the user's **Start with Windows** choice during an upgrade unless the user changes it in Setup;
- overwrite `%APPDATA%\DesktopMCP` or `%LOCALAPPDATA%\DesktopMCP` user data as part of program-file replacement;
- execute an artifact whose fixed-repository identity, release metadata, size, or SHA-256 does not match the expected release;
- silently downgrade a present but invalid Authenticode signature into an "unsigned but allowed" state;
- remove the manual installer fallback.

Read and Write are persisted profiles. Full Control remains session-only and is lost across restart/update by design.

## Trust layers

DeskMCP separates artifact integrity from publisher identity.

1. **Repository identity** is fixed to `edmen12/deskmcp`.
2. **Stable release identity** requires a non-draft, non-prerelease release whose tag is exactly `v<manifest.version>`.
3. **Release immutability** is required before the updater may treat GitHub release metadata as a protected release record.
4. **Artifact integrity** requires the GitHub release-asset digest, release-manifest SHA-256, local SHA-256, size, target, artifact name, and release path to agree.
5. **Publisher identity** is additive. If the downloaded file is unsigned, it receives no publisher-verification status but can still proceed after the integrity gates pass. If Authenticode is present, Windows must validate the signature chain. If DeskMCP has a compiled publisher pin, the signer must also match that pin. A bad signature or pin mismatch is blocked.
6. **Local policy state** is authoritative. Before launching Setup, DeskMCP records the current persisted Read/Write profile. Post-install verification must observe the expected version and the same persisted profile before normal operation resumes.

The `authenticodeStatus` value in `release-manifest.json` is informational only and is never accepted as proof. Local Windows verification determines the actual signature state.

Schema-v2 manifests still carry `automaticExecutionRequiresAuthenticode` for compatibility with already released clients and tooling. Current updater execution does not treat that remote field as proof or as a mandatory local signature gate; local source/integrity verification and local Authenticode inspection are authoritative.

## Decision matrix

| Candidate state | Updater action |
| --- | --- |
| Wrong repository/path/tag/product/target/artifact | Reject |
| Draft or prerelease on the stable channel | Reject |
| Manifest/asset/local size or SHA-256 mismatch | Reject and do not execute |
| Newer but mutable release | Manual-only |
| Immutable + integrity verified + unsigned | Eligible for user-initiated **Update Now** |
| Immutable + integrity verified + valid Authenticode, no publisher pin configured | Eligible; signature chain is valid but no pinned publisher identity is claimed |
| Immutable + integrity verified + valid Authenticode + configured publisher pin match | Eligible with publisher identity verified |
| Authenticode present but invalid | Reject; never downgrade to unsigned |
| Configured publisher pin does not match signer | Reject |
| Post-install version/profile does not match the recorded state | Security hold |

## User-controlled update flow

1. The user chooses **Check for updates**. DeskMCP does not silently launch an installer in the background.
2. DeskMCP queries the latest stable release from the fixed GitHub repository.
3. Metadata is evaluated with `src/update-policy.ts`.
4. Ineligible metadata is rejected or shown as manual-only. An eligible newer release is shown simply as available with **Update Now**.
5. When the user clicks **Update Now**, the artifact is downloaded to a version-specific `.partial` file under `%LOCALAPPDATA%\DesktopMCP\updates\`.
6. Content-Length, final byte count, local file size, and SHA-256 are checked against the release data before execution.
7. The `.partial` file is renamed to the final installer only after the integrity checks pass.
8. DeskMCP inspects Authenticode locally. No signature is allowed as an integrity-verified unsigned state. A present but invalid signature is blocked. A valid signature is checked against the compiled publisher pin when one is configured.
9. If verification succeeds, the same **Update Now** action records the pending post-install state, stops only DeskMCP-owned runtime processes, launches Setup, and exits the Control Panel. DeskMCP does not add a second signature-warning or second install-confirmation dialog of its own.
10. Windows may still display its own SmartScreen, Unknown Publisher, UAC, or other operating-system UI according to Windows policy and reputation.
11. After restart, DeskMCP compares the installed version and persisted permission profile with the recorded values before clearing the pending verification state. A mismatch becomes a security hold; Full Control is never restored automatically.

Background or unattended updating is a separate feature and is not implied by this contract.

## Failure and recovery behavior

- **Network interruption:** keep only a `.partial` file; never execute it. A later retry starts from a newly validated candidate.
- **Missing or malformed manifest:** manual-only or reject; never infer trust from the filename.
- **Digest/size mismatch:** delete the downloaded candidate and reject it.
- **Mutable release:** do not use the verified updater execution path.
- **Unsigned artifact:** allowed only after all source/integrity gates pass; it is not described internally as publisher-verified.
- **Invalid Authenticode:** reject the downloaded candidate. Do not reinterpret a broken signature as unsigned.
- **Unexpected signer with a configured pin:** reject the downloaded candidate.
- **Installer launch failure:** clear pending post-install state and report that the update was not started; the verified local installer may be retried if it remains valid.
- **Installer failure after the old program directory is backed up:** restore the previous program directory.
- **Interrupted installer leaving `.install-*` / `.backup-*`:** the next Setup cleans partial staging and restores the newest valid prior backup when the live install is missing or invalid.
- **Post-install profile mismatch:** treat it as a security error and do not resume normal Gateway startup under an unexpected persisted profile.
- **Post-install runtime regression:** do not silently alter permissions to recover. Keep manual reinstall of a previous verified installer as the recovery path.

User data remains outside the program directory, so program rollback does not need to rewrite settings, DPAPI secrets, logs, or the Workspace.

## Release requirements

Update-capable Windows releases should be created as drafts, have every asset attached, and only then be published with release immutability enabled. Each target must include:

- a Setup artifact (`DeskMCP-Setup-<version>.exe` for Windows x64 or `DeskMCP-Setup-<version>-win-arm64.exe` for Windows ARM64);
- a target-specific schema-v2 manifest (`release-manifest.json` or `release-manifest-win-arm64.json`);
- the matching target-specific SHA-256 list;
- GitHub asset digests for the attached assets.

Authenticode is recommended for publisher identity and reputation, but it is not a prerequisite for the user-initiated verified updater path. Signed releases must still pass every source/integrity gate; signing never replaces hash, target, or immutable-release verification.

## Threat model

The design addresses:

- corrupted, truncated, or substituted downloads;
- mutable release assets or moved release tags;
- downgrade/replay attempts;
- wrong architecture or wrong product artifacts;
- a release manifest that disagrees with GitHub asset metadata;
- accidental permission escalation during update;
- interrupted program-directory replacement;
- a malformed or tampered Authenticode signature being treated as harmlessly unsigned.

The integrity path establishes that the downloaded bytes match the release DeskMCP selected from the fixed repository. It does **not** independently prove publisher identity if the artifact is unsigned.

A compromised local Windows account is outside this updater's trust boundary. A compromised GitHub maintainer/release account is also a stronger threat for unsigned releases because an attacker who can publish a new immutable release and matching manifest can create internally consistent hashes. Authenticode with a separately protected signing identity and a compiled publisher pin materially raises that bar, which is why signing remains valuable even though it is not required for basic updater functionality.

## Implementation status

- **Implemented:** fixed-repository update checks, target-aware schema-v2 manifests, immutable-release requirement, asset/manifest/local digest agreement, `.partial` download handling, local size/SHA-256 verification, user-initiated one-click **Update Now**, Authenticode three-state handling, optional compiled publisher pins, installer rollback/recovery, and post-install version/profile verification.
- **Unsigned verified path:** source/integrity success is sufficient for a user-initiated update. DeskMCP does not show its own unsigned-warning dialog.
- **Signed trusted path:** when a valid Authenticode identity is available, DeskMCP validates it locally and enforces the configured publisher pin. Invalid signatures and pin mismatches fail closed.
- **Still pending for production publisher identity:** SignPath Foundation approval or another suitable signing identity, independent certificate verification, publisher-pin rollout/rotation validation, and signed-release QA.

## Official references

- GitHub immutable releases: https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases
- GitHub release integrity verification: https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity
- GitHub release REST API and asset `digest`: https://docs.github.com/en/rest/releases/releases
- Microsoft WinVerifyTrust / Authenticode policy: https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-winverifytrust
- Microsoft SignTool: https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool
