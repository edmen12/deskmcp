# DeskMCP 0.9.3

DeskMCP 0.9.3 changes the Windows updater from an Authenticode-gated feature into a user-controlled, integrity-verified update path while preserving the existing fixed-repository and post-install safety checks.

## Highlights

- Simplified the Control Panel update experience to **Update Now**: one click downloads, verifies, and launches Setup when the release is eligible.
- Removed unsigned/publisher-signature status from the normal update UI. DeskMCP does not ask users to make a code-signing decision during a routine update.
- Kept the updater fixed to the official `edmen12/deskmcp` GitHub Release path and matching version/target/artifact contract.
- Kept immutable-release metadata, GitHub asset digest, manifest SHA-256, Content-Length/final byte count, local size, and local SHA-256 as hard integrity gates.
- Changed Authenticode into an additional publisher-identity layer rather than a prerequisite for updater availability.
- An unsigned installer can proceed after all source/integrity gates pass.
- A present but invalid Authenticode signature is rejected and cannot be downgraded into the unsigned path.
- If a publisher certificate pin is compiled into DeskMCP, a valid signed installer must match that pin.
- Post-install verification still checks the exact expected version and preserves the persisted safe permission profile; Full Control remains session-only.

## Transition from 0.9.2

The public 0.9.2 Windows client was released with the older hard gate that disables updater execution when no production Authenticode publisher pin is compiled in. That behavior is part of the already-installed 0.9.2 binary and cannot be changed retroactively.

Therefore **0.9.3 is a one-time manual installer transition for users upgrading from the public 0.9.2 build**. Do not replace or mutate the existing v0.9.2 GitHub Release asset. After 0.9.3 is installed, later eligible immutable releases can use the new one-click **Update Now** flow even when the release is unsigned.

## Update trust model

For user-initiated updater execution, DeskMCP requires:

- fixed official GitHub repository/release path;
- stable, non-draft, non-prerelease release metadata;
- exact target, version, tag and artifact-name agreement;
- immutable GitHub Release metadata;
- matching GitHub asset digest, release manifest SHA-256 and locally computed SHA-256;
- matching expected and downloaded file size.

Authenticode remains useful for publisher identity and Windows reputation, but it does not replace these integrity checks and is not required for the verified unsigned path. If Authenticode is present, local Windows verification is authoritative.

## Validation

The 0.9.3 candidate is expected to pass the existing DeskMCP release chain: TypeScript tests, WPF build, updater security self-test, Windows x64 release-stage runtime smoke, installer single-instance/install/rollback/upgrade/interrupted-recovery/runtime/uninstall smoke, release metadata generation, secret scan, license inventory checks and public-release readiness.

Windows ARM64 must be revalidated on a native ARM64 runner before claiming the 0.9.3 ARM64 artifact is release-ready.

## Compatibility

- Public MCP tool count remains **13**.
- Existing Read/Write/Full/Fully Unlocked permission semantics are unchanged.
- Existing 0.9.x settings and DPAPI-protected Tunnel secrets remain preserved by the supported installer upgrade path.
- Start-with-Windows preference remains preserved across upgrades.

## Signing note

DeskMCP may still distribute the Windows Setup unsigned while the production signing identity is pending. Windows can independently show SmartScreen or publisher UI according to Windows policy and reputation. A later signed release can add publisher identity verification without changing the normal **Update Now** user flow.
