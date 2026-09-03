# DeskMCP Release Checklist

This file separates hard public-release blockers from documented limitations.
Run `scripts\check-release-readiness.ps1` before publishing an installer.

## Hard blockers

- [x] **Project license: Apache License 2.0.**
  - Canonical Apache-2.0 text is present at repository root as `LICENSE`.


## Recommended distribution hardening

- [ ] **SignPath Foundation OSS code signing approval.**
  - Application has been submitted; SignPath Foundation approval is still pending.
  - Until approval and a real signed artifact exist, releases remain unsigned and must not claim a SignPath signature; verified user-initiated updates still depend on the source/integrity gates.
- [ ] **Production publisher pin enabled only after signed-release verification.**
  - The updater pin set stays empty until a SignPath-signed release identity is available and independently verified.

## Release engineering already closed

- [x] .NET 10 WPF build: 0 warnings / 0 errors.
- [x] First Run Wizard: Workspace → Tunnel → ChatGPT connection flow.
- [x] Sensitive search paths are excluded before ripgrep reads file contents.
- [x] Tray exit semantics distinguish keeping services running from quitting DeskMCP.
- [x] Release-stage smoke: read-only profile, 13 tools, single instance, Node cleanup, directory lockcheck.
- [x] Installer smoke: install, injected failure rollback, upgrade, interrupted-install recovery, runtime, uninstall all pass.
- [x] Safe-update contract: manifest schema v2, immutable-release/digest/size gates, optional local Authenticode publisher verification, and post-install profile verification.
- [x] Upgrade Setup preserves an existing **Start with Windows** choice instead of silently enabling it.
- [x] Production npm audit: 0 vulnerabilities.
- [x] Repository secret hygiene scan: 0 findings.
- [x] Release manifest and SHA256SUMS match the final Setup binary.
- [x] Source portability scan: no hard-coded local project path, TODO/FIXME/HACK/XXX, or old 0.8.0 version markers.
## Candidate hardening hosted CI validation

- [x] GitHub Actions third-party steps are pinned to full 40-character commit SHAs.
- [x] Ordinary `CI` and `macOS Developer Preview` runs cancel superseded runs for the same ref; the manual unsigned release-candidate workflow is intentionally not auto-cancelled.
- [x] The new `main` Windows x64 gate passes the complete installer smoke plus release-readiness check on a GitHub-hosted x64 runner.
- [x] The new macOS supervisor policy tests and release stage pass on the GitHub-hosted Apple Silicon runner.
- [x] Native Windows ARM64 complete installer smoke, owned-process teardown/rename lockcheck, self-tests, release readiness and secret hygiene pass on the GitHub-hosted ARM64 runner.
## Third-party licensing closed

- [x] Actual win-x64 release inventory generated from installed production tree: 501 packages.
- [x] No unresolved `UNKNOWN` package licenses remain.
- [x] `buffers@0.1.1` manually resolved to MIT with reviewed Debian/upstream evidence.
- [x] `jszip` and `pizzip` explicitly offer MIT or GPLv3; this distribution elects the MIT option.
- [x] Node.js upstream LICENSE is retained in the payload.
- [x] .NET Windows distribution LICENSE + ThirdPartyNotices are copied from the exact SDK used to publish.
- [x] OpenAI tunnel-client Apache-2.0 LICENSE, NOTICE, licenses list and SPDX are retained.

## Pre-publish legal review warning

- [ ] **sharp/libvips redistribution reviewed.**
  - Preserve `@img/sharp-win32-x64` package LICENSE and README; the package declares `Apache-2.0 AND LGPL-3.0-or-later` and bundles native libraries.
  - This is a release review warning, not an automatic build blocker in the machine gate.

## Manual clean-user QA still required

- [ ] Install under a fresh Windows user with **Start DeskMCP with Windows** enabled.
- [ ] Sign out/in (or reboot with approval) and verify the Control Panel starts quietly and Gateway becomes Ready.
- [ ] Complete First Run from the installed build and confirm ChatGPT scans exactly 13 tools.
- [ ] Verify normal uninstall keeps DeskMCP user data; separately verify explicit purge removes DeskMCP AppData only.

## Documented limitations — not blockers for the current win-x64 release

- [x] Windows ARM64 build/install/upgrade/runtime/uninstall validation passes on the native GitHub ARM64 runner; the current public v0.9.1 asset remains Windows x64 and is not mutated.
- [x] Updater download/verify/install/post-install security-hold path is implemented and passes x64 + ARM64 self-tests. User-initiated execution is gated by fixed-repository immutable release metadata plus matching size/SHA-256; Authenticode adds publisher verification when present but is not required for the verified unsigned update path.
- [ ] Upstream deprecated npm dependencies remain in Desktop Commander / ExcelJS chains even though production `npm audit` reports zero vulnerabilities.

## Current validated artifact

The release pipeline writes the current installer to:

`runtime\release\DeskMCP-Setup-<version>.exe`

Treat the generated `SHA256SUMS.txt` and `release-manifest.json` beside that installer as the source of truth for the final release hash, version, target, and signature status. Rebuilds intentionally change the hash.

## SignPath Foundation OSS signing application

Repository-side preparation:

- [x] OSI-approved Apache-2.0 project license.
- [x] Public released project with documented install and uninstall behavior.
- [x] `CODE_SIGNING_POLICY.md` documents signing provider, roles, provenance and manual approval.
- [x] `PRIVACY.md` documents local data and user-controlled network communication.
- [x] GitHub-hosted x64 and ARM64 unsigned release-candidate workflow prepared for origin verification.
- [x] Signed-artifact finalization script verifies Authenticode/timestamp, re-runs installer smoke, regenerates final metadata and requires signed readiness.

Human/SignPath steps that must not be claimed complete before they occur:

- [ ] Maintainer confirms GitHub MFA is enabled.
- [x] Submit the SignPath Foundation OSS application at `https://signpath.org/apply`.
- [ ] SignPath Foundation accepts DeskMCP.
- [ ] Install/authorize the SignPath GitHub App for `edmen12/deskmcp` as required by the approved setup.
- [ ] Configure SignPath artifact metadata restrictions and signing policy.
- [ ] Approve the first signing request manually and verify the returned signer certificate/timestamp.
- [ ] Add the independently verified certificate SHA-256 to a prior trusted DeskMCP build before enabling signed updater execution.
- [ ] Add a **Code signing policy** link to the live GitHub Release description before any SignPath application refresh or first signing-integration review; do not change existing v0.9.1 assets.
