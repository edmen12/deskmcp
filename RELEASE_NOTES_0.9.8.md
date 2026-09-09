# DeskMCP 0.9.8

DeskMCP 0.9.8 focuses on Agent Desktop isolation, automatic task-completion cleanup, administrator-request transparency, and hardened Windows release packaging.

## Highlights

- **Agent Desktop isolation** — owned browser windows can run on a dedicated Windows virtual desktop while the user's current desktop remains free of Agent HUD/edge overlays. The blue edge indicator and **Exit Agent Control** bar are visible only on the bound Agent Desktop.
- **Automatic Agent Desktop exit** — when the matching Task Room is completed, DeskMCP revokes that Agent Desktop lease, closes browser sessions owned by the lease, removes the HUD, and returns the control state to inactive without touching unrelated tasks or browser sessions.
- **Administrator request disclosure** — agent-initiated elevation now shows the real shell/target command before Windows UAC opens, with sensitive values redacted. The disclosure is anchored in the current monitor's bottom-right corner directly above the taskbar and supports taskbar auto-hide.

## Packaging and reliability

- `DeskMCP.ProcessHost` is now published as a .NET 10 self-contained single-file executable. Release contracts reject stray `.dll`, `.deps.json`, and `.runtimeconfig.json` dependencies.
- The Windows uninstaller now reuses the published DeskMCP single-file binary instead of shipping a separate uninstaller executable.
- Fixed AgentDesktopHost boolean-flag parsing for `--show-no-activate`.
- Version consistency checks now cover Gateway, Installer, WPF, ProcessHost, AgentDesktopHost, and Dynamic MCP client metadata.
- Windows x64 CI self-tests now run against the published release-stage DeskMCP payload, matching the ARM64 validation path.

## Validation

- Gateway/runtime suite: **102 passed, 0 failed**.
- Native Windows Agent Desktop + Browser E2E passed, including Desktop 2 window ownership, Desktop 1 HUD isolation, Browser CDP activity, return-to-Desktop-1 cleanup, and Task Room auto-exit.
- Windows x64 build/tests: passed.
- Native Windows ARM64 release validation: passed.
- macOS ARM64 core validation: passed.
