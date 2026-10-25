# DeskMCP candidate — Desktop 2 safety HUD lease revocation investigation
Date: 2026-10-22 MYT
Branch: review/ego-lite-session-gate-20261022
Release status: CANDIDATE ONLY / WPF NATIVE BUILD NOT VERIFIED / NO INSTALL / NO MERGE.

## Actual source of early lease revocation
Read-only inspection of the installed Control Panel's existing log:
C:\Users\User\AppData\Local\DesktopMCP\agent-desktop\control-error.log

Repeated 2026-10-22 UTC entries (including 06:28, 06:35, 06:40, 06:43, 06:44, 07:06:16 and 07:06:51) say:
"Agent Desktop safety HUD is not on its bound desktop."

Control Panel's AgentDesktopControlCoordinator.Tick -> EnsureSafetyOverlayAsync -> AgentDesktopOverlay.IsOnDesktop checks BOTH the edge HWND and HUD HWND through Windows IVirtualDesktopManager.GetWindowDesktopId. A failed check throws, TryRevokeAfterSafetyFailure writes the log and removes the active lease from control.json. The next desktop_start_process request then correctly fails with "Agent Desktop control was revoked or replaced." This is the VERIFIED direct cause of the intermittent process launch failure; it is NOT a ProcessHost or native GUI window enumeration issue.

## Plausible contributor and candidate fix
The older safety blue edge had already stopped animating/changing its top-level WPF Window.Opacity because this can break shell Desktop ID ownership. The neighboring safety HUD still used hudWindow.Opacity=0 BEFORE moving to Desktop 2, and hudWindow.Opacity=1 AFTER the move. That is an inconsistent potentially HWND/desktop-identity-destabilizing transition; a precise causal relationship has not been live-verified.

The candidate fixes the HUD similarly to the blue edge:
- Keep the HUD top-level WPF Window.Opacity=1 throughout the move.
- Hide only its internal UIElement before moving, unhide after desktop placement and live authorization checks.
- Retain nonactivating WPF show and all exact desktop-identity checks; no GoToDesktopNumber or input-desktop switch.
- Diagnostic method logs the observed edge and HUD HWND/Desktop GUID or COM probe error when validation fails, while still revoking the lease. Never repair or reactivate a mismatched HUD silently.

## Verification
- npm run test:fast: 177/177 PASS, including 2 new source invariants for stable HWND opacity and fail-closed lease revocation.
- npm run test:browser: 87/87 PASS.
- git diff --check: PASS.
- No .NET 10 SDK available in existing environment, so the modified WPF Control Panel was NOT compiled nor real-device tested.
- No production control panel restart or install, no desktop switch, no user login and no modification to shared Brain.

## Remaining blockers
1. Obtain a build-verified candidate WPF Control Panel and updated native .NET AgentDesktopHost without changing production.
2. Run multiple live Desktop 2 lease create/active-window/close cycles with the newly compiled candidate WPF host; inspect new edge/hud placement diagnostics for real HUD ownership drift, verify zero Desktop 1 switches.
3. End-to-end candidate MCP desktop_ui_windows -> native WinForms snapshot -> set_value -> invoke -> verified callback with correct isolated Desktop Object, preserving lease and observation checks.
4. Leave WPF/Human Takeover identity and Windows Hello distribution off production until these pass.

The change is a targeted stability fix, not a waiver of safety interlocks or a claim of full Desktop 2 completion.
