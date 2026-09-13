DeskMCP 0.9.12 is a multi-agent isolation, Tunnel reliability, Browser configuration, and release-provenance hardening release built on top of 0.9.11.

## Highlights

- Agent Desktop computer observations now retain their lease identity across snapshot/action chains, preventing background keyboard actions from falling back to global Windows input when a caller omits the lease on a later action.
- Tunnel ID and Runtime API Key changes are transactional and fail closed. DeskMCP stops the current managed tunnel safely before applying changes and restores the prior profile, secret, settings, and in-memory state if any write fails.
- Browser Automation can be configured from Settings with browser auto-detection, explicit selection, clear/disable, and persistence rollback on save failure.
- Windows release provenance is embedded in the Setup binary and verified across stage, Setup, manifest, current source, signing/finalization, and version-tag checks. macOS developer previews seal the source commit inside the signed app bundle resource.
- Multi-Gateway workspace mutations use cross-process locking, and cleanup failures no longer hide the original mutation error.
- Control Panel and Agent Desktop diagnostic logs are bounded and rotated; additional Windows filesystem transitions use bounded retry handling.
- Current documentation and user-facing contracts are aligned to the 27-tool DeskMCP schema.

## Validation before publication

The 0.9.12 release must pass the version-consistency gate, 181-test Gateway/runtime suite, WPF self-tests, unsigned candidate generation, installer smoke, real two-Desktop Agent Control/keyboard isolation, real Tunnel reconnect/reload, real UAC disclosure/elevation behavior, release provenance/readiness checks, secret hygiene, and final release-asset verification.

## Signing status

The repository is prepared for Authenticode signing, but signing must only be claimed after a real code-signing certificate or approved SignPath flow successfully signs and timestamps the final Setup artifact. The release process must not substitute an unsigned artifact while describing it as signed.
