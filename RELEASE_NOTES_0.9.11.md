# DeskMCP 0.9.11

DeskMCP 0.9.11 is a reliability and release-safety hardening release built on top of 0.9.10. It strengthens multi-agent concurrency, Browser ownership, Agent Desktop control locking, updater/installer containment, release provenance, and cross-platform CI behavior without widening the permission model.

## Highlights

- Unified crash-safe cross-process locking for shared state used by Artifact, Dynamic MCP, Task Rooms, Skills, Audit, Browser profiles, and Agent Desktop control.
- Agent Desktop Node/WPF control locking now shares one PID + generation-token protocol with stale-owner recovery, exact-owner release, and cross-language interoperability checks.
- Browser profile ownership now fails closed if the owned browser process cannot be terminated, and lease release is serialized/idempotent across concurrent cleanup paths.
- Windows atomic metadata replacement retries transient `EPERM`, `EACCES`, and `EBUSY` failures instead of turning brief filesystem contention into control/session failure.
- Updater and Installer cleanup no longer follow junction/reparse targets outside their owned state/install trees; fresh-install post-activation failures roll back instead of leaving a half-installed program directory.
- Tunnel helper scripts now resolve the verified release/runtime tunnel client instead of the removed legacy tools path.
- Release metadata requires explicit smoke attestations; safe-test file writes reject reparse/symlink escapes.
- macOS service supervision distinguishes detached/external Gateway ownership instead of treating any healthy process on the local port as Panel-owned.

## Validation

The release branch must pass the repository's version-consistency gate, full Gateway/runtime regression suite, Windows x64 and native Windows ARM64 Installer build/smoke/readiness checks, macOS ARM64 native release-stage validation, CodeQL, release secret hygiene, and exact-main unsigned release-candidate generation before publication.

## Signing status

DeskMCP's SignPath Foundation application remains pending approval. Windows release integrity is therefore based on the repository's immutable-release, target/asset identity, size, and SHA-256 verification path. Authenticode publisher identity will be added only after the documented signing provider flow is approved and independently verified.
