# DeskMCP Human Takeover — Desktop-bound Windows Hello review
Date: 2026-10-22 | Candidate branch: review/ego-lite-session-gate-20261022
STATUS: CANDIDATE ONLY, NOT WPF INTEGRATED, RELEASE RED.

## Implemented
- Signed challenge protocol v2 now includes Browser Session UUID, lease UUID, Windows Desktop GUID, action, epoch, random nonce and expiry.
- Native signing coordinator rechecks original Desktop GUID and live lease after the OS signer resolves; a desktop swap fails closed.
- BrowserRuntime.assertLocalHandoffLease requires correct owned visible browser, valid Desktop 2+ lease, active process, fresh HUD heartbeat AND hud_visible=true.
- Native C++/WinRT reviewer validates strict 8-field v2 challenge. The direct --sign command is removed.
- --review-sign now REQUIRES an explicit, valid owner HWND. Win32 COM GetWindowDesktopId must equal the signed Desktop GUID and the currently visible shell Desktop must match. Otherwise it refuses before showing UI.
- When permitted, the native reviewer presents a Cancel-default window explaining the action and prior-tab deletion; ONLY after explicit review would it invoke KeyCredential.RequestSignAsync. The code is compiled, not actually invoked with a real owner.
- Native virtual-desktop DLL is loaded from the executable's fixed sibling directory; the candidate binary has no such dependency and fails closed before prompts.
- MSVC script and standalone native-safe regression tests added; no dotnet SDK installed.

## Verified
- npm run test:fast: 166/166 PASS.
- npm run test:browser: 87/87 PASS.
- Real isolated headless Chromium Edge with synthetic local lease/approval: 12/12 PASS, no test processes/profile retained.
- Standalone native reviewer C++ compile: PASS.
- Real Windows Hello API read-only: HELLO_SUPPORTED.
- Native challenge and invalid-owner tests: 12/12 PASS. Zero PIN, signing or key enrollment.

## Release blockers
1. Actual trusted WPF Control Panel user-click and signed-challenge exchange remain unimplemented; the standalone CLI is NOT the production identity boundary.
2. No dedicated DeskMCP Windows Hello key enrolled, attested or used in a real signed challenge. RSA implementation interoperability remains untested with a genuine Windows Hello signature.
3. Windows full-trust same-user processes may be able to open/request the same credential; an arbitrary same-user process may provide a window on Desktop 2. Owner HWND/Desktop matching alone DOES NOT authenticate the Control Panel executable.
4. A real Windows Desktop 2 native Hello prompt, Desktop 1 focus noninterference, machine lock/UAC, PIN cancel and cross-tool security tests have NOT passed.
5. WPF/.NET 10 build and full integration BLOCKED by unavailable dotnet SDK.
6. User login cookies/session storage persist in profiles; blank-page reset removes tabs only.

Decision: DO NOT MERGE, DEPLOY, RESTART OR INSTALL. Keep installed DeskMCP and Desktop 1 unchanged.