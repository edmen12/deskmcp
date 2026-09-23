## What changed

- Windows project development/test process launches now accept an explicit verified `cwd` instead of requiring agents to embed `cd` or `Set-Location` in the shell command.
- When a Windows project `cwd` is supplied, DeskMCP defaults that owned process to a short TEMP/TMP root, reducing path growth from pytest, npm, Node, compilers, installers and other tools that create deeply nested temporary directories.
- DeskMCP applies a conservative legacy path-budget guard before launch so dangerously deep project roots fail early instead of producing opaque MAX_PATH errors midway through a build or test.
- The launch context is carried through DeskMCP ProcessHost and the administrator handoff, while Workspace path validation still prevents `cwd` from escaping the selected Workspace.

## Why this patch exists

DeskMCP already shortened installer smoke paths because atomic install/upgrade staging can exceed legacy Windows path limits. General Agent development and test commands did not have the same protection: the project root, generated test folders and operating-system temp paths could compound until a downstream tool hit a legacy path limit.

0.9.16 moves that protection into the process-launch layer so agents can use one stable project working directory contract and DeskMCP can keep temporary-path growth bounded.

## Validation

- Local focused process-launch regression suite: 7 passed, 0 failed.
- Local Gateway/runtime regression suite: 203 passed, 0 failed.
- ProcessHost root/job lifetime tests pass.
- ProcessHost launch-context test verifies CWD, TEMP and TMP propagation.
- Hosted Windows x64 build/tests, Windows ARM64 release validation and macOS ARM64 core validation pass.
- CodeQL Actions, C#, JavaScript/TypeScript and Swift analyses pass.
