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

For a public GitHub release, enable **Private vulnerability reporting / Security Advisories** and use that channel for security reports. A dedicated security contact should be added before the repository is announced publicly.
