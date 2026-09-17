## What changed

- Live upgrade now performs the normal graceful DeskMCP/Gateway shutdown and then drains every remaining process whose executable belongs to the old DeskMCP install root before the atomic directory swap. This includes `DeskMCP.ProcessHost.exe` and future helper runtimes that could otherwise keep the old installation locked.
- Uninstall uses the same install-root process sweep so helper executables cannot leave the program directory behind after removal, and its detached self-removal now retries the final directory deletion for a bounded period instead of making a one-shot attempt while the large single-file uninstaller may still be releasing its own image.
- Installer release validation now starts a real long-running ProcessHost from the installed test root during both upgrade and uninstall and requires each operation to terminate it before completing.
- Browser Automation now keeps its owned Chromium Windows Job Object alive across short-lived launcher PID handoff, fixing the reproduced Chrome 153 failure where the browser process tree was killed before `DevToolsActivePort` appeared. Ordinary process tools keep root-lifetime semantics and still kill descendants when the root command exits.
- Browser startup now treats `DevToolsActivePort` as discovery only and waits until the Playwright/CDP endpoint is actually usable. This closes the reproduced Chrome 153 race where the port file appeared 1–105 ms before the loopback CDP socket accepted connections, causing persistent headful profiles to fail with `ECONNREFUSED`.
- The verified-release publisher now uploads assets individually, cleans failed `starter` assets, retries bounded failures, and checks online state, size, and SHA-256 before publishing.
- Stable publication is blocked unless a live-upgrade attestation proves that the currently published Latest version was upgraded to the exact candidate while settings, Tunnel profile, and Startup state remained unchanged and Desktop 1 stayed reserved.

## Why this patch exists

A real 0.9.13 live-upgrade attempt on Windows reproduced an exit-code 14 failure while another agent still had `DeskMCP.ProcessHost.exe` running from the installed DeskMCP directory. The 0.9.13 installer safely kept the old installation in place, and the DeskMCP settings, Tunnel profile, and Startup shortcut remained byte-for-byte unchanged. The same exact released 0.9.13 Setup passed an isolated install on the same machine, narrowing the failure to live install-root process contention.

The final installed-browser gate then reproduced a separate startup race with the persistent `console-audit` profile: `DevToolsActivePort` was already present while the loopback CDP endpoint still refused connections. Five real Chrome 153 probes measured a 1–105 ms gap between port-file publication and socket readiness, so Browser startup now retries CDP readiness within the existing bounded start timeout instead of treating the file alone as proof that Chrome is ready.

## Validation target

0.9.14 must pass the 183-test Gateway/runtime suite, WPF Release build, real install-root ProcessHost upgrade/uninstall regression, installer clean-install/rollback/upgrade/interrupted-recovery/runtime/uninstall chain, release provenance, release readiness, secret hygiene, Windows x64/ARM64 candidate validation, and post-install live verification before the release is considered closed.
