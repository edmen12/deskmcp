# DeskMCP 0.9.23 — Release Notes

**Source-version notes (2026-10-25).** This document describes the 0.9.23 engineering baseline. It does **not** certify that the current source commit is an approved public release or authorize installation, automatic upgrading, or promotion of experimental Desktop 2 mutation tools.

## What changed

- **Native Windows operations:** routine file, directory, search and owned-process operations use guarded DeskMCP backends and Windows ProcessHost. Process launches retain working-directory, elevation, policy, job-lifetime and cleanup checks; legacy backend use remains conditional.
- **Agent Desktop safety:** Windows virtual desktop allocation is bound to a HUD-ready lease, with explicit revocation, desktop identity checks and protection against automatically switching the user's Desktop 1. Private Win32 Desktop Object introspection is a separate **read-only** capability and is not an alternate write path.
- **Computer Use controls:** native window inventories, bounded snapshots, one-shot observation and mutation checks, and explicit unknown-delivery outcomes have more extensive fail-closed validation.
- **Browser and human handoff:** BrowserRuntime preserves owned browser processes and profile cleanup; human takeover blocks cross-tool filesystem, process, UI and artifact-download activity, and in-flight signed downloads must complete before authority transfers.
- **Auditing and lifecycle:** improvements cover lease/control provenance, atomic shared state, process capacity reporting, observer cleanup and release-stage reproducibility.
- **MCP tool discovery:** the current normal Gateway presents a 30-tool registered interface; read-only Desktop Object tools and process-capacity introspection are included. The separate real Desktop 2 owner-action endpoint is **staging-only**, gated behind a trusted bridge and out-of-band authorization, and is not available to ordinary `/mcp` callers by default.
- **Build and packaging:** Windows native/WPF builds, self-contained Job Host smoke testing, SHA-256-pinned fixtures and cross-platform CI guards have been updated. macOS packaging includes the local patched Desktop Commander dependency and validates the production license inventory.

## Why this version exists

The aim is a coherent, auditable DeskMCP engineering baseline with one source repository, predictable process ownership and explicit computer-use safety boundaries. Previously separate experiments and their tests were reviewed and consolidated while rejecting legacy pathways that could seize Desktop 1 foreground focus or silently fall back to global input.

## Evidence and validation scope

- The unified Windows source completed **457/457 full tests** and separate **342/342 fast tests** on 2026-10-25; AgentDesktopHost and ControlPanel WPF Release builds passed with 0 warnings and 0 errors.
- A real Windows Win+Tab Desktop 2 acceptance run, using a **self-owned WinForms fixture only**, verified authenticated local HTTP MCP control, native observer, Windows Job-owned process tree, Edit/TextChanged and Button/Click callbacks, ListBox scrolling, one-shot permit replay denial and orderly GUI/observer/process cleanup. The user Desktop 1 remained selected and no fixture foreground-theft events were recorded.
- Evidence and exact exclusions are recorded in `docs/desktop2-main-consolidation-2026-10-25.md` and `docs/REAL_D2_OWNER_AUTH_REVOKE_GATE_20261025.md`. Hosted cross-platform CI results must be verified for the **exact release source commit** before any public release claim.

## Known limitations and release gates

- **Not yet accepted for general third-party GUI control:** arbitrary WPF, WinUI, Electron and Chrome applications have not all passed a full real Desktop 2 no-focus/long-duration acceptance suite. Earlier Chrome visible-launch and private-desktop mutation experiments remain unavailable by default.
- Trusted real-D2 owner authorization must still bind the exact HUD lease/generation, desktop GUID and owned Job provenance. Expiry, disconnection, native crash and HUD Exit need fully validated revoke → drain → Job descendants exit → observer stop → HUD release state transitions.
- Multi-client, multi-monitor, long-soak, installer signature, live upgrade and rollback validation are separate release requirements.
- A **development-validation installer** or smoke test is not a public release attestation. Release promotion requires clean source, exact artifact hashes, verified CI, the documented publisher/signing policy and any applicable upgrade checks. Unsigned Windows builds may produce SmartScreen warnings.
- This consolidation does not restart or update the user's installed DeskMCP. Its installed source revision is tracked separately from the development branch.
