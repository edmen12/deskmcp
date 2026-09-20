# DeskMCP User Guide

<p align="center"><img src="images/hero.svg" alt="DeskMCP" width="100%" /></p>

DeskMCP connects ChatGPT to a Windows desktop through an OpenAI Tunnel while keeping policy enforcement local. This guide covers installation, First Run, permission profiles, tray behavior, and common recovery steps.

## 1. Install

1. Download `DeskMCP-Setup-<version>.exe` from the GitHub Release.
2. Run the installer for the current Windows user. Administrator access is not required.
3. Keep **Start DeskMCP with Windows** enabled if you want the tray app to start automatically after sign-in.
4. Keep **Open DeskMCP after installation** enabled for the easiest first setup.

The installer is self-contained. End users do not need Node.js, npm, .NET, Git, or the source repository.

> The open-source build may be unsigned. Windows can show **Unknown Publisher / SmartScreen**. Verify the SHA-256 published with the release before running it.

## 2. First Run

<p align="center"><img src="images/first-run-chatgpt.png" alt="DeskMCP First Run" width="430" /></p>

First Run has three steps: choose a Workspace, configure a Tunnel, then finish the ChatGPT plugin connection.
### Choose a Workspace

DeskMCP filesystem tools can only operate inside the folder selected here. Use a dedicated project or working folder rather than an entire drive. You can change the Workspace later in **Settings**.

### Configure the Tunnel

Create a Tunnel in OpenAI Platform, then enter:

- **Tunnel ID**
- **Runtime API Key**

The Runtime API Key is encrypted with Windows DPAPI and is not stored in `settings.json`. You may skip this step and configure it later.

### Connect ChatGPT

In ChatGPT:

1. If a **DeskMCP** plugin already exists, open and reuse it. Otherwise open **Plugins → New plugin**.
2. Only for a new plugin, name it `DeskMCP`. If ChatGPT reports **Connector name already exists**, cancel creation and return to the existing DeskMCP plugin.
3. Set **Connection** to `Tunnel`.
4. Set **Auth** to `No auth`.
5. Select your Tunnel.
6. Check **I understand and want to continue**.
7. Run **Scan tools**.

Expected result: **27 DeskMCP tools**.
## 3. Control Panel

<p align="center"><img src="images/control-panel.png" alt="DeskMCP Control Panel" width="430" /></p>

The Control Panel shows Gateway and Tunnel health, the current Workspace, permission profile, and quick access to settings.

### Permission profiles

- **Read** — recommended default. Read/list/metadata/search plus Task Room discovery, task inspection with an existing room capability, and installed Skill list/get/read plus local validation.
- **Write** — adds guarded filesystem changes inside the selected Workspace plus Task Room creation/reattach, recoverable-task mutation, and local Workspace Skill install/activate/rollback.
- **Full** — adds Gateway-owned process/terminal sessions, Windows Computer Use, isolated Browser Automation, and remote Skill validation/install over verified HTTPS sources for the current session only.

Full Control is deliberately not persisted. After DeskMCP restarts, it returns to the last safe persisted Read or Write profile.

### Status colors

- **Green** — Ready / Live.
- **Amber** — connecting or needs attention.
- **Red** — offline or explicit Full Control risk state.
- **Blue/cyan** — DeskMCP brand and normal interactive controls; it does not replace health semantics.

### Browser Automation

Browser Automation requires session-only **Full** or **Unlock**. By default, **Settings → Browser Automation** auto-detects a local Edge, Chrome or Chromium executable. Use **Choose Browser** to pin a specific `.exe`; DeskMCP saves that path locally and restarts the Gateway. DeskMCP launches its own isolated browser/profile and never attaches to your personal browser session.

Use **Clear** to explicitly disable Browser Automation. The button then changes to **Auto Detect**, which re-enables discovery. `DESKTOP_MCP_BROWSER_EXECUTABLE` is treated as a development/environment override only while auto-detect is enabled and no saved Control Panel selection exists; a manual selection always takes precedence.

