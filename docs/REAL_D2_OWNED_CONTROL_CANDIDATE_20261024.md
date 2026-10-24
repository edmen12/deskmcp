# Real Windows virtual Desktop 2 — owned-control MCP candidate

2026-10-24 · `feat/real-d2-owned-mcp-20261024` · **SOURCE-ONLY, NOT INSTALLED**

## Verified result

- The real installed DeskMCP `c2ad782` HUD allocated a native Desktop 2 lease for the test. No installed code/configuration was replaced or restarted.
- An isolated source candidate composed the existing `Desktop2WindowInventory`, `Desktop2ObserverLifecycle`, `Desktop2DirectUiaLeaseCoordinator`, and `Desktop2ComputerUseSession` through `composeRealDesktop2OwnedControl`.
- Its strict test launcher started one hash-checked, **self-owned WinForms fixture** in DWM-cloaked/nonactivating state, then moved only that owned HWND to the actual Win+Tab virtual Desktop 2, verified VDA ownership, and uncloaked it.
- The new bridge completed **Edit → one real TextChanged callback; Button → one real Click callback; ListBox → app-observed TopIndex=20**, without OS clipboard or global mouse/keyboard calls.
- The independent foreground/VDA observer was armed before app launch and remained active until the fixture exited. Native GUI exited, watcher exited, lease remained valid through teardown, and owner stayed on Desktop 1. After the test returned exit 0, the caller explicitly stopped the lease; Desktop 2 returned to Free.
- Evidence: `test-area/desktop2-real-acceptance/runs/native-owned-bridge-2026-10-24T07-56-06-383Z/result.json`; self-owned binary SHA256 `f6d064ad5d42b20d168423f678cc45241d22029b8d88c529a9349bc5e0dc2d03`.
- Source-only Desktop2-focused suite: **136/136 PASS**; full fast suite: **273/273 PASS**. The 11 new bridge/MCP contract tests include lease/policy denial, process identity checks, opaque IDs and nonreplayable native permits. Full `npm run build` also PASS.

## What the candidate adds

- `src/desktop2-real-owned-control.ts`: a persistent, single-session, ownership-attested real-D2 facade with guarded start/list/snapshot/perform/stop. No title/PID/HWND can be supplied as an authorization shortcut. A trusted launch attestor is required, with the default implementation refusing every target.
- `src/desktop2-real-owned-compose.ts`: composes existing real VDA/observer/native adapters under independent capability registries, so legacy Win32 Object tokens do not cross into the real virtual Desktop 2.
- `src/desktop2-real-owned-mcp-tools.ts`: five *candidate MCP endpoint definitions* (start, windows, snapshot, action, stop). Public window/control IDs are opaque, action permit is single-use, native metadata stays internal. `set_native_edit`, `click_native_button`, `scroll_native_list` are the only supported native action shapes; these are not universal mouse/keyboard gestures.
- `src/mcp-server.ts`: registration requires **BOTH** `DESKTOP_MCP_REAL_D2_OWNED_ACTION_EXPERIMENT=1` AND an internally supplied `realD2Owned` instance with an independent owned-launch verifier. The standard `src/index.ts` supplies neither; an environment variable alone is insufficient. Thus the installed/public Gateway has **ZERO new action tools**.
- Any native dispatch receipt remains `app_event_verified=false` and `business_outcome_verified=false`. Only the external *owned application event log* can promote the specific test run to a callback-verified result.

## Explicit RED gates

- No ordinary third-party window or user-owned app can be declared safe solely from its process name, PID, desktop GUID, or visible title.
- No direct UIA `ValuePattern.SetValue` (previously observed to steal Desktop 1 focus), global SendInput, clipboard sharing, broad click/drag or auto-switch-and-return fallback.
- Not verified: signed/sandboxed third-party launch attestation, cross-app WinUI/WPF/Electron callbacks, physical HUD Exit, independent full-session foreground attribution on every desktop/display, hours-long lease stress, multi-monitor use, automatic recovery, and staged cutover/rollback for a production action tool.
- No generic `desktop_ui_action` authorization, permission widening, release tag, installation, merge or push.

## Controlled next release gate

Before **any** production MCP action registration, implement a trusted, hash-pinned, Job-owned, strictly non-activating launcher/attestor integrated into the running Gateway. This must arm an independent tripwire before process creation, bind HWND/PID/start-time/lease generation to an opaque capability, verify app callback/state after each accepted action, enforce denial on unknown outcomes, and prove clean teardown and foreground noninterference with multiple third-party application classes. Keep all production mutation endpoints disabled until that acceptance is independently reproduced.
