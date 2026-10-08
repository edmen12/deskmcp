# Desktop 2 clipboard contract (2026-10-09)

## Owner's non-negotiable requirement
- Local Windows **virtual Desktop 1 user** and **virtual Desktop 2 Agent** must NOT share clipboard **for Agent-operated copy/paste**.
- Agent operations must **never** overwrite, read, inspect, cache, log, or restore the owner's real Windows clipboard. In particular **do not implement temporary host clipboard swap/restore**; even quick swapping races with user operations and can leak passwords.
- Agent's copy and paste within its own browser/task should behave normally without requiring a Windows virtual desktop switch.
- On agent lease stop/revoke/session cleanup, clear the corresponding Agent clipboard; never persist the payload in task docs/audit files/history.

## Windows limitation (DO NOT falsely claim solved)
- Microsoft documents that the **window station**, not each Windows virtual desktop, owns the clipboard; normal Desktop 1/2 workspaces in one login session share the Win32 clipboard.
- Therefore arbitrary third-party native apps running on Desktop 2, when users click native Copy/Paste or manually press Ctrl+C/V, **can still use the shared system clipboard**. There is no guaranteed second **OS clipboard** just because a window is on Desktop 2.
- A memory-only **agent-managed virtual clipboard** separates DeskMCP-controlled transfers, NOT all possible app-level clipboard access. Native copy/paste, images/files, rich HTML/RTF, web page scripts using `navigator.clipboard`, context-menu browser-native Copy/Paste and outside-of-DeskMCP user keyboard shortcuts are NOT isolated yet. No native global keyboard interception or VM will be silently introduced.

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

## Release gates still outstanding
- [ ] User requirement choice and honest UX for unsupported native OS clipboard operations (do not claim universal clipboard isolation).
- [ ] Real Agent lease integration with visible Chrome Desktop2 BrowserRuntime, full MCP E2E and lease cleanup.
- [ ] Clipboard protection when untrusted page JS tries `navigator.clipboard.read/write`, native browser context-menu copy/paste, external native programs; either technically contain these or clearly mark unsupported.
- [ ] Tests with multiple browser pages/apps and rich data types: text/plain only verified; image/HTML/file clipboard not supported.
- [ ] Normal owner copy on Desktop1 and simultaneous Agent paste on Desktop2 without altering clipboard, monitored without reading real user data.
- [ ] Full release acceptance and owner authorization before merging/restarting/upgrading installed DeskMCP 0.9.23.
