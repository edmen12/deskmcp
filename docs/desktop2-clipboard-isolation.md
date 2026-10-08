# Desktop 2 clipboard contract (2026-10-09)

## Final clarified scope (owner 2026-10-09 01:14 MYT)
- **Only DeskMCP needs its own Agent copy/paste buffer.** When the Agent chooses to copy, it calls DeskMCP's `virtual_copy` API to save the selected content into the Agent's private buffer. When it pastes, it calls `virtual_paste` to insert that content into the destination.
- The Agent's **DeskMCP-managed copy/paste** must not overwrite, read, inspect or temporarily swap the user's Windows clipboard. Agent clipboard data is scoped to the relevant lease and cleared on expiry/cleanup.
- **Do NOT implement a second Windows clipboard, global Ctrl+C/V interception, OS-wide clipboard virtualization, or per-native-app clipboard isolation.** These are explicitly out of scope, not release blockers.
- Native apps, Windows virtual desktops and user-generated Ctrl+C/V can continue to use Windows' ordinary shared clipboard. If DeskMCP itself initiates a copy/paste operation, it must use the Agent buffer; unsupported transfer paths should report their limitation without manipulating the user clipboard.

## Windows context (non-blocking)
- Windows virtual desktops normally share the Windows clipboard; this is accepted by the owner. DeskMCP's independent *software buffer* is sufficient for the requested copy/paste workflow.
- Current candidate implements **text-only browser-managed** `virtual_copy`/`virtual_paste`. Native app adapters for DeskMCP-managed transfers may be developed as needed, but the OS-level clipboard never needs separation.

## Source-only candidate implementation
- `src/desktop2-clipboard.ts`: in-memory per-lease plain-text up to 4096 UTF-16 code units, automatic 15-minute expiration, explicit clear on lease/session cleanup. No Windows clipboard API or disk writes. Data remains distinct across simultaneous leases.
- `src/browser-cdp.ts`: `virtual_copy` and `virtual_paste` actions. `src/browser-tools.ts` makes them valid for an exact selector/reference.
- `src/browser-runtime.ts`: accepts copy/paste **only for an Agent Desktop lease**, using the normal one-time observation and state-token checks, serializing other mutation rules. Scoped browser keypress actions like `Control+C`, `Control+V`, `Control+X`, `Shift+Insert`, `Control+Insert` fail closed rather than trigger the OS clipboard. Ordinary `Control+A` remains allowed. Clears clipboard on lease/session cleanup, revocation, reaper/close-all.
- `src/browser-playwright.ts`: copy target value/selected DOM text directly from the element (reject password fields) and paste through CDP `keyboard.insertText()` to an editable target (also reject password fields); no Win32 `SetClipboardData`, `GetClipboardData`, `navigator.clipboard` or OS clipboard shortcut. Legacy CDP driver has no custom support and must fail closed.
- **Current live product is not upgraded**, and the browser path has not yet been integrated with newly validated real Desktop2 visible-browser launcher. The above is confined to candidate source.

## Evidence
- Source tests: `tests/desktop2-clipboard.test.ts` verifies lease isolation, expiration, no Windows clipboard APIs, shortcut denial. `tests/browser-runtime.test.ts` new fake-driver browser actions verify separate leases cannot read each other's copy and that forbidden shortcuts do not reach the driver.
- Real Windows 11 Desktop2 **visible Chrome** E2E in `test-area/desktop2-chrome-e2e.mjs` confirmed `virtual_copy` of `AGENT_CLIPBOARD_中文` from input selection and `virtual_paste` via Playwright driver, exact input readback. Clipboard sequence number from read-only Win32 `GetClipboardSequenceNumber` remained **1921 -> 1921**, without ever reading owner's clipboard payload. A second lease could not read first lease's content. Chrome stayed on Desktop2, owner desktop remained Desktop1, no forced switching; other prior browser actions still passed.
- This is browser-specific application-level isolation **not an OS-wide independent clipboard**.

## Outstanding implementation tasks (no new clipboard architecture required)
- [x] DeskMCP-managed text copy/paste API already exists as `virtual_copy` / `virtual_paste`; the owner confirmed this is exactly the desired approach. Real Chrome Desktop2 test passed without modifying the Windows clipboard.
- [ ] Integrate the existing Agent clipboard action into the real Desktop2 BrowserRuntime/MCP lease and apply it to other Computer Use input adapters if an Agent copy/paste action needs them.
- [ ] Document supported types (currently plain text, not images/HTML/files) without introducing OS-wide interception or new OS clipboard requirements.
- [ ] Obtain normal full-release acceptance and owner approval before merging/restarting/upgrading installed DeskMCP 0.9.23.
- [x] Out of scope: isolating arbitrary third-party programs' native Ctrl+C/V, Windows clipboard internals, or webpage-initiated clipboard APIs. These are not blockers for the owner-requested DeskMCP-managed buffer.
