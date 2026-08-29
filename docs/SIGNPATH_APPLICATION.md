# SignPath Foundation application readiness

This page records DeskMCP's preparation for a SignPath Foundation open-source code-signing application. It is not evidence that the project has already been accepted or signed.

## Project identity

- Project: DeskMCP
- Repository: https://github.com/edmen12/deskmcp
- License: Apache License 2.0
- Maintainer: https://github.com/edmen12
- Public releases: https://github.com/edmen12/deskmcp/releases
- Code signing policy: `CODE_SIGNING_POLICY.md`
- Privacy policy: `PRIVACY.md`

## What DeskMCP does

DeskMCP is a local desktop bridge that exposes a fixed MCP tool surface through a locally enforced permission gateway. Users select the Workspace, configure their own OpenAI Tunnel, and choose Read, Write, or session-only Full Control.

DeskMCP is not a vulnerability scanner, exploit framework, credential harvester, privilege-escalation utility, security-bypass tool, or remote administration service operated by the maintainer.

## User safety properties

- Gateway HTTP binds to loopback only.
- Filesystem operations are restricted to a locally selected Workspace.
- Sensitive credential paths are denied by default.
- Full Control is session-only and cannot persist across restart/update.
- Process sessions are Gateway-owned rather than arbitrary PID control.
- Audit logs are metadata-only.
- Normal uninstall is provided, with an explicit optional user-data purge.

## Build provenance

Release-affecting source and build scripts live in the public repository. GitHub Actions uses GitHub-hosted Windows x64, Windows ARM64, and macOS ARM64 runners for validation.

Windows release tooling builds the Gateway, publishes the self-contained Control Panel, stages production dependencies, inventories licenses, validates 13 tools and process cleanup, builds Setup, and runs install/rollback/upgrade/recovery/runtime/uninstall smoke tests before release metadata is generated.

## Third-party components

DeskMCP bundles only reviewed open-source/runtime dependencies and retains their upstream licenses/notices. The OpenAI `tunnel-client` is Apache-2.0 open source. Upstream components are not re-signed as if they were DeskMCP-owned binaries.

The release inventory currently resolves all production package licenses with no unresolved `UNKNOWN` entries. The release checklist separately calls out native redistribution review items such as sharp/libvips.

## Signing workflow after approval

1. Install/authorize the SignPath GitHub integration for the public repository.
2. Configure DeskMCP artifact metadata restrictions and a signing policy tied to the approved branch/workflow.
3. Build the unsigned release artifact on GitHub-hosted runners and store it as a workflow artifact.
4. Submit the workflow artifact to SignPath using origin verification.
5. Require explicit manual approval for every signing request.
6. Verify the returned signed artifact, timestamp, product/version metadata and signer certificate.
7. Only after independent verification, add the approved certificate SHA-256 to the compiled updater publisher-pin set in a prior trusted release.
8. Publish future immutable GitHub Releases; never replace the existing v0.9.1 asset.

## Suggested application summary

**Project name:** DeskMCP

**Repository:** https://github.com/edmen12/deskmcp

**Download / releases:** https://github.com/edmen12/deskmcp/releases

**License:** Apache License 2.0, no commercial dual-licensing of DeskMCP.

**Description:** DeskMCP is a free, local-first desktop bridge for ChatGPT. It runs a loopback-only policy Gateway on the user's computer and exposes 13 MCP tools for a user-selected Workspace. Read-only is the default, Write is workspace-scoped, and Full Control is session-only. Users configure their own OpenAI Tunnel credentials. DeskMCP does not provide vulnerability scanning, exploitation, privilege escalation, security bypass, maintainer-operated remote administration, telemetry, advertising, or credential collection.

**Windows artifacts to sign:** DeskMCP Setup executables for Windows x64 and Windows ARM64. Bundled upstream OSS runtimes remain upstream components and are not re-signed as DeskMCP-owned binaries.
