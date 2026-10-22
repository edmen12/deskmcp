# DeskMCP — Parent-bound Windows Hello broker & release identity gate
Review date: 2026-10-22 (MYT). Branch: review/ego-lite-session-gate-20261022.
STATUS: CANDIDATE / NOT WPF-INTEGRATED / RELEASE RED. No production updates.

## Actual implementation
- test-area/ego-windows-hello-review.h: native reviewer now rejects the owner HWND unless it is a real visible top-level window belonging to the *direct Windows parent process* that launched the helper. It verifies the parent PID via Windows Toolhelp32 process enumeration, process creation order, Windows session, and QueryFullProcessImageNameW canonical path.
- The parent executable name must be DeskMCP.exe, installed beside the native helper. Parent matching is run before any review dialog or Windows Hello request.
- This is defense-in-depth only. Same-user process injection/parent spoofing, user-writable installation files, and unsigned components remain outside an OS-backed identity boundary.
- test-area/test-ego-windows-hello-probe.py checks malformed challenges, invalid owners, and an actual system-owned desktop HWND (read-only). No HWND is clicked, changed or activated.
- test-area/verify-ego-human-release-identity.ps1 adds a separate read-only release gate: Panel and native helper must have valid Authenticode signatures, the same pinned publisher cert thumbprint, and share one installation directory.
- The release gate is not invoked by the current native runtime. Its enforcement in a signed installer/release pipeline is required; simply shipping the source file does not enforce it.

## Verified
- MSVC C++/WinRT reviewer build PASS (no new SDK/install).
- Native safety tests 13/13 PASS including rejecting real system desktop HWND. No PIN prompt, key creation or signing.
- Real installed DeskMCP.exe reported Get-AuthenticodeSignature Status=NotSigned. The release gate correctly returns RELEASE_IDENTITY_BLOCKED on a disposable temporary copy, which was deleted.
- Fast tests 166/166 PASS.
- Browser tests 87/87 PASS.
- Isolated Microsoft Edge agent-only+synthetic-local-handoff regression 12/12 PASS, no remaining test browsers or profile directories.

## RED / must be resolved before merging
1. Trusted WPF Control Panel does not yet spawn the Hello reviewer from an explicit user-initiated approval nor securely exchange the challenge/signature with Gateway. Existing HUD Exit Agent Control is a separate action.
2. The installed DeskMCP.exe is currently NOT SIGNED. The native signed-publisher check lives only in the offline release gate. Runtime binary integrity/publisher enforcement and tamper-resistant packaging require independent review.
3. Even signed binaries under the user's writable directory do not form an absolute security boundary against same-user arbitrary code. Trusted enrollment, signer identity, secure per-user process isolation and UI ownership threat model remain open.
4. Windows Hello key DeskMCP.BrowserHuman.v1 not enrolled. No real PIN/biometric signing test; no proof that software verifier interoperates with genuine Hello signature.
5. Real Desktop 2 GUI/HUD presence, Desktop 1 foreground non-interference, UAC, lock-screen, active sessions and failure recovery are not end-to-end validated.
6. Full WPF/.NET10 build and integration remain blocked by absent dotnet SDK.

Sources: https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ivirtualdesktopmanager-getwindowdesktopid ; https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello
Decision: DO NOT MERGE, INSTALL, PUSH, RESTART, OR CLAIM PRODUCTION READY.