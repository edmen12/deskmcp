# Windows Computer Use

DeskMCP Windows Computer Use is a local, policy-gated UI automation layer for agents. The remote MCP surface belongs to DeskMCP; Microsoft WinApp CLI is a pinned, replaceable Windows backend rather than the public protocol.

## Tool flow

Use the tools in this order:

1. `desktop_ui_windows` — discover visible app windows and receive opaque `window_id` capabilities.
2. `desktop_ui_snapshot` — inspect a window and receive a fresh `computer_observation_id`; optionally request a PNG screenshot.
3. `desktop_ui_action` — perform exactly one action using that fresh observation.
4. Re-observe before the next action. A successful or partially attempted action invalidates sibling observations for the same window; physical/global input also invalidates observations for other windows because it can change global desktop state.

The intended loop is **observe → act once → observe again**. Do not cache selectors or UI state across unrelated changes.

## UI Automation first

Prefer semantic actions when the target supports them:

- `invoke` for buttons and invokable controls.
- `set_value` for editable values.
- `click`, `hover`, `scroll`, `send_keys`, and `drag` only when semantic UI Automation is insufficient.

Snapshots default to the interactive UI Automation tree without a screenshot. Request `include_screenshot=true` only when visual context is needed. This reduces image bandwidth, model tokens, focus changes, and coordinate mistakes.

### UI tree coverage and action outcomes

`desktop_ui_snapshot` exposes `semantic_tree_truncated` when DeskMCP's `max_elements` projection actually omits a node from the tree returned by WinApp. The scope is `winapp_depth_and_filter_limited`: even `semantic_tree_truncated=false` does **not** mean the application has no deeper or inaccessible controls. A warning is returned when the projection is clipped; missing controls are not proof of absence.

`desktop_ui_action` preserves legacy `succeeded=true` for a successfully completed backend call, and additionally returns `action_dispatched`, `outcome_verified=false`, `outcome_status=unverified`, and `post_action_state`. A window closing or a new screenshot is **not** proof that a Save, Submit, or navigation finished. Explicitly inspect the resulting application state. If post-action observation fails, the action may already have happened; never blindly replay non-idempotent actions.

### Condition waits and diff snapshots (candidate)

`desktop_ui_action(action="wait_for", selector=...)` checks an **exact** selector for `present`, `enabled`, or `value_equals` with `expected_value`. `wait_ms` is bounded to 10 seconds and `poll_ms` to 100–1000 ms. Each poll revalidates the window identity and an active Agent Desktop lease if present. It sends no physical mouse/keyboard input. A timeout returns `succeeded=false`, `condition_met=false`, and `outcome_status=timeout_inconclusive`; it does not prove an element is absent. In candidate `wait_scan_mode=auto` (default), the first poll uses fast Interactive UIA and, if the selector is missing or the tree is truncated, falls back to the fuller depth-5 scan; subsequent polls stay in full mode. `interactive` and `full` can also be selected explicitly. A known-truncated tree cannot establish selector uniqueness and therefore cannot verify a satisfied condition. A satisfied UIA condition proves only that observed predicate, not an application-level business transaction.

`desktop_ui_snapshot(diff_from_observation_id=..., diff_only=true)` returns `ui_diff` (added/removed/changed/unchanged) rather than the full `elements` array, plus a fresh action-capable observation ID. Capture an initial full snapshot first. The baseline is held in a bounded 128-entry, 120-second memory cache, even after its action capability is consumed; it is matched against the **same window, same Agent Desktop lease, same max_elements, and same interactive_only** setting. A diff baseline never grants an action capability. Unique selectors are compared by identity; ambiguous selectors fall back to array position. Reordering and WinApp depth/filter limits can produce incomplete or approximate differences: `scope_complete=false` is always explicit. Screenshot images, when requested, are not diffed.

`wait_for` now acquires the shared coordinator for its initial observation/lease preflight and for **each individual** identity-checked UIA scan. Polling delays run outside the lock, allowing other agents to inspect or modify UI between scans. A fresh `computer_observation_id` is still required before any later action. The 10-second budget bounds polling decisions, but one in-flight WinApp inspect can exceed that elapsed limit due to backend timeout; it is not a hard deadline.

### Target identity guard and UIA coverage (candidate)

