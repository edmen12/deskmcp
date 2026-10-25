# DeskMCP — Windows Hello signed browser handoff candidate (2026-10-22)

Status: CANDIDATE SOURCE / CRYPTO TEST VERIFIED / NATIVE WINDOWS HELLO NOT WIRED / RELEASE RED.
Branch: review/ego-lite-session-gate-20261022
No merge, push, installation, restart, production or desktop switching.

## Source changes

- src/browser-human-proof.ts introduces a challenge verifier with a pinned RSA 2048+ public key. Each random one-time challenge binds the browser Session UUID, Agent Desktop lease UUID, operation ('accept' or 'resume'), ownership epoch, unique 128-bit nonce and an expiry (60 seconds). A failed verification consumes its nonce. Any state transition or revocation cancels pending challenges.
- src/browser-handoff-boundary.ts no longer accepts a simple local.accept(sessionId) or local.resume(sessionId) to unlock controls. A scoped signed response is mandatory. Non-browser MCP and BrowserRuntime ownership gates remain unchanged.
- src/browser-human-consent-coordinator.ts checks the live lease and state, sends an opaque challenge to an injected OS-brokered signer, rechecks the live lease when the signer returns, then attempts the cryptographically verified local transition.
- The older Browser/HTTP tests and the real Edge regression explicitly inject a synthetic test-only proof adapter. They continue validating lifecycle and privacy behavior, NOT physical user presence. Production has no native signer or public-key enrollment wiring.

## Source / test evidence

- Browser tests: 86/86 PASS.
- Fast suite: 165/165 PASS including 8 software-key RSA challenge signature tests and 4 synthetic native-signing coordinator tests.
- Real isolated Chromium Edge regression: 12/12 PASS; test-owned processes and profiles cleaned. Synthetic lease and local signing are explicitly labelled; no actual user-account login.
- Short actual Desktop 2 lease: status initially free. Started a desktop_number=2 lease, returned hud_ready=true and hud_visible=false, then stopped it successfully; pool returned to free. This does NOT prove HUD visibility or Desktop 1 non-switch.
- Native host current-desktop probe once reported desktopNumber=1 (zero-based) with desktopCount=2; it was NOT possible to complete a verified before/after switching probe. Avoid claiming which desktop the human was seeing at that instant.
- Full WPF/.NET integration cannot run because dotnet SDK was not found at the standard machine paths. No SDK installation attempted.

## Critical trust requirements

1. Do not allow ordinary UIA, WPF Click, named pipe text, an unverified 'Verified' Boolean, or an MCP caller to count as human approval.
2. On Windows, Microsoft recommends an OS-brokered Windows Hello credential signature via Windows.Security.Credentials.KeyCredential.RequestSignAsync for challenge/response. The user may need PIN/biometrics; the private key remains Windows-held. For desktop UserConsentVerifier prompts, use the window-bound UserConsentVerifierInterop.RequestVerificationForWindowAsync rather than UWP RequestVerificationAsync.
3. Native WPF code must bind the system consent UI to an explicit user-opened visible review window. It must not autonomously switch virtual desktops, steal Desktop 1 focus or remotely open the Windows Hello prompt. The actual HWND and desktop ownership must be verified.
4. Registration of the Windows Hello public key requires a separate trusted local enrollment and ideally key attestation. Arbitrary MCP or same-user IPC must never be able to replace the pinned public key. An RSA signature ALONE cannot prove hardware-backed presence if a software key is enrolled.
5. A secure local coordination channel must provide the signed proof without leaking local signer capability or private key to MCP. The signature verifier is the actual authority; ordinary local IPC connectivity is not. The candidate has no native bridge yet.
6. After native consent is returned, verify the lease and epoch again. For handback, run the existing 'privacy-reset' flow and close all old tabs before Agent can read. Cookies/storage persist in the browser profile and must be covered by a product privacy policy.
7. Release requires Windows Hello real user-interaction and cancellation trials, machine lock/UAC, HUD disappearance, revocation races, OS Desktop 1 no-focus tests and completed WPF build/integration suite.

## Sources for the native bridge design

- https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello
- https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredential.requestsignasync
- https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier

Next actual release-blocking step: implement and compile a WPF Windows Hello key enrollment/signing channel and a trusted user-initiated HUD flow; do not enable or distribute Human Takeover until that mechanism is verified with the real hardware/user.

## Native C++/WinRT experiment — verified, without .NET SDK

- Source: test-area/ego-windows-hello-broker.cpp. Repeatable build: test-area/build-ego-windows-hello-broker.cmd. Built with installed Visual Studio 2022 C++ Build Tools and Windows SDK 10.0.26100; compiler exit code 0.
- Output only in ignored runtime/ego-windows-hello-probe.exe; no installation, production wiring or external publication.
- Real Windows KeyCredentialManager.IsSupportedAsync() --check returned HELLO_SUPPORTED, exit code 0; no PIN prompt and no credential creation.
- Read-only --public returned "credential is not provisioned", exit code 6 for DeskMCP.BrowserHuman.v1. No Windows Hello private key was created.
- --sign code compiles and uses KeyCredential.RequestSignAsync with stdin challenge, but was NOT invoked. Real user verification, signature verification interoperability and PIN cancellation remain untested.
- The native program explicitly requests X509 SubjectPublicKeyInfo DER; the Gateway now accepts a trusted, pinned DER SPKI public key and synthetic RSA signature tests pass.
- The probe binary is NOT the trusted WPF Control Panel. The app-scoped Windows Hello key, key enrollment, native user-initiated UI, and protected proof exchange have not been implemented.
- The short Desktop 2 lease had hud_ready=true but hud_visible=false; stop restored free status. The post-start desktop-number probe was blocked, so there is NO verified Desktop 1 non-switch guarantee in this turn.
