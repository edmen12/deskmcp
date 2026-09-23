## What changed

- Windows file operations now use DeskMCP's native backend for directory listing, file info, writes, edits, directory creation and moves, reducing dependence on the legacy backend for ordinary project work.
- Windows owned process sessions now run through the native ProcessHost backend while keeping DeskMCP's existing policy, elevation, working-directory and short TEMP/TMP controls.
- File/content search now runs through bundled ripgrep with the existing policy filtering and sensitive-path protections instead of creating legacy backend search sessions.
- DeskMCP now preflights the backend at startup and lazily connects the legacy backend only when a fallback operation actually needs it, reducing idle backend/process overhead.
- Browser tooling and startup paths were streamlined while preserving the existing BrowserRuntime safety and Agent Desktop lease contracts.
- Idle Browser teardown now removes an ephemeral profile before releasing profile ownership or making the session disappear, preventing a cleanup race exposed by macOS hosted CI.
- Tests are split into fast, integration, browser and process groups, and builds now reject open TODO/FIXME task markers that would otherwise drift into release source.
- Runtime cleanup tooling was added so disposable build/test output can be removed deterministically without touching user state.
- Windows release packaging now uses one shared self-contained .NET runtime for the Control Panel, ProcessHost and Agent Desktop Host instead of duplicating a self-contained runtime per executable, materially reducing release-stage and installer size.

## Why this release exists

DeskMCP had accumulated several layers where routine Windows file, search and process work still crossed the legacy backend boundary even though the product already owned the policy and lifecycle around those actions. Release packaging also duplicated the .NET runtime across multiple hosts.

0.9.17 makes the Windows runtime more direct and cheaper to keep alive: native operations stay inside DeskMCP, the legacy backend is a fallback instead of an always-connected dependency, and the release payload shares one .NET runtime.

## Validation

- Local full Gateway/runtime suite: 213 passed, 0 failed.
- Test groups: 136 fast + 77 integration.
- Browser focused suite: 53 passed, 0 failed; real Chrome Start / CDP / Snapshot / Console / Close flow verified before the release cut.
- Shared .NET release-stage validation passes.
- Windows installer validation passes clean install, rollback, upgrade, interrupted recovery, runtime smoke and uninstall.
- Hosted CI on exact source commit passes Windows x64, Windows ARM64 and macOS ARM64.
- CodeQL Actions, C#, JavaScript/TypeScript and Swift analyses pass.
