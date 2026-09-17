## What changed

- Live upgrade now performs the normal graceful DeskMCP/Gateway shutdown and then drains every remaining process whose executable belongs to the old DeskMCP install root before the atomic directory swap. This includes `DeskMCP.ProcessHost.exe` and future helper runtimes that could otherwise keep the old installation locked.
- Uninstall uses the same install-root process sweep so helper executables cannot leave the program directory behind after removal.
- Installer release validation now starts a real long-running ProcessHost from the installed test root during both upgrade and uninstall and requires each operation to terminate it before completing.
- The verified-release publisher now uploads assets individually, cleans failed `starter` assets, retries bounded failures, and checks online state, size, and SHA-256 before publishing.

## Why this patch exists

A real 0.9.13 live-upgrade attempt on Windows reproduced an exit-code 14 failure while another agent still had `DeskMCP.ProcessHost.exe` running from the installed DeskMCP directory. The 0.9.13 installer safely kept the old installation in place, and the DeskMCP settings, Tunnel profile, and Startup shortcut remained byte-for-byte unchanged. The same exact released 0.9.13 Setup passed an isolated install on the same machine, narrowing the failure to live install-root process contention.

## Validation target

0.9.14 must pass the 182-test Gateway/runtime suite, WPF Release build, real install-root ProcessHost upgrade/uninstall regression, installer clean-install/rollback/upgrade/interrupted-recovery/runtime/uninstall chain, release provenance, release readiness, secret hygiene, Windows x64/ARM64 candidate validation, and post-install live verification before the release is considered closed.
