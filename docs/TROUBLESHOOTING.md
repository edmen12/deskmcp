# DeskMCP Troubleshooting

Use this page for common setup and connection problems. Do not post Runtime API Keys, Tunnel credentials, private file contents, or unredacted secrets in issues.

## Windows shows Unknown Publisher

The open-source installer can be distributed without Authenticode signing. Verify the installer SHA-256 against the release `SHA256SUMS.txt`, then use Windows' normal review flow if you trust the downloaded artifact.

A missing Authenticode signature is different from a hash mismatch. **Do not run an installer whose SHA-256 differs from the published release hash.**

## Gateway shows Offline or Starting

1. Open the DeskMCP tray Control Panel.
2. Confirm the selected Workspace still exists.
3. If it shows **Starting…**, the Gateway process is alive and still initializing Desktop Commander. Do not repeatedly restart it just because `/health` is not ready yet.
4. If it remains **Offline**, click **Start Gateway** or **Restart Gateway**.
5. If rebuilding from source, quit the running release-stage DeskMCP first; the build scripts intentionally refuse to modify a live stage.

The Gateway health endpoint is local-only at `127.0.0.1:8765`. After startup, `desktopCommander.startupTiming` reports non-sensitive phase timings for entry access, MCP connect, tool listing, required-tool validation, and total bridge startup.

For source-level startup diagnostics, build first and run `node scripts/measure-startup.mjs --samples 10`. Each sample uses a fresh Node/Desktop Commander process, while warm latency is measured on the already-connected bridge. The script does not flush OS caches or kill unrelated processes.

If `startupTiming.connectMs` dominates while the other phases stay small, the delay is inside the upstream Desktop Commander MCP initialization path rather than DeskMCP policy or HTTP startup. DeskMCP intentionally keeps the real MCP handshake and required-tool validation instead of hiding that latency with mocks or bypasses. Desktop Commander 0.2.47 already contains the hard-timeout fix for its earlier Windows feature-flag startup issue ([upstream #465](https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/465), [PR #467](https://github.com/wonderwhy-er/DesktopCommanderMCP/pull/467)); residual host/network variance should be diagnosed with the phase timings before changing DeskMCP orchestration.

## Tunnel is not Ready

Check that both the Tunnel ID and Runtime API Key are configured. If the credentials changed, open **Settings → Tunnel → Configure**, save them again, then reconnect.

The Runtime API Key is stored using Windows DPAPI. DeskMCP does not write it to `settings.json`.
## ChatGPT does not show 13 tools

Recheck the plugin configuration:

- Name: `DeskMCP`
- Connection: `Tunnel`
- Auth: `No auth`
- Correct Tunnel selected
- **I understand and want to continue** checked

Then run **Scan tools** again. The expected production surface is exactly 13 tools.

## A file or search result is blocked

This may be expected policy behavior. DeskMCP denies sensitive locations such as `.env`, `.ssh`, `.gnupg`, `.aws/credentials`, and related secret-bearing files by default. Search excludes those paths before the underlying search process reads candidate files.

Also verify the file is inside the selected Workspace.

## Write or process tools are denied

Check the permission profile. Read mode intentionally denies writes and process sessions. Write enables guarded filesystem changes inside the Workspace. Full enables Gateway-owned process sessions and is session-only.

## Reporting a bug

Use the GitHub bug template and include the DeskMCP version, permission profile, Windows version, minimal reproduction steps, and sanitized logs. See [`SECURITY.md`](../SECURITY.md) for vulnerability reporting.