Each tree snapshot now includes `selector_coverage`: returned element count, selected elements, unique-selector count, ambiguous-selector elements, whether the returned tree is empty, and `scope_complete=false`. A zero-element response explicitly warns that WinApp's depth/filter/provider may have hidden controls. This is evidence about the **returned tree**, not about every element in the application.

For critical actions such as Save or Submit, pass `target_guard` on `desktop_ui_action`, for example `{ "type": "Button", "automation_id": "SaveAction", "require_enabled": true }` together with the exact `selector` observed in the prior snapshot. Before any input/Invoke, DeskMCP performs another bounded UIA inspection (up to 200 projected elements, `target_guard.scan_mode=full` by default; `interactive` is an explicit faster but potentially incomplete option), checks that the selector occurs **exactly once** and matches all supplied identity fields, and then revalidates the window capability and any Agent Desktop lease. A known-truncated tree, missing, ambiguous, disabled or changed control is rejected without dispatch. The guard is optional and requires at least one identity field (`type`, `name`, `automation_id` or `class_name`); it is intentionally unavailable for coordinate-only actions. Guard scans introduce additional latency and cannot eliminate application changes in the short interval between verification and dispatch (TOCTOU).

Normal user desktop actions keep their existing input options and policy checks. Only a valid Agent Desktop lease applies the separate isolated-desktop action restrictions.

WinForms child controls can disappear from UI Automation both when isolated on a non-current virtual desktop **and** on a normal desktop when the window is DWM-cloaked. If a known WinForms root exposes no WinForms child classes, `desktop_ui_snapshot` returns `semantic_tree_status: "limited"` and a mode-appropriate `semantic_tree_warning`, even when WinApp reported a successful scan with TitleBar/Menu/System Button elements. This is a *conservative visibility warning*, not an assertion that a form has missing business controls in every case. DeskMCP does not uncloak, foreground, or move a window to Desktop 1 to recover the tree. UIA actions for omitted controls will not be guessed or implicitly redirected to native window messages.

## Observation safety

`desktop_ui_snapshot` returns a short-lived opaque `computer_observation_id`.

- Observation TTL: 30 seconds.
- Observations are one-time capabilities.
- An observation is bound to one opaque `window_id`.
- The first action on a window advances its state generation and invalidates sibling observations created from the old state.
- Physical/global mouse or keyboard input also advances the global input generation and invalidates observations for other windows, because injected input can change shared desktop state outside the nominal target.
- Window capabilities are validated against the live HWND, process ID, process name, and window class internally. These native identifiers are not part of the public window capability.
- All GUI operations share one Gateway-process coordinator, so multiple MCP clients cannot concurrently mutate the desktop.

This prevents two agents from observing the same button and both acting later after one of them has already changed the UI.

## Permission profiles

Computer Use is discoverable in the stable MCP schema but executable only in:

- **Full Control** — session-only; normal Windows integrity/UAC boundaries remain enforced.
- **Fully Unlocked** — session-only; additionally permits explicitly requested system-wide key injection.

Read-only and Workspace Write reject Computer Use calls locally.

Remote MCP callers cannot select WinApp's `post-message` keyboard transport because it can cross Windows integrity levels. Normal injected keyboard input uses Windows `send-input`, and system-wide keys require Fully Unlocked. Agent Desktop background mode is the exception: after validating the active lease and target window, DeskMCP may internally select restricted window-targeted keyboard delivery so the agent does not steal the user's foreground desktop. That internal transport is not a remote caller-selectable capability.

## UAC, lock screen, and Secure Desktop

DeskMCP Computer Use does not bypass:

- Windows ACLs.
- User Account Control.
- UAC Secure Desktop.
- The Windows lock screen.
- Host-session isolation.

If Windows switches to Secure Desktop for UAC, normal desktop UI automation must fail rather than attempt to synthesize consent. Administrator process elevation continues to use DeskMCP's separate ProcessHost/UAC flow.

## Native WinForms control evidence gate (2026-10-23)

