## What changed

- Dynamic MCP Streamable HTTP servers now support OAuth 2.1 authorization with protected-resource discovery, PKCE/state validation, loopback callback handling, refresh-capable token storage, and explicit authorization status/disconnect flows.
- Providers that require a pre-created OAuth client can now use a static client ID plus a local client-secret environment-variable reference. DeskMCP never persists the client secret itself; it resolves the secret only at runtime for the configured token-endpoint authentication method.
- Configured OAuth scopes are enforced again at the final authorization redirect so a provider-advertised broad scope set cannot silently widen the user's selected scope. `offline_access` is retained only when the authorization server already requested it.
- The installed Control Panel now resolves the bundled Gateway runtime from the packaged installation layout.
- Direct/headless Browser sessions now track last activity and are automatically reaped after 30 minutes of inactivity. Ephemeral profiles are removed during cleanup, while Agent Desktop Browser sessions keep their existing lease-bound lifetime.

## Why this patch exists

Dynamic MCP OAuth originally supported standards-based automatic client registration only. Providers such as GitHub MCP can require a pre-registered OAuth App instead, including a client secret at the token endpoint. 0.9.15 adds that path without moving secret values into DeskMCP's registry or public status surface.

A separate live-machine investigation found multiple direct/headless DeskMCP Browser sessions remaining active after agents had finished using them. Five stale sessions produced roughly 45 Chrome processes and about 1.17 GB of working set. The Browser runtime now reaps abandoned direct sessions after bounded inactivity while preserving Agent Desktop lease semantics.

## Security

- Static OAuth configuration persists only the public client ID, selected token-endpoint authentication method, and the name of the environment variable that contains the secret.
- OAuth tokens, PKCE verifier and discovery state remain in OS-protected secret storage.
- Registry parsing rejects embedded client-secret fields.
- Dynamic MCP remote plain HTTP and URL-embedded credentials remain rejected.
- Browser cleanup retains ownership if process termination fails and retries on the next reaper pass instead of falsely reporting cleanup success.

## Validation

Before release publication, 0.9.15 must pass the exact-tag unsigned Windows x64 and native Windows ARM64 candidate workflows, installer smoke, release readiness, secret hygiene, and the real 0.9.14 → 0.9.15 live-upgrade attestation required by the stable publish workflow.

Local pre-release validation already passes TypeScript typecheck/build, the 194-test Gateway/runtime JavaScript suite, the 24-test Browser Runtime focused suite, and the release secret scan with zero findings.
