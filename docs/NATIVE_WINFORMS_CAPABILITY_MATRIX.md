# Native WinForms capability matrix — candidate evidence, 2026-10-23

Status: **evidence only; NOT a production native-action implementation or permission grant**.

DeskMCP's normal Computer Use remains a general Windows MCP feature. Agent Desktop remains an optional mode with stricter foreground/input protections; no foreground or virtual-desktop switches are allowed merely to locate a control.

## What was measured

In a DWM-cloaked, non-activating, self-owned WinForms test Form on the *current* Windows virtual desktop, WinApp CLI v0.5.0 returned only window chrome/menu/system button nodes: the expected business **Edit, PushButton, and ListBox were all absent** from WinApp's full-depth-4 and Interactive-depth-8 trees (0/3).

A separate **read-only Win32 HWND inventory** enumerated four native descendants and positively matched the three exact expected child HWNDs to their owner root and PID. All three were visible and enabled according to Win32. The Edit was single-line, non-password and not readonly; the Button had a system PushButton style. No window text, clipboard, keyboard, mouse or UIA mutation was used during HWND enumeration. The subsequent ListBox state test uses **only bounded read-only LB_GETCOUNT/LB_GETCURSEL/LB_GETTOPINDEX messages**; it does not send selection/scrolling/writing messages or retrieve item text.

The Win32 evidence is *control discovery only*; an enabled/visible HWND or supported style does **not** establish safe execution, successful user-facing effect, or production authorization.

| Mode / evidence level | Native Edit | Native PushButton | Native ListBox |
|---|---|---|---|
| Current-session owned **cloaked** fixture, UIA discovery | Not seen (0/1) | Not seen (0/1) | Not seen (0/1) |
| Same fixture, native HWND **read-only** enumeration | PASS | PASS | PASS |
| Owned cloaked ListBox, native **state read** (2026-10-23) | N/A | N/A | PASS: 80 items, selected = -1/top = 0 and selected = 7/top = 12, each double-read consistent |
| Historical 2026-10-09 **Desktop2 leased, monitored** native inspect | PASS for single-line Edit | PASS for system PushButton | Not verified |
| Historical owned-fixture Desktop2 **action + app callback** | PASS: bounded WM_SETTEXT, exact TextChanged once | PASS: bounded BM_CLICK, exactly one Click event | **NOT TESTED** |
| Arbitrary third-party app / all Windows control variants | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Authorized native action on production MCP | **NOT EXPOSED** | **NOT EXPOSED** | **NOT EXPOSED** |

**Source evidence:** existing independent acceptance worktree reports `test-area/desktop2-real-acceptance/native-winforms-edit-findings-20261009.md` and `native-winforms-button-findings-20261009.md`. Raw incident/acceptance logs are deliberately *not* copied into this branch. Historical WPF direct UIA ValuePattern.SetValue stole foreground; do not replay or reinstate it.

## Read-only negative checks

The 2026-10-23 candidate-owned probe in `test-area/winforms-native-inventory/` is a standalone .NET 10 console helper. HWND verification uses read-only Win32 APIs. ListBox state is acquired through six bounded, allowlisted **query messages** (`LB_GETCOUNT`, `LB_GETCURSEL`, `LB_GETTOPINDEX`, each twice), with a 350 ms timeout per message and pre/post root/child identity checks. It requires one selection style (not multiple-selection), rejects counts outside 1–4096, invalid indices and state changes between reads. No `LB_GETTEXT`, `LB_SETCURSEL`, `LB_SETTOPINDEX`, OS input, clipboard or foreground activation. It has no runtime route in `desktop_ui_action`.

Run the disposable acceptance through:

1. Build `test-area/winforms-native-inventory/DeskMCP.WinFormsNativeInventory.csproj` using the existing local .NET SDK.
2. Build the **separate owned positive-state fixture** in `test-area/winforms-list-state-fixture/` (preselects row 7 and starts the viewport at index 12 via its own WinForms startup code; it is cloaked and nonactivating like the original fixture).
3. Run `scripts/benchmark-cloaked-winforms-uia.mjs` with the trusted WinApp executable, local dotnet executable and *either* hash-pinned fixture: `DeskMCP.Desktop2NativeEditProbe.dll` with `OWNED_CLOAKED_WINFORMS_READ_ONLY_ONCE`, or `DeskMCP.WinFormsListStateFixture.dll` with `OWNED_SELECTED_WINFORMS_READ_ONLY_ONCE`. Both variants require the exact pinned SHA-256 and expected fixture state.

The runner validates the source fixture's hash and cloak/no-activate proof, queries only owned child handles supplied by the fixture, and cleans up the owned process. The native helper further verifies root class, same PID, root ancestry, child class and bounded child enumeration; the runner validates its response is read-only (`supports_native_action=false`, `dispatch_count=0`). Five negative calls are required to fail closed for wrong PID, swapped Edit/Button roles, invalid child, **wrong ListBox handle**, and invalid sentinel. Native handles/PIDs and UI text are not included in the printed report.

**Known limitations:** Even Win32 `LB_GET*` messages execute the target process's WindowProc, so read-only semantics at the API level do not prove a malicious or custom WindowProc cannot cause side effects. Our positive-state fixture is **app-owned**, and the probes do not authorize operations on third-party controls. The live probe monitors the owned application's activation events, but not every independent foreground event in the entire user session; there is no explicit Desktop2 lease in the new read-only run. This does **not** upgrade the historical Desktop2 result to general acceptance. Do not conflate `IsWindowVisible` with actual DWM visibility. Build artifacts (`bin/`, `obj/`) are local and Git-ignored.

## Gate before any future native action route

Native WinForms editing and clicking must remain **unsupported in the general MCP API** until there is a separate authorized, lease-scoped implementation and the exact targeted control class/style, root and child PID/HWND identity, latest observation, safe desktop, expected prior state, and monitor readiness are checked **before and after** the operation. Dispatch must be one-shot, bounded, and never retry unknown outcomes. Verify actual application callback/effect, not just a Windows message acknowledgment.

For **ListBox**, the read-only count/selection/top-index path is now validated for two owned fixture states; **selection and scrolling actions remain NOT TESTED and NOT EXPOSED**.

The official [LBN_SELCHANGE documentation](https://learn.microsoft.com/en-us/windows/win32/controls/lbn-selchange) explicitly says that `LB_SETCURSEL` and other programmatic selection messages **do not send `LBN_SELCHANGE`**. Thus, a successful `LB_SETCURSEL` index readback would **not** prove the same application-level behavior as a real user's selection. The official [LB_SETTOPINDEX documentation](https://learn.microsoft.com/en-us/windows/win32/controls/lb-settopindex) says it ensures an item is visible and may stop at the maximum scroll range; the requested row is **not guaranteed** to become the exact top index. Do not assume a scrolling callback from the message return either. Finally, [SendMessageTimeoutW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw) is bounded with `SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT`, though cross-process custom control implementations may still have side effects in WindowProc.

A future action gate must demonstrate **real application-level effects/callbacks** on Desktop2 under a fresh lease and independent foreground monitor, including rejection of stale selection/top-index, wrong class/style, invalid PID and hung providers. **No selection/scroll action path should be wired into general Computer Use until those gates pass.** Never infer a successful app callback merely from a returned Windows message value. Never use global SendInput, clipboard substitution, direct UIA ValuePattern, SetForegroundWindow, SetActiveWindow, or automatic desktop switching as fallbacks.

**Release gate remains RED for generalized third-party WinForms/WPF/Electron GUI actions.** Do not merge/deploy just because the owned fixture passed.
