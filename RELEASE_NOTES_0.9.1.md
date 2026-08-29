# DeskMCP 0.9.1

DeskMCP 0.9.1 is a maintenance release focused on brand consistency, release engineering, and contributor-facing quality. It does not change the 13-tool public MCP surface or the default security model.

## Highlights

- MCP server/client metadata now consistently uses `deskmcp-gateway`.
- Runtime log prefixes now use `[deskmcp]`.
- `DeskMCP.exe`, Setup, and Uninstaller carry 0.9.1 Windows file-version metadata.
- Release scripts derive the current version instead of hard-coding 0.9.0.
- `npm run build` now includes a version-consistency gate across the package, Gateway, WPF app, Installer, and Uninstaller.
- README and User Guide installer examples are evergreen across future maintenance releases.
- Source formatting artifacts from earlier automated edits were cleaned up.

## Compatibility

Existing `%APPDATA%\DesktopMCP` / `%LOCALAPPDATA%\DesktopMCP` data paths, legacy shortcut cleanup, control-pipe names, and other upgrade-compatibility identifiers are intentionally retained.

The public MCP tool names remain unchanged. Existing 0.9.0 installations can be upgraded using the 0.9.1 Setup.

## Security and packaging

DeskMCP remains local-first, loopback-only by default, workspace-scoped, and Read-only on first run. Full Control remains session-only. The open-source Windows installer may be unsigned; verify the SHA-256 published with the GitHub Release before running it.
