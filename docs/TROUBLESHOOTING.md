# DeskMCP Troubleshooting

Use this page for common setup and connection problems. Do not post Runtime API Keys, Tunnel credentials, private file contents, or unredacted secrets in issues.

## Windows shows Unknown Publisher

The open-source installer can be distributed without Authenticode signing. Verify the installer SHA-256 against the release `SHA256SUMS.txt`, then use Windows' normal review flow if you trust the downloaded artifact.

A missing Authenticode signature is different from a hash mismatch. **Do not run an installer whose SHA-256 differs from the published release hash.**

## Gateway shows Offline

1. Open the DeskMCP tray Control Panel.
2. Confirm the selected Workspace still exists.
3. Click **Start Gateway** or **Restart Gateway**.
4. If rebuilding from source, quit the running release-stage DeskMCP first; the build scripts intentionally refuse to modify a live stage.

The Gateway health endpoint is local-only at `127.0.0.1:8765`.

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