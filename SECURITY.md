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
- Read-before-write uses one-time opaque `observation_id` capabilities returned by `desktop_read_file`. A capability is bound to one canonical path and observed file version, is consumed before mutation, and same-path mutations are serialized so concurrent agents cannot both write from the same observed version.
- Process execution uses opaque Gateway-owned session capabilities. The 32-session ceiling counts both active sessions and in-flight starts before spawn; active state is reconciled against Desktop Commander's own session registry instead of guessed from OS PID liveness, completed output remains readable in bounded history, and Gateway shutdown cleans up owned live sessions.
- Updater execution is fail-closed on source and integrity: the fixed GitHub repository, immutable release metadata, manifest/asset/local size and SHA-256 checks must all match before an installer can run. Authenticode is an additional publisher-identity layer when present: an invalid signature or a mismatch against a configured publisher pin is blocked, while an unsigned artifact that passes the integrity gates remains eligible for a user-initiated update.

The updater threat model and rollback/recovery contract are documented in [`docs/UPDATE_SECURITY.md`](docs/UPDATE_SECURITY.md).

Do not expose port `8765` directly to a LAN or the public Internet.

## Reporting a vulnerability

Do not post exploitable security issues, API keys, tokens, personal files, or proof-of-concept secrets in a public issue.

Use GitHub **Private vulnerability reporting** for security issues:
https://github.com/edmen12/deskmcp/security/advisories/new

This keeps the report private while it is triaged and fixed. Public Issues remain appropriate for non-sensitive bugs and feature requests.