See [NATIVE_WINFORMS_CAPABILITY_MATRIX.md](NATIVE_WINFORMS_CAPABILITY_MATRIX.md) for the controlled Edit, PushButton and ListBox evidence matrix. A new source-only, bounded Win32 inventory helper in `test-area/winforms-native-inventory/` confirmed native child ownership, class/style and read-only discoverability for the three controls in the **same owned DWM-cloaked fixture** where WinApp's UIA returned 0/3. Four adversarial reads (wrong process, swapped child roles, missing child capability, wrong sentinel) all failed closed. The native helper now uses only allowlisted bounded `LB_GETCOUNT`, `LB_GETCURSEL` and `LB_GETTOPINDEX` query messages to read ListBox state twice. Two hash-pinned owned fixture variants verified 80 items with (selected=-1, top=0) and (selected=7, top=12), respectively; no item text or mutating messages were sent. The native helper reports `supports_native_action=false` and `dispatch_count=0` (zero **mutating** dispatches); it does not register a production MCP action. Historical one-fixture Edit WM_SETTEXT and Button BM_CLICK app-callback PASS do not establish a general privilege. Selection and scroll actions remain untested; Microsoft documents that `LB_SETCURSEL` does not notify the parent with `LBN_SELCHANGE`, so selection readback would not establish application callback success.

## Controlled WinForms provider benchmark (2026-10-23; read-only candidate)

Reused the hash-pinned existing `DeskMCP.Desktop2NativeEditProbe.dll` under `test-area/desktop2-native-edit-probe/` of the independent acceptance worktree. The source fixture has its WinForms root marked `WS_EX_NOACTIVATE` during HWND creation and DWM-cloaks itself before Show. We never supplied its uncloak sentinel, moved it to virtual Desktop2, or sent any input. Run `node scripts/benchmark-cloaked-winforms-uia.mjs <absolute-winapp-exe> <absolute-owned-native-edit-fixture-dll> <absolute-dotnet-exe> OWNED_CLOAKED_WINFORMS_READ_ONLY_ONCE`. The runner checks the trusted fixture DLL SHA-256 and source executable basenames, bounds all child commands, suppresses native handles/names/window metadata, and terminates its owned fixture.

Three six-scan-per-mode repetitions reproduced the same provider effect: a depth-4 scan returned 7 elements with `Window`, `TitleBar`, `MenuBar`, `MenuItem` and three system `Button` nodes. Interactive-depth-8 returned 4 window chrome/menu/system-button nodes. **0/3 fixture-owned controls** (`OwnedSingleLineEdit`, `OwnedNativePushButton`, `OwnedScrollableList`) were exposed by exact Automation ID, despite every WinApp command succeeding. The full tree included an actual `WindowsForms10.*` root class, not a different application type. The third run had P50/P95 of 69.7/90.8ms in depth-4, and 68.1/69.5ms in Interactive mode. No fixture activation/focus messages were observed during runs.

Contrast with the same-day cloaked WPF fixture: `5/5` expected controls on depth-4 and `4/5` on Interactive. **UIA success is not control-discovery success.** Caveats: a cloaked WinForms test app on the current desktop is not an ordinary non-cloaked third-party WinForms window, and none of these read-only results authorize untested UIA ValuePattern edits, blind HWND message fallback or Desktop2 control. Independently observed transient foreground effects outside the owned fixture were not instrumented in this probe.

Current evidence-based matrix:

| UI/control case | Observed | General release implication |
|---|---|---|
| Owned cloaked WPF, read-only UIA | 5/5 full; 4/5 interactive | Auto full-scan fallback useful; input safety not established |
| Owned cloaked WinForms, read-only UIA | 0/3 app controls, chrome-only despite successful WinApp commands | Return provider-visibility warning; **do not guess missing selectors** |
| Owned WinForms native Edit, protected Desktop2 | Historical limited `WM_SETTEXT` app-callback PASS with no observed Desktop1 disturbance in its own fixture | Candidate per-control backend only; not a general WinForms/Electron capability |
| WPF direct UIA `ValuePattern.SetValue` on Desktop2 | Historical foreground theft confirmed | Quarantined; no automatic UIA mutation fallback |
| Third-party WinForms, WPF, Electron, WinUI | Not covered by this controlled fixture round | Remains open, needs independent no-foreground-theft and app-effect evidence |

## Controlled WPF provider benchmark (2026-10-23; read-only candidate)

