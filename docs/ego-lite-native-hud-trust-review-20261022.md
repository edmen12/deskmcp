# DeskMCP Ego Lite — Native HUD trust boundary and revoked-session recovery
Date: 2026-10-22
Scope: independent candidate worktree; no installed/Production change.

## Source-verified current state

- The existing WPF AgentDesktopOverlay is a no-activate, topmost virtual-desktop status overlay; the edge overlay has WS_EX_TRANSPARENT and WS_EX_NOACTIVATE. The HUD already includes a clickable `Exit Agent Control` button that revokes Agent Desktop control, but it is NOT connected to browser Human Takeover acceptance or handback. The existence of that button does not prove physical user presence: UI Automation and scripted clicks may still invoke it.
- AgentDesktopControlCoordinator writes hud-state.json with a heartbeat; AgentDesktopManager.assertLease checks a matching, fresh HUD heartbeat, while isLeaseActive only checks lease presence.
- Browser Handoff Agent/Local ports are in-process capabilities. Merely holding the local port does NOT attest physical user action. The local Control Server named pipe currently accepts shutdown, not verified handoff approvals. Adding a pipe command or local-UI button without stronger user-presence proof could be spoofed by a same-user automation client.
- Therefore do not register accept/resume as remote MCP tools, and do not claim Human Takeover is user-ready.

## Candidate mitigation implemented

- BrowserHandoffBoundary adds irreversible 'revoked' state (cannot be resumed by the existing local port).
- BrowserRuntime detects HUD/lease invalidation during a human-controlled or pending session, revokes ownership and skips automatic window-placement attempts, rather than merely detaching Agent Desktop and allowing an ordinary resume.
- Browser process disappearance also revokes the pending/human state before reclaiming browser resources.
- Browser regression 81/81 PASS and Fast 153/153 PASS; real Edge agent-only regression 10/10 PASS. These do NOT establish trusted native user presence or genuine Desktop 2 Human Takeover.

## Priority follow-up

1. Treat post-teardown recovery separately from handback: once the owned browser process, profile and lock are verified disposed, retire that old Session ID without re-enabling it; unrelated generic tools may resume. If cleanup fails, remain quarantined.
2. Trusted local confirmation requires native Control Panel/HUD interaction and a platform user-presence mechanism; naive WPF click or same-user named pipe is insufficient by itself. Consider Windows Hello/OS-brokered confirmation only after capability and accessibility testing.
3. Revalidate a fresh lease + healthy HUD + window ownership + user confirmation AT THE MOMENT of handback, not only during the reaper heartbeat.
4. No secret-bearing form fields should be returned to Agent just because the Session reverts to 'agent'. Need sanitization and explicit handback privacy UX.
5. No automatic foreground switching from Desktop 1 to Agent Desktop. Test both real Windows virtual desktops and private Win32 desktop object distinctions, including UAC.
6. The native WPF change and complete integration build are blocked by absent dotnet SDK in the candidate execution environment.
7. No merge or deployment of this candidate until the native human attestation and cross-tool privilege review has passed.
