# Privacy Policy

DeskMCP is a local-first open-source desktop bridge. The project maintainer does not operate a DeskMCP telemetry, analytics, advertising, or user-account backend.

## Local data

DeskMCP stores local settings, encrypted Tunnel credentials, metadata-only audit logs, update state, and its default Workspace under the current user's Windows profile. Normal uninstall keeps user data unless the user explicitly chooses the purge option.

Audit logs intentionally exclude file contents, terminal input/output, Authorization headers, API keys, and real process IDs.

## Network communication

DeskMCP does not transfer information to networked systems unless the user explicitly configures or requests the function that requires that communication.

The following user-controlled network operations exist:

- **OpenAI Tunnel:** after the user enters their own Tunnel ID and Runtime API Key, DeskMCP can connect to OpenAI's Tunnel service so ChatGPT can reach the local MCP Gateway.
- **Update check:** when the user chooses **Check for updates**, DeskMCP queries the public `edmen12/deskmcp` GitHub Release metadata and may download a release asset only after the user proceeds through the update flow.

## Third-party services

DeskMCP itself does not control the privacy practices of services the user chooses to connect. Users should review the applicable policies for those services:

- OpenAI privacy policy: https://openai.com/policies/privacy-policy/
- GitHub privacy statement: https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement

Bundled Desktop Commander and other runtime dependencies execute locally as part of DeskMCP's local toolchain unless their documented behavior says otherwise. Third-party license information is listed in `THIRD_PARTY_NOTICES.md` and bundled release notices.

## Workspace access

Filesystem access is limited by the locally selected Workspace and active permission profile. Sensitive credential paths are denied by default. DeskMCP does not upload a Workspace to a project-maintainer server.

When ChatGPT requests a tool operation through the user's configured OpenAI Tunnel, the request and its MCP response necessarily traverse the transport selected by the user. Users should not expose data they do not want processed by the connected service.
