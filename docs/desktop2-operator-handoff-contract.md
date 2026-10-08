# Windows Desktop 2 — owner-corrected autonomous vs human handoff contract

Date: 2026-10-09. **Same local Windows session, real Win+Tab Desktop 2.** No VM/Hyper-V/second Windows login session.

## Owner's actual requirement
The owner DOES NOT require a zero-frame no-flash launch. An Agent-launched app is allowed to appear briefly on Desktop 1 **during startup** and be moved into Desktop 2. The core rule is that **during autonomous Agent operation on Desktop 2**, it must NOT take over Desktop 1, auto-switch the user, steal focus or send mouse/keyboard into the user's current desktop. An occasional transient initial window is explicitly allowed; no continuous distraction or hijack. No VM workaround.

## DeskMCP Agent clipboard (scope corrected 2026-10-09 01:14 MYT)

- The Agent uses **DeskMCP's own software copy/paste API**, not the user's Windows clipboard, whenever DeskMCP carries out a copy or paste operation. Copy = `virtual_copy` into the Agent buffer; paste = `virtual_paste` from that buffer.
- The owner **does not require an independent Windows clipboard** or interception of clipboard operations performed directly by third-party Windows applications. Those native shortcuts can keep their normal Windows behavior. No Hyper-V, global clipboard virtualization or clipboard swap/restore.
- Candidate has browser text transfers with lease-scoped in-memory content, without altering the user clipboard. Native DeskMCP-managed copy/paste adapters are a later integration detail; **OS-wide clipboard isolation is not an acceptance gate**. See `docs/desktop2-clipboard-isolation.md`.

## Two distinct states

**AUTONOMOUS mode (default):**
- Agent runs on Windows virtual Desktop 2, performs normal clicks/typing/scroll/drag/GUI operations without switching Desktop 1, without host-global SendInput, without moving the user's physical cursor or redirecting keyboard focus.
- Apps may be started on Desktop 1 then promptly moved to Desktop 2. Once launched and placed, Agent never returns the app to Desktop 1 as a workaround for an input failure.
- The human is always free to manually navigate Desktop 1 ↔ Desktop 2. No automatic return, forced focus recovery, desktop lock, or keyboard/mouse prevention.

**NEEDS_HUMAN_HANDOFF mode (exception):**
- If the Agent cannot continue until the owner logs in, enters password/OTP, solves verification, approves permission, performs a security-sensitive action or gives interactive control, the Agent may REQUEST a switch to Desktop 2 for a human takeover, with a plain explanation of what's needed.
- A deliberate, explicit handoff may bring the Desktop 2 view to the foreground; this is *not* permission to switch desktops as part of routine automated clicking, dragging, screenshot capture or window management.
- During handoff, the OWNER controls the real keyboard/mouse. Agent stops competing for foreground inputs and waits for user completion; never bypasses authentication, captures secrets, or enters credentials unless user expressly instructs it to.
- The Agent may resume after owner finishes or signals completion; never forcibly send the owner back to Desktop 1.

**IMPORTANT:** A handoff must be explicit and user-aware. Do not silently claim an automated Windows desktop change is normal, and do not auto-return. If implementation of requested handoff is absent, report limitation instead of using unscoped input.

## Acceptance (not achieved until live E2E)

- [ ] Real Windows Desktop 2 contains Agent's app; brief startup visibility on Desktop 1 is permitted, but no sustained presence or accidental focus/keyboard takeover.
- [ ] Autonomous UI actions on Desktop 2 succeed with app-state verification: left/right/double-click, hover, drag/drop, scroll, keyboard incl. shortcuts, Unicode typing, screenshot, dialogs, Chrome/Electron, WPF, WinForms, WinUI.
- [ ] User can remain on Desktop 1 in a separate foreground app throughout Agent operations without Agent-induced desktop switch, pointer jump, typing into Desktop 1, or stolen focus.
- [ ] Explicit NEEDS_HUMAN_HANDOFF identifies the block, informs user, switches/shows Desktop 2 **only for that purpose**, yields input to user, and does not auto-return. Human can manually navigate freely even while Agent operates.
- [ ] No automatic fallback to host-global `SendInput` or background switching for unsupported actions.
- [ ] Full source + native build/regression + real installed candidate tests and owner approval before any upgrade/restart.

## Candidate implementation / limitations (2026-10-09)
- `src/desktop2-handoff.ts`: source-only `Desktop2HandoffController` has four states (`autonomous`, `handoff_requested`, `human_control`, `revoked`) and lease/desktop-ID validation. A request for login/verification/permission/manual action pauses autonomous actions in its own state machine; only explicit owner-side method calls can accept or finish a matching handoff. It does **not** call any Windows switch or global input API, and it never forces the human back to Desktop1.
- `tests/desktop2-handoff.test.ts`: 8/8 PASS; combined with candidate background input tests 14/14 PASS. Native WinForms Desktop2 button/textbox/right/wheel/window screenshot results were re-verified independently with the joined test script; generic drag and double click still do NOT fire app-level events.
- **IMPORTANT NOT INTEGRATED YET:** This is a policy controller only. The actual user-facing Control Panel handoff button, persisted lease state, live pausing of every Computer Use and Browser action, and intentionally user-approved Desktop2 foreground navigation are still outstanding. No claim that real login handoff works today.
- With explicit user permission to test despite limited free RAM, a dedicated **visible Chrome on real Desktop2** was successfully exercised via Playwright CDP in `test-area/desktop2-chrome-e2e.mjs`: Click, Unicode/Ctrl+A, right-click, double-click, HTML drag/drop, wheel, CDP screenshot, native inactive-window screenshot and a second independently opened Chrome popup. Repeated tests kept Desktop1 current; desktop-switch evidence log stayed at 8. This is **browser-specific proven E2E**, NOT general native-app keyboard/mouse compatibility or integrated handoff. See `docs/desktop2-background-input-candidate.md`.
- Source candidate `agent/native-desktop2-background-input-20261008`; installed version 0.9.23 and main remain unchanged, not merged/pushed/installed.
