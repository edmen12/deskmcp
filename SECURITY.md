# Security Policy

## Supported version

Security fixes currently target the latest `0.9.x` development/release line.

## Security model

DeskMCP is designed around a local trust boundary:

- MCP HTTP listens on loopback only.
- Remote access is intended to use an OpenAI Tunnel.
- Filesystem access is limited to locally selected Workspace roots.
- Read/Write/Full profiles are enforced locally on every tool call.
- Full Control is session-only and is never persisted.
- Sensitive credential paths are denied by default and pre-excluded from search.
- Runtime Tunnel keys are protected with Windows DPAPI.
- Audit logs are metadata-only.

Do not expose port `8765` directly to a LAN or the public Internet.

## Reporting a vulnerability

Do not post exploitable security issues, API keys, tokens, personal files, or proof-of-concept secrets in a public issue.

Use GitHub **Private vulnerability reporting** for security issues:
https://github.com/edmen12/deskmcp/security/advisories/new

This keeps the report private while it is triaged and fixed. Public Issues remain appropriate for non-sensitive bugs and feature requests.