A hash-pinned existing `DeskMCP.Desktop2WpfProbe.dll` was launched as an **owned non-activating, DWM-cloaked fixture**, with no uncloak file, UIA write, input injection, or desktop switch request. Run `node scripts/benchmark-cloaked-wpf-uia.mjs <absolute-winapp-exe> <absolute-owned-fixture-dll> <absolute-dotnet-exe> OWNED_CLOAKED_WPF_READ_ONLY_ONCE` only with the exact disposable owned fixture already checked by SHA-256. The fixture is terminated and its temporary files removed at the end.

On the second six-scan sample per mode: depth-4 full tree returned 62 nodes, **5/5** named fixture Automation IDs with unique selector mapping, P50=263.6ms / nearest-rank P95=289.9ms; Interactive depth-8 returned 12 nodes, **4/5** known controls, P50=203.9ms / P95=216.6ms. The omitted known fixture control was `WpfScroller`. Selector collisions=0 and all present known locators remained stable within the six runs. The owned probe's root activation/foreground event count was 0. The first six-scan sample was slower, confirming environmental variance. These are **not** statistically robust P95s, generalized third-party-app claims, full control-command accuracy, or proof that no other process gained foreground transiently. A cloaked fixture on the current Windows desktop is also **not** the same as a leased Agent Desktop/virtual Desktop2 acceptance.

Practical implication: `desktop_ui_snapshot(interactive_only=false)` remains important when fast Interactive reads fail to expose a real control. Guarded actions default to the full tree; cooperative waits use Interactive first and fall back to full. Both preserve existing window/lease checks. UIA provider filtering, depth and visibility remain outside DeskMCP's guarantees.

## Backend startup measurement (2026-10-23; local read-only sample)

Run `node scripts/benchmark-winapp-startup.mjs <trusted-absolute-winapp-exe-path>` to time six separate CLI launches for each of `--help` and `ui list-windows --json`, without printing any window metadata. A local installed WinApp CLI v0.5.0 sample yielded 6/6 successful calls in each case, with medians of about 54.7ms for help and 55.7ms for read-only window enumeration. These numbers do **not** include a complex UIA tree scan, network round-trips, or a persistent worker baseline. Persistent UIA worker adoption remains proposed pending isolated benchmarks showing meaningful latency benefits after accounting for COM lifecycle, recovery, memory, and Agent Desktop isolation.

### Read-only WinApp inspect probe (2026-10-23)

Run `node scripts/benchmark-winapp-inspect.mjs <trusted-absolute-winapp-exe-path>` to enumerate but only inspect Windows-owned Explorer `ApplicationFrameWindow` targets; it does not emit titles, control labels, selector strings, HWNDs or PIDs. It performs no click, screenshot, text input or foreground request. One available local shell frame returned 1 element in a depth-4 tree (95.8ms) and zero elements in an interactive-depth-8 tree (69.9ms). **This is a limited provider-visibility sample, not a complex third-party app benchmark or a no-focus-steal acceptance test.** The tool deliberately marks empty or ambiguous selector coverage and allows opt-in identity verification instead of guessing. More complex application UIA benchmarking requires a controlled, non-disruptive fixture with verified window ownership.

## Backend and packaging

Windows releases pin Microsoft WinApp CLI **v0.5.0** from its official GitHub Release assets.

Release staging verifies:

- Upstream x64/ARM64 archive SHA-256.
- `winapp.exe` PE architecture.
- `libSkiaSharp.dll` PE architecture.
- Extracted-file SHA-256 values.
- Version marker and upstream archive provenance.
- MIT license preservation.

The installed payload stores the backend under `gateway/winapp/`. Critical backend files and provenance markers are included in `install-integrity.sha256`.

DeskMCP also sets `WINAPP_CLI_TELEMETRY_OPTOUT=1` for backend processes.

## Action result privacy

DeskMCP does not forward the backend's raw action response to the remote client. The public action result contains DeskMCP-owned status plus the requested post-action observation. This prevents native backend implementation details from becoming part of the public API or leaking native window/process identifiers accidentally.

Screenshots are captured to a temporary PNG path, read into the MCP response, and removed immediately after capture. Audit logging is metadata-only and does not record screenshot pixels, file contents, terminal I/O, API keys, or native process/window identifiers.

## Current scope

This P0 implementation targets Windows x64 and Windows ARM64. It is selector/UIA-first rather than OCR-first. Visual/OCR fallback and reusable recorded workflows can be added later behind the same DeskMCP tool contract without changing the safety model above.
