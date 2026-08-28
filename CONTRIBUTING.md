# Contributing

Thanks for helping improve DeskMCP.

## Before making changes

Keep the security boundary intact:

- Never bind the Gateway to a non-loopback address by default.
- Never add an MCP-accessible permission escalation tool.
- Never expose arbitrary Windows PID enumeration/control.
- Never log secrets, Authorization headers, file contents, or terminal input/output.
- Do not weaken sensitive-path denial or search pre-exclusion without an explicit security review.
- Do not persist Full Control.

## Local validation

Run:

```powershell
npm.cmd test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\control-panel\wpf\validate.ps1
```

A release-affecting change should also pass:

```cmd
scripts\build-installer.cmd
```
The release pipeline is expected to prove:

- 13 production MCP tools are discoverable.
- Read Only remains the default.
- Single Instance works.
- Gateway/Desktop Commander child processes are cleaned up.
- The stage directory is not left locked.
- Setup install, upgrade, runtime start and uninstall all return success.

## Dependencies

Runtime dependencies must be pinned intentionally. Production packages belong in `dependencies`, not `devDependencies`.

Do not enable dependency lifecycle scripts without reviewing what they execute. The project currently uses `.npmrc` with `ignore-scripts=true` as a supply-chain hardening measure.

## Secrets and test data

Never commit real Tunnel IDs, API keys, `.env` files, SSH/GPG material, cloud credentials, audit logs containing private paths, or user Workspace content.

Use synthetic fixtures under `test-area` for tests.

## Pull requests

Keep changes focused, describe security-boundary changes explicitly, include tests for new policy behavior, and document any user-visible installer/onboarding change in the README.
