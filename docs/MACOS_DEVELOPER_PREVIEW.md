# DeskMCP macOS ARM64 Developer Preview

This build is for developers and early testers using Apple Silicon Macs.

## Status

- Architecture: Apple Silicon (`arm64`)
- Minimum macOS: 13
- Distribution: GitHub Actions developer-preview artifact
- Signing: ad-hoc test signing only
- Notarization: not notarized
- App Store: not required

This is **not** represented as a production-notarized macOS release.

## Verify the download

The artifact includes `SHA256SUMS-macos-arm64-unsigned.txt` beside the DeskMCP ZIP. Verify it before opening:

```bash
shasum -a 256 -c SHA256SUMS-macos-arm64-unsigned.txt
```

Do not run a file whose checksum does not match.
## Open the app

1. Extract `DeskMCP-<version>-macos-arm64-unsigned.zip`.
2. Move `DeskMCP.app` to Applications if desired.
3. Try to open DeskMCP normally.
4. If macOS blocks the app because it is not notarized, open **System Settings → Privacy & Security** and use **Open Anyway** for DeskMCP, then confirm the prompt.

Do not disable Gatekeeper globally.

## What is already validated

The preview is built on a GitHub-hosted Apple Silicon runner. The build verifies the native SwiftUI app, bundled Node ARM64 runtime, OpenAI Tunnel ARM64 binary, Darwin native npm packages, production dependency audit, bundle structure, and ad-hoc code signature.

DeskMCP keeps its local security model on macOS: Read is the safe default, Full Control is not persisted, the runtime API key is stored in macOS Keychain, and Start at Login uses the native macOS login-item API.

## Production distribution

A future general-user macOS release should use Apple Developer ID signing and notarization. The Developer Preview exists so open-source developers can test DeskMCP before that distribution identity is available.
