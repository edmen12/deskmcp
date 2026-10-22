# DeskMCP Ego Lite — Human handback privacy reset candidate
Date: 2026-10-22 MYT
Branch: review/ego-lite-session-gate-20261022
Status: CANDIDATE CODE ONLY — NO TRUSTED NATIVE HUMAN UI. DO NOT DEPLOY.

## Actual fix

- Previous handback flow had a confidentiality flaw: local.resume(session) transitioned human -> agent immediately. Existing Playwright accessibility sanitization masks password input values, but snapshots could expose OTP/email/textarea text, visible page content and screenshots. A naive handback therefore revealed the user-controlled page.
- The local port's resume now transitions human -> privacy-reset, a DENY state for BrowserRuntime agent reads/actions and the cross-tool quarantine. This is not the same as trusted human approval: the UI-to-port authorization channel remains unimplemented.
- New BrowserRuntime.completeLocalBrowserHandback (INTERNAL ONLY, never an MCP tool) holds the runtime mutation/session gate, asserts fresh Agent Desktop lease/HUD and browser-process liveness, creates a new browser-default blank page, closes ALL old pages, rechecks that exactly one about:blank remains, revokes observations again and only then uses a separate BrowserHandoffRuntimePort to re-enable Agent access.
- The Browser URL navigation policy remains HTTP(S)-only. The blank page is created by newPage/default about:blank; no general special-scheme navigation permission was added.
- If page cleanup fails, late popups appear, native lease checks fail or process liveness cannot be proven, agent access is revoked. No automatic retry/replay. Previous page observations are never valid after the gate.
- All existing Revoke/Retire lifecycle constraints remain in effect. If a reset fails, old browser session cleanup is the candidate recovery path.

## Evidence

- Browser tests: 86/86 PASS, including positive privacy-reset and three new negative cases for unclosable private tabs, popup race and missing internal completion authority.
- Fast suite: 153/153 PASS.
- Real Microsoft Edge Chromium (isolated headless temporary profile, simulated Agent Desktop lease): 12/12 scoped checks PASS. New checks demonstrate snapshots denied during privacy-reset and old real tabs closed before a new blank page can be read.
- Edge test process count 0, test profile directory removed.
- npm run build / TypeScript PASS.
- No real visible desktop was focused or switched; no user credentials were used. Real Edge checks are NOT a Windows Desktop 2 takeover test.

## Remaining release blockers (RED)

1. Native human presence: Control Panel/HUD currently has Exit Agent Control but does not authenticate acceptance or handback. Local port access alone is not a physical user gesture; ordinary same-user IPC and UIA automation are spoofable.
2. The browser context retains cookies/storage and browser profile across a blank-tab reset. This preserves login state by design, but it is NOT isolation of authenticated websites or proof against arbitrary same-user processes. Threat model must include whether the Agent may visit high-risk authenticated websites after handback.
3. No user-visible warning/consent for the fact that page cleanup closes ALL existing tabs. The WPF HUD/Control Panel must show this consequence before handback.
4. No native Windows Desktop 2 + foreground zero-interference + Windows Hello or brokered actual-presence attestation verification.
5. In-process runtime completion authority is a privileged object capability; wiring it incorrectly into MCP/HTTP would bypass the page scrub guarantee. Never register it as a remote tool.
6. Full Windows .NET Integration remains BLOCKED by missing dotnet.exe; this was not modified or installed.
7. Session-level URL/body/console events, persisted profile data and existing screenshots are not general-purpose secrets DLP. No general guarantee of preventing cross-tool access outside the Gateway process.

Conclusion: verified safer handback protocol candidate. Actual native Human Takeover is NOT implemented, cannot be claimed production-ready, must not merge/deploy.