### Agent Desktop pool

Desktop 1 is reserved for you. Create Desktop 2 or later with Windows Virtual Desktops, switch to each desktop you want to make available to agents, then use **Settings → Agent Desktop → Bind Current**. Multiple bindings form a pool, so concurrent agents receive different free desktops instead of competing for one desktop.

Each binding is shown separately in Settings:

- **Ready** — available for a new Agent Control lease.
- **Controlling** — currently owned by an agent.
- **Current** — the Windows virtual desktop you are currently viewing.
- **Unavailable** — the original virtual-desktop GUID no longer exists or became Desktop 1.

Use **Unbind** only on an idle or unavailable binding. A controlling desktop shows **In Use** and must exit Agent Control first. DeskMCP identifies bindings by the stable Windows virtual-desktop GUID, so ordinary Desktop 2/3/4 renumbering does not change which desktop belongs to a lease.

When an agent controls a desktop, the blue safety edge and **Exit Agent Control** HUD appear only while you are viewing that controlled desktop. Switching back to Desktop 1 hides the HUD without stopping the agent. Browser Automation started with an Agent Desktop lease keeps its page/login state for the lifetime of that lease and closes when Agent Control exits, is revoked, or its linked Task Room completes.

### Dynamic MCP OAuth

Dynamic MCP connections use Streamable HTTP. For providers that support automatic OAuth client registration, DeskMCP registers a client and stores tokens in OS-protected storage. Some providers, including GitHub MCP, require a pre-created OAuth App instead.

For a pre-created app, configure `desktop_mcp_manage` with `oauth=true`, `oauth_client_id`, and the name of a local `oauth_client_secret_env`; do not provide the secret itself to DeskMCP or an agent. If the provider uses a confidential client, set `oauth_client_auth_method` to the method it documents. GitHub OAuth Apps use `client_secret_post`, which DeskMCP selects by default when a secret environment variable is supplied.

Create the environment variable locally, then restart DeskMCP so the Gateway inherits it. Use `auth_status` to obtain the exact loopback callback URL, add that URL to the OAuth App's callback URLs, and then run `auth_start`. DeskMCP keeps the client ID and environment-variable name in its registry, but never the client secret; tokens and PKCE state remain in OS-protected storage.

## 4. Tray behavior

- **Quit Control Panel (Keep Services Running)** closes the UI but leaves services running.
- **Quit DeskMCP** stops the Gateway and Tunnel process owned by this Panel, then exits.

Externally managed Tunnel processes are not terminated by DeskMCP.
## 5. Where data is stored

```text
%APPDATA%\DesktopMCP\settings.json
%LOCALAPPDATA%\DesktopMCP\secrets\tunnel-runtime-key.dpapi
%LOCALAPPDATA%\DesktopMCP\logs\audit.jsonl
%LOCALAPPDATA%\DesktopMCP\workspace\
%LOCALAPPDATA%\DesktopMCP\tasks\
%LOCALAPPDATA%\DesktopMCP\artifacts\
%LOCALAPPDATA%\DesktopMCP\mcp-hub\
%LOCALAPPDATA%\DesktopMCP\skills\
%LOCALAPPDATA%\DesktopMCP\browser\
```

The internal `DesktopMCP` directory name is retained for upgrade compatibility.

## 6. Uninstall

Normal uninstall removes application files and shortcuts while keeping settings, secrets, logs, and the default Workspace. Choose the explicit data-removal option only when you also want to purge DeskMCP user data.

A custom external Workspace is not deleted by the uninstaller.

## 7. Verify a release

The release includes `SHA256SUMS.txt`. In PowerShell:

```powershell
Get-FileHash .\DeskMCP-Setup-<version>.exe -Algorithm SHA256
```

Compare the output with the SHA-256 published in the same GitHub Release.
