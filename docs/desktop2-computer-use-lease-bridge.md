# Real Windows virtual Desktop 2 — Computer Use / Agent Desktop lease bridge

**Status: source-only candidate, NOT an exposed MCP route. Isolation release gate RED.** Written 2026-10-09 after the owner's reproduced WinApp `ui set-value` foreground theft. Production DeskMCP 0.9.23 and `main` are not modified.

## Why this bridge exists

The existing production `desktop_ui_action` mainly executes UIA via bundled WinApp in a lease-scoped **private Win32 Desktop Object**. The user instead wants GUI apps on the same physical Windows session's **virtual Desktop 2**, with zero forced switches away from Desktop 1. These are different OS isolation mechanisms. A Windows virtual desktop does not provide a separate global keyboard/mouse stream, and a WinApp UIA action can activate the target WPF HWND even when the verb is conceptually background-safe.

One live A/B comparison identified the triggering call path: `winapp.exe ui set-value` on unprotected WPF Desktop 2 window. The foreground target PID and HWND were observed approximately 118 ms before `Desktop1→Desktop2`; passive VDA notifications confirmed the switch. Repro evidence: `test-area/desktop2-incident-trace/findings-20261009.md`. The owned protected fixture with `WS_EX_NOACTIVATE` did not repeat that behavior on the same operation sequence. This is not a general Windows safety guarantee.

## Implemented source-only linkage

- `src/desktop2-computer-use-candidate.ts`: accepts **window_id + one-time computer_observation_id + explicit agent_desktop_lease_id**. Shares existing `ComputerWindowRegistry`, `ComputerObservationRegistry` and `ComputerUseCoordinator`. Rejects user-desktop observations, stale/reused observation IDs, wrong lease, HWND reuse / process/class mismatch, and targeting safety HUD. Advances the observation generation before native UIA can mutate the app.
- `src/desktop2-direct-uia-lease.ts`: checks `AgentDesktopManager.assertLease` (including live HUD heartbeat), `assertWindowOnLease`, current Desktop1, actual Desktop2's GUID and index, target not pinned/shared, and the same lease generation before/after helper invocation. Handles only `arm`, WPF/WinForms ValuePattern `set_value`, and semantic `scroll` top/bottom; unsupported actions fail closed. Binding `desktopNumber` may be absent on valid older configs; `control.desktopNumber` and native VDA real-time values must both equal 2.
- `Desktop2DirectUiaProcessInvoker`: invokes the standalone native helper through a bounded `execFile` without WinApp CLI, `shell:false`, Windows hidden process, per-request private temporary JSON file (removed on completion). Never includes the text value in errors.
- `test-area/desktop2-direct-uia/Program.cs`: native helper validates root HWND/PID, Desktop2 GUID, Desktop1 active, `WS_EX_NOACTIVATE` on mutations, observer identity/start timestamp, target HWND/PID watch, and latched tripwire. It refuses `invoke`/click/drag/system keyboard.
- `test-area/desktop2-switch-observer/Program.cs`: listens for actual desktop changes and monitored target foreground activation; cannot itself prevent an already queued OS switch. Target arming is done by native helper after verifying window identity and style; the manifest is published atomically.

### Candidate-only call sequence

1. Start a live Agent Desktop control lease for Desktop2 (the existing native HUD heartbeat must be valid).
2. Create a passive observer for this lease/window, `--observe-target`; it publishes a private ready file and a not-yet-created target-watch path. No user-desktop control.
3. Collect Desktop2 HWND/PID/process/class information **passively**, without invoking WinApp focus/activate; capture a semantic snapshot and issue a lease-bound Computer Use observation/window capability.
4. Call `Desktop2ComputerUseCandidate.dispatch(phase='arm')` with the observation ID. It resolves the live window capability and calls `Desktop2DirectUiaLeaseCoordinator.arm`, which validates the real Desktop2 lease, then native `--arm-target` publishes the watched target.
5. Get a **new** observation after arming. Call `dispatch(phase='perform', action=set_value|scroll)`; it consumes the new observation, checks live lease/desktop/HUD, and passes the bounded operation into native `--request`. Results distinguish UIA state readback from independently observed application callbacks.
6. When monitor detects target window foreground theft, real virtual desktop switch, invalid state, observer failure, or lease revocation, abort; never auto-return to Desktop1.

## Release blockers (must not skip)

- The passive Desktop2 window inventory callback, currently `listLiveWindowsPassively`, needs an **actual audited no-focus implementation**. Do not reuse WinApp list/inspect without verifying it cannot activate apps on real virtual Desktop2. The current bridge can be tested with an injected mock but is not wired to the live MCP window/snapshot tools.
- The snapshot must expose unique element `automationId` and prove it matches a unique UIA element in the target; the current helper itself enforces uniqueness but a full UI workflow/selector mapping has not yet been shipped.
- Observer process lifecycle and ready/watch/tripwire file names must be privately scoped to the live Agent lease, automatically cleaned without destroying incident evidence, and invalidated on stop/revoke. The candidate presently assumes a separately launched observer.
- `WS_EX_NOACTIVATE` is a property of **opt-in app-owned windows**. The code intentionally does not mutate arbitrary third-party app styles or prevent their focus side effects; those apps need separately validated, app-specific automation transports.
- Still no live Computer Use MCP registration, real Desktop2 UIA GUI acceptance on this exact chain, popup lifecycle coverage, WinUI/UWP/Electron native coverage or proof of first-switch immunity. A status of `60/60 offline tests pass` is **not** a zero-interference release approval.
- No automatic Windows virtual-desktop switch, global SendInput, shared clipboard fallback, VM, Win32 Desktop Object substitution, install, restart or production update.

## Reproducible offline source checks

With a temporary local-only read-only `node_modules` junction to the main checkout, the candidate TypeScript build passed. Focused regression run:

```text
npm.cmd run build
node --test --test-concurrency=1 dist/tests/desktop2-computer-use-candidate.test.js dist/tests/desktop2-direct-uia-lease.test.js dist/tests/desktop2-background-input.test.js dist/tests/desktop2-handoff.test.js dist/tests/computer-use-safety.test.js
```

Result: **60 tests, 60 PASS, 0 FAIL**. The tests use mocked lease/native interfaces, not actual GUI or foreground input. Older Desktop2 binding records without optional `binding.desktopNumber` are covered by a test.

**Delivery rule:** Leave production `desktop_ui_action` unchanged until the passive provider, observer lifecycle, real-window test and first-switch safety are demonstrably ready. Do not present this candidate as general Computer Use.
