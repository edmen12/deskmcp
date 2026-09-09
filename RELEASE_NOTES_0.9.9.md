# DeskMCP 0.9.9

DeskMCP 0.9.9 is a focused Windows hotfix for Tray branding in the single-file release introduced in 0.9.8.

## Fixed

- Restored the official DeskMCP Tray icon for Windows single-file builds.
- The Tray now loads the original `DeskMCP.ico` from an embedded WPF resource instead of requiring an external `brand\DeskMCP.ico` beside `DeskMCP.exe`.
- Kept the existing external icon and generated fallback paths only as compatibility fallbacks; normal release builds no longer depend on either path.
- Added `--tray-icon-self-test` plus an explicit `trayIconEmbeddedContract` in release metadata so x64/ARM64 release validation fails if the embedded brand resource disappears again.

## Validation

- WPF Release build: 0 warnings, 0 errors.
- Embedded Tray icon self-test: pass.
- Windows single-file publish: `DeskMCP.exe` present while external `brand\DeskMCP.ico` is absent, proving the Tray no longer depends on the omitted file.
- Gateway/runtime regression suite: 102 passed, 0 failed.

This release does not change Agent Desktop, permission, Tunnel, updater, or Browser behavior from DeskMCP 0.9.8.
