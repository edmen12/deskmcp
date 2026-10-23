# Native WinForms capability matrix — candidate evidence, 2026-10-23

Status: **evidence only; NOT a production native-action implementation or permission grant**.

DeskMCP's normal Computer Use remains a general Windows MCP feature. Agent Desktop remains an optional mode with stricter foreground/input protections; no foreground or virtual-desktop switches are allowed merely to locate a control.

## What was measured

In a DWM-cloaked, non-activating, self-owned WinForms test Form on the *current* Windows virtual desktop, WinApp CLI v0.5.0 returned only window chrome/menu/system button nodes: the expected business **Edit, PushButton, and ListBox were all absent** from WinApp's full-depth-4 and Interactive-depth-8 trees (0/3).

A separate **read-only Win32 HWND inventory** enumerated four native descendants and positively matched the three exact expected child HWNDs to their owner root and PID. All three were visible and enabled according to Win32. The Edit was single-line, non-password and not readonly; the Button had a system PushButton style. No window text, clipboard, keyboard, mouse, UIA mutation or SendMessage API was accessed.

The Win32 evidence is *control discovery only*; an enabled/visible HWND or supported style does **not** establish safe execution, successful user-facing effect, or production authorization.

| Mode / evidence level | Native Edit | Native PushButton | Native ListBox |
|---|---|---|---|
| Current-session owned **cloaked** fixture, UIA discovery | Not seen (0/1) | Not seen (0/1) | Not seen (0/1) |
| Same fixture, native HWND **read-only** enumeration | PASS | PASS | PASS |
| Historical 2026-10-09 **Desktop2 leased, monitored** native inspect | PASS for single-line Edit | PASS for system PushButton | Not verified |
| Historical owned-fixture Desktop2 **action + app callback** | PASS: bounded WM_SETTEXT, exact TextChanged once | PASS: bounded BM_CLICK, exactly one Click event | **NOT TESTED** |
| Arbitrary third-party app / all Windows control variants | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Authorized native action on production MCP | **NOT EXPOSED** | **NOT EXPOSED** | **NOT EXPOSED** |

**Source evidence:** existing independent acceptance worktree reports `test-area/desktop2-real-acceptance/native-winforms-edit-findings-20261009.md` and `native-winforms-button-findings-20261009.md`. Raw incident/acceptance logs are deliberately *not* copied into this branch. Historical WPF direct UIA ValuePattern.SetValue stole foreground; do not replay or reinstate it.

## Read-only negative checks

The 2026-10-23 candidate-owned probe in `test-area/winforms-native-inventory/` is a standalone .NET 10 console helper with Win32 **read-only** calls. It has no runtime route in `desktop_ui_action`.

Run the disposable acceptance through:

1. Build `test-area/winforms-native-inventory/DeskMCP.WinFormsNativeInventory.csproj` using the existing local .NET SDK.
2. Run `scripts/benchmark-cloaked-winforms-uia.mjs` with the trusted WinApp executable, the hash-pinned `DeskMCP.Desktop2NativeEditProbe.dll`, the local dotnet executable, and the exact `OWNED_CLOAKED_WINFORMS_READ_ONLY_ONCE` sentinel.

The runner validates the source fixture's hash and cloak/no-activate proof, queries only owned child handles supplied by the fixture, and cleans up the owned process. The native helper further verifies root class, same PID, root ancestry, child class and bounded child enumeration; the runner validates its response is read-only (`supports_native_action=false`, `dispatch_count=0`). Negative calls are required to fail closed for wrong PID, swapped control roles, invalid child and invalid sentinel. Native handles/PIDs and UI text are not included in the printed report.

**Known limitations:** The live probe monitors the owned application's activation events, but not every independent foreground event in the entire user session; there is no explicit Desktop2 lease in the new read-only run. This does **not** upgrade the historical Desktop2 result to general acceptance. Do not conflate `IsWindowVisible` with actual DWM visibility. Build artifacts (`bin/`, `obj/`) are local and Git-ignored.

## Gate before any future native action route

Native WinForms editing and clicking must remain **unsupported in the general MCP API** until there is a separate authorized, lease-scoped implementation and the exact targeted control class/style, root and child PID/HWND identity, latest observation, safe desktop, expected prior state, and monitor readiness are checked **before and after** the operation. Dispatch must be one-shot, bounded, and never retry unknown outcomes. Verify actual application callback/effect, not just a Windows message acknowledgment.

For **ListBox**, no native action is allowed based on this read-only discovery: first implement and test a non-mutating selection/top-index read path, then decide whether any action can be validated without foreground theft. Never use global SendInput, clipboard substitution, direct UIA ValuePattern, SetForegroundWindow, SetActiveWindow, or automatic desktop switching as fallbacks.

**Release gate remains RED for generalized third-party WinForms/WPF/Electron GUI actions.** Do not merge/deploy just because the owned fixture passed.
