# Desktop 2 guarded real-Windows acceptance — FOREGROUND THEFT CONFIRMED

**Release gate RED; never run the former `run-protected-once.mjs` again.** It now immediately throws `DIRECT_UIA_GUI_QUARANTINED_AFTER_CONFIRMED_FOREGROUND_THEFT` before importing tools, launching processes, or touching Windows GUI.

## What passed

- An isolated, owned message-only foreground/VDA observer started, verified live lease/HUD, and shut down cleanly in about 2.4 seconds without affecting Desktop1.
- A protected, DWM-cloaked and no-activate owned WPF test window was moved to real virtual Desktop2 and passively enumerated by HWND/PID with the human remaining on virtual Desktop1.
- Observer target arming and bounded native `inspect-tree` succeeded, returning `WpfEdit` and `WpfScroller` metadata, with no foreground event during read-only snapshot.

## What failed

At 2026-10-09 ~06:03:04.498 Malaysia time (UTC+08:00), the **first direct native .NET UIA `ValuePattern.SetValue`** operation stole the system foreground for the Desktop2 WPF target despite `WS_EX_NOACTIVATE`. The observer latched `TARGET_FOREGROUND_EARLY_ABORT` at ~06:03:04.526. Real WPF activation/focus messages and app text changes were observed (including an unexpected extra character). No virtual-desktop switch notifications were recorded for this incident; Desktop1 was active at test end. Do not conflate **foreground theft** with a **virtual desktop switch**.

**Full evidence:** `incident-20261009-direct-uia-focus-steal.md`, plus original observer logs under `%LOCALAPPDATA%\DMC\t\deskmcp-d2-lease-7d5897b5-3d3rLO\` and per-run files in `runs/`. Preserve every incident log locally.

## Candidate containment

- DirectUIA ValuePattern set-value is denied before UIA providers at **both** the TypeScript lease adapter and C# native action policy; the native `pattern.SetValue` branch has been removed.
- Monitor readiness deadline now allows 15 seconds on resource-constrained Windows; unready/invalid monitors remain fail-closed. Monitor-only real smoke is verified. No GUI retest is authorized by this file.
- The existing production MCP and installed DeskMCP 0.9.23 have **not** been modified, deployed, or restarted.
- A functional solution needs **independently validated app-specific non-foreground editing**. Possible lines of investigation: verified child Win32 Edit `WM_SETTEXT` with app callback verification, app-owned WPF Dispatcher IPC, or browser CDP—not global `SendInput`, unfocused generic UIA, or a shared clipboard fallback. These are design candidates, not demonstrated fixes.

## Later result — 2026-10-09 15:55–15:59 MYT: native WinForms Edit alternative PASS on owned fixture

The earlier **WPF direct UIAutomation foreground-theft result remains valid**. We did not rerun that quarantined harness.

A **different** test program, `test-area/desktop2-native-edit-probe/`, uses a real `WindowsForms10.Edit.app...` child HWND under a Form that was non-activating before Show, cloaked, moved to Desktop2 and uncloaked only after verification. `run-native-edit-once.mjs` exercised guarded `inspect`, `write`, and `deny-stale` stages through the candidate native `WM_SETTEXT` transport. All three completed PASS, with **no target foreground event, no desktop switch, no application focus/key events**, one exactly matching `TextChanged` on the write run, and zero changes when previous text deliberately mismatched.

Full forensic summary with exact timestamped local evidence paths: `native-winforms-edit-findings-20261009.md`. Raw `runs/native-*/` evidence remains preserved and ignored by Git.

**Scope is narrow:** verified only for this owned single-line WinForms Edit. General real Desktop2 Computer Use remains RED, production remains unchanged, and `ValuePattern.SetValue` remains forbidden.
