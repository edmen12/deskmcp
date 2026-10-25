# Isolated WinForms ListBox selection event experiment

Status: **candidate-only acceptance fixture, not production Computer Use or a generic native selector**.

This module compares a guarded native `LB_SETCURSEL` selection with an in-application WinForms `ListBox.SelectedIndex` change. Its fixture begins DWM-cloaked and with `WS_EX_NOACTIVATE` before first Show. The experiment **must never** run on personal, third-party or Desktop1 windows.

## Dependences

Requires the sibling `DeskMCP-D2-Native-Acceptance` worktree's prebuilt observer/agent host/native lease support, the installed read-only .NET SDK, the current user's explicitly granted **Desktop2** Agent Desktop lease, and a live HUD. These dependencies are a deliberate engineering-only prerequisite; source paths are relative to sibling worktree checkout and cannot be considered portable production code.

Build the two candidate fixtures with the existing DeskMCP .NET 10 SDK:
- `fixture/DeskMCP.SelectionFixture.csproj`
- `native/DeskMCP.SelectionProbe.csproj`

The custom forked native helper's action policy permits **only** `fixture-select-native-list`; its offline `--self-test` confirms that other actions are denied. It validates the target's Desktop2 GUID, live PID, non-activating top-level window style, exactly owned/list-supported child HWND, independent observer readiness/armed target, exact list size (80) and expected previous selection (-1), before dispatching at most one bounded `LB_SETCURSEL`. It never synthesizes `LBN_SELCHANGE` or global input. It reports `appEventConfirmed=false` regardless of successful readback.

The `run-selection-once.mjs` test runner accepts only:
- `list-select-probe`: one external selection to row 7, readback, record actual managed callback count
- `list-managed-event-control`: only the fixture itself selects row 7, confirming `SelectedIndexChanged` listener works
- `list-select-stale`: fixture starts at row 7; a stale expected prior index -1 must reject before mutation

These are **test stages**, not MCP tools. Use the existing DeskMCP Agent Desktop status/start/stop tool to create and terminate the exact Desktop2 HUD lease; never spoof a lease, change desktop or restart formal DeskMCP. Each run captures its own independent foreground observer, GUI event log, lifecycle checks and verdict in an ignored `runs/` folder. A full acceptance requires `desktopBefore=1`, `desktopAfter=1`, no observed tripwire/focus events, GUI/observer exit, and lease maintained through teardown.

After test teardown, verify the saved evidence **offline** (does not launch GUI):
`node scripts/verify-desktop2-selection-evidence.mjs <absolute-path-to-runs> 2026-10-23`

## Observed on 2026-10-23

All three protected Desktop2 owned-fixture runs passed their **limited test assertions**. External `LB_SETCURSEL(7)` updated the selected index but produced zero WinForms `SelectedIndexChanged` callbacks. The fixture's own `SelectedIndex=7` assignment produced one. A stale attempted external selection was rejected and did not add a callback. No Desktop1 virtual desktop switch or foreground alarm was seen, with independent monitored teardown completed.

**Never infer that a selection readback proves user-equivalent application behavior, and never wire this experimental helper into production.**
