# Code signing policy

DeskMCP is a personal Apache-2.0 open-source project maintained at [edmen12/deskmcp](https://github.com/edmen12/deskmcp).

## Signing provider

DeskMCP has submitted its application to the SignPath Foundation open-source code-signing program and is awaiting approval.

**Pending approval:** Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

No DeskMCP release should be described as SignPath-signed until the project has been accepted and the published artifact has a valid signature.

## Team roles

DeskMCP currently has one maintainer:

- **Committer:** [edmen12](https://github.com/edmen12)
- **Reviewer:** [edmen12](https://github.com/edmen12); contributions from other people require maintainer review before merge.
- **Signing approver:** [edmen12](https://github.com/edmen12); every signing request requires explicit manual approval.

## What may be signed

Only DeskMCP artifacts built from this public repository and its checked-in build scripts are eligible for project signing.

DeskMCP does not use its signing identity to re-sign upstream projects. Bundled upstream open-source runtimes and libraries retain their own licenses and signatures, if any.

Release binaries must preserve DeskMCP product metadata and a consistent version. The repository's version-consistency, release-stage, installer, update-security, license and secret-hygiene checks must pass before a signing request is approved.

## Build and approval provenance

Signing candidates must originate from a reviewed DeskMCP revision. Release builds are produced by the repository build pipeline; binary artifacts are not accepted from an unrelated local build for signing.

A signing request is a separate manual approval step. CI success alone does not authorize signing or publishing.

The signing private key must remain under the signing service's protected key infrastructure; it must not be exported into this repository, GitHub Actions secrets, a maintainer workstation, or a release asset.

## Release verification

All Windows releases remain subject to DeskMCP's independent source and integrity gates: target-specific immutable release metadata, matching GitHub asset digest, manifest SHA-256, locally computed SHA-256, size, target, and artifact identity checks. Signed releases add a separate publisher-identity layer through Windows Authenticode validation and, when configured, a compiled publisher certificate pin.

Certificate rotation must use an overlap release that trusts both the old and new certificate pins before the old identity is retired. Unsigned artifacts are not treated as publisher-verified, but they may still use the user-initiated verified update path after the source and integrity gates pass. A present but invalid Authenticode signature, or a mismatch against a configured publisher pin, is blocked rather than downgraded to unsigned.

## Privacy

See [PRIVACY.md](PRIVACY.md). DeskMCP does not operate a telemetry or analytics service. Network communication occurs only for user-configured/requested functions described in that policy.
