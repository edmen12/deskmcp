# DeskMCP Troubleshooting

Use this page for common setup and connection problems. Do not post Runtime API Keys, Tunnel credentials, private file contents, or unredacted secrets in issues.

## Windows shows Unknown Publisher

The open-source installer can be distributed without Authenticode signing. Verify the installer SHA-256 against the release `SHA256SUMS.txt`, then use Windows' normal review flow if you trust the downloaded artifact.

A missing Authenticode signature is different from a hash mismatch. **Do not run an installer whose SHA-256 differs from the published release hash.**

## Gateway shows Offline or Starting

1. Open the DeskMCP tray Control Panel.
2. Confirm the selected Workspace still exists.
3. If it shows **Starting…**, the Gateway process is alive and still initializing DeskMCP backend. Do not repeatedly restart it just because `/health` is not ready yet.
4. If it remains **Offline**, click **Start Gateway** or **Restart Gateway**.
5. If rebuilding from source, quit the running release-stage DeskMCP first; the build scripts intentionally refuse to modify a live stage.

The Gateway health endpoint is local-only at `127.0.0.1:8765`. After startup, `desktopRuntime.startupTiming` reports non-sensitive phase timings for entry access, MCP connect, tool listing, required-tool validation, and total bridge startup.

For source-level startup diagnostics, build first and run `node scripts/measure-startup.mjs --samples 10`. Each sample uses a fresh Node/DeskMCP backend process, while warm latency is measured on the already-connected bridge. The script does not flush OS caches or kill unrelated processes.

If `startupTiming.connectMs` dominates while the other phases stay small, diagnose the bundled backend startup path before changing DeskMCP policy or HTTP orchestration. DeskMCP keeps the real MCP handshake and required-tool validation so startup diagnostics reflect production behavior.

## Tunnel is not Ready

Check that both the Tunnel ID and Runtime API Key are configured. If the credentials changed, open **Settings → Tunnel → Configure**, save them again, then reconnect.

The Runtime API Key is stored using Windows DPAPI. DeskMCP does not write it to `settings.json`.
## Connector name already exists

ChatGPT plugin names are account-side and are not removed by reinstalling DeskMCP. If **DeskMCP** already exists, do not create another plugin with the same name. Cancel **New plugin**, open the existing DeskMCP plugin, confirm it uses the current Tunnel, then run **Scan tools** again.

## ChatGPT does not show 27 tools

Recheck the plugin configuration:

- Name: `DeskMCP`
- Connection: `Tunnel`
- Auth: `No auth`
- Correct Tunnel selected
- **I understand and want to continue** checked

Then run **Scan tools** again. The expected production surface is exactly 27 tools.

## A file or search result is blocked

This may be expected policy behavior. DeskMCP denies sensitive locations such as `.env`, `.ssh`, `.gnupg`, `.aws/credentials`, and related secret-bearing files by default. Search excludes those paths before the underlying search process reads candidate files.

Also verify the file is inside the selected Workspace.

## Write or process tools are denied

Check the permission profile. Read mode intentionally denies writes and process sessions. Write enables guarded filesystem changes inside the Workspace. Full enables Gateway-owned process sessions and is session-only.

## Agent Desktop cannot bind or reports no free desktop

Desktop 1 is reserved for you and cannot be bound. Create Desktop 2 or later, switch to that desktop, then use **Settings → Agent Desktop → Bind Current**. If every bound desktop shows **Controlling / In Use**, another Agent Control lease already owns each slot; exit one lease or bind another idle virtual desktop.

## An Agent Desktop shows Unavailable

DeskMCP binds the stable Windows virtual-desktop GUID, not just the visible Desktop 2/3/4 number. **Unavailable** means that GUID was removed or now resolves to Desktop 1. Use **Unbind** on the unavailable entry, create or switch to the replacement Windows virtual desktop, then bind it again. Normal Windows renumbering is handled automatically and does not require rebinding while the GUID still exists.

## Unbind is disabled or shows In Use

A controlling desktop cannot be unbound while an agent owns its lease. Switch to that controlled desktop and choose **Exit Agent Control**, or stop the matching Agent Desktop lease from the agent. When the entry returns to **Ready**, Unbind becomes safe.

## Agent Desktop HUD or browser lifetime looks wrong

The blue safety edge and **Exit Agent Control** HUD are visible only on the currently viewed controlled desktop. Switching to Desktop 1 hides the overlay without stopping work on another bound desktop. A Browser Automation session attached to an Agent Desktop lease is expected to remain open across browser tool calls; it closes when that Agent Control lease exits, is revoked, or its linked Task Room completes.

## Reporting a bug

Use the GitHub bug template and include the DeskMCP version, permission profile, Windows version, minimal reproduction steps, and sanitized logs. See [`SECURITY.md`](../SECURITY.md) for vulnerability reporting.
