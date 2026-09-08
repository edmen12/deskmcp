# Privacy Policy

DeskMCP is a local-first open-source desktop bridge. The project maintainer does not operate a DeskMCP telemetry, analytics, advertising, or user-account backend.

## Local data

DeskMCP stores local settings, encrypted Tunnel credentials, metadata-only audit logs, update state, its default Workspace, Workspace-bound recoverable Task Rooms, artifact copies/metadata, the dynamic MCP registry, installed versioned Skill packages/registry metadata, and DeskMCP-owned browser profiles under the current user's profile. Task Room capability secrets are returned to the connected client but only SHA-256 hashes are persisted locally; room discovery is scoped to the current Workspace and does not expose task ids. Dynamic MCP registry entries persist non-secret configuration and environment-variable names used to resolve credentials at call time; secret values are not stored in the registry. Installed Skills contain the user-selected instruction/resource files; bundled Skill scripts are stored as resources and are never auto-executed by the Skill subsystem. Browser Automation never reuses the user's personal browser profile or an existing CDP session. Normal uninstall keeps user data unless the user explicitly chooses the purge option.

Audit logs intentionally exclude file contents, terminal input/output, Authorization headers, API keys, Task Room capability secrets, artifact payload bytes, Skill resource contents, dynamic-MCP secret values, and real process/window IDs.

## Network communication

DeskMCP does not transfer information to networked systems unless the user explicitly configures or requests the function that requires that communication.

The following user-controlled network operations exist:

- **OpenAI Tunnel:** after the user enters their own Tunnel ID and Runtime API Key, DeskMCP can connect to OpenAI's Tunnel service so ChatGPT can reach the local MCP Gateway.
- **Update check:** when the user chooses **Check for updates**, DeskMCP queries the public `edmen12/deskmcp` GitHub Release metadata and may download a release asset only after the user proceeds through the update flow.
- **Dynamic MCP:** a user can register Streamable HTTP MCP endpoints. Cached search/inspection stays local; refresh and live tool calls connect only when explicitly invoked under Full or Unlock. Remote plain HTTP endpoints and URL-embedded credentials are rejected.
- **Remote Skills:** Full or Unlock can validate or install a user-requested remote Skill ZIP. DeskMCP requires HTTPS without URL-embedded credentials and a caller-supplied SHA-256 before accepting the package; local Workspace Skill validation/install does not require network access.
- **Browser Automation:** after the user locally configures `DESKTOP_MCP_BROWSER_EXECUTABLE`, Full or Unlock can start a DeskMCP-owned isolated Chromium session and navigate to user-requested HTTP(S) pages. CDP control stays loopback-only, while the browser itself communicates with the websites the user chooses to visit. Browser screenshots can be copied into the local Artifact store.
- **Artifact URLs:** artifact payloads remain local by default and signed URLs use the loopback Gateway. If the user explicitly configures `DESKTOP_MCP_ARTIFACT_BASE_URL`, DeskMCP can return signed URLs based on that HTTP(S) base; the user is responsible for the reachability and privacy properties of that endpoint.

## Third-party services

DeskMCP itself does not control the privacy practices of services the user chooses to connect. Users should review the applicable policies for those services:

- OpenAI privacy policy: https://openai.com/policies/privacy-policy/
- GitHub privacy statement: https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement

Bundled runtime dependencies execute locally as part of DeskMCP's local toolchain unless their documented behavior says otherwise. Third-party license information is listed in `THIRD_PARTY_NOTICES.md` and bundled release notices.

## Workspace access

Filesystem access is limited by the locally selected Workspace and active permission profile. Sensitive credential paths are denied by default. DeskMCP does not upload a Workspace to a project-maintainer server.

When ChatGPT requests a tool operation through the user's configured OpenAI Tunnel, the request and its MCP response necessarily traverse the transport selected by the user. Users should not expose data they do not want processed by the connected service.
