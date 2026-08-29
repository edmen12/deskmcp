# DeskMCP 0.9.0 Release Checklist

This file separates hard public-release blockers from documented limitations.
Run `scripts\check-release-readiness.ps1` before publishing an installer.

## Hard blockers

- [x] **Project license: Apache License 2.0.**
  - Canonical Apache-2.0 text is present at repository root as `LICENSE`.


## Recommended distribution hardening

- [ ] **Authenticode code signing.**
  - Optional for the open-source release; recommended later to provide a verified Windows publisher and reduce Unknown Publisher / SmartScreen friction.

## Release engineering already closed

- [x] .NET 10 WPF build: 0 warnings / 0 errors.
- [x] First Run Wizard: Workspace → Tunnel → ChatGPT connection flow.
- [x] Sensitive search paths are excluded before ripgrep reads file contents.
- [x] Tray exit semantics distinguish keeping services running from quitting DeskMCP.
- [x] Release-stage smoke: read-only profile, 13 tools, single instance, Node cleanup, directory lockcheck.
- [x] Installer smoke: install, upgrade, runtime, uninstall all exit 0.
- [x] Production npm audit: 0 vulnerabilities.
- [x] Repository secret hygiene scan: 0 findings.
- [x] Release manifest and SHA256SUMS match the final Setup binary.
- [x] Source portability scan: no hard-coded local project path, TODO/FIXME/HACK/XXX, or old 0.8.0 version markers.
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
  - This is a release review warning, not an automatic 0.9.0 build blocker in the machine gate.

## Manual clean-user QA still required

- [ ] Install under a fresh Windows user with **Start DeskMCP with Windows** enabled.
- [ ] Sign out/in (or reboot with approval) and verify the Control Panel starts quietly and Gateway becomes Ready.
- [ ] Complete First Run from the installed build and confirm ChatGPT scans exactly 13 tools.
- [ ] Verify normal uninstall keeps DeskMCP user data; separately verify explicit purge removes DeskMCP AppData only.

## Documented limitations — not blockers for a 0.9.0 win-x64 release

- [ ] ARM64 build is not provided. Label the release **Windows x64**.
- [ ] Automatic updater is not implemented. Publish upgrades as a new installer; add Authenticode signing when a production certificate is available.
- [ ] Upstream deprecated npm dependencies remain in Desktop Commander / ExcelJS chains even though production `npm audit` reports zero vulnerabilities.

## Current validated artifact

`runtime\release\DeskMCP-Setup-0.9.0.exe`

SHA-256 at the latest completed installer smoke:

`1c8601e9a96a2ac8de94b4479622716c72bdaeedd02a04812dda4b9f840090ab`

Rebuilds intentionally change the hash; publish only the hash produced by the final release build (or the final signed build when signing is used).
