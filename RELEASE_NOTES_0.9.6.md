# DeskMCP 0.9.6

DeskMCP 0.9.6 is a patch release focused on product identity cleanup and release-test reliability.

## Changed

- Removed Desktop Commander branding from DeskMCP-owned UI, health responses, logs, source identifiers, tests, CI, documentation, and architecture assets.
- Kept the complete 16-tool DeskMCP MCP surface unchanged, including file, search, process, UAC/admin, visible console, and Windows Computer Use capabilities.
- Retained `@wonderwhy-er/desktop-commander` as the underlying runtime dependency with truthful package and license attribution.
- Renamed internal bridge/health terminology to DeskMCP backend / desktop runtime naming.

## Fixed

- Made completed-process output validation tolerate a bounded post-exit synchronization delay, reducing flaky Windows CI failures while still requiring the expected output and exit code 0.

## Release validation

- Windows x64, Windows ARM64, and macOS ARM64 required CI checks must pass before merge.
- Final Windows x64 release staging and installer smoke validate all 16 tools, isolated runtime state, install/upgrade/uninstall, payload integrity, production dependency audit, and license inventory.
