# 2026-10-09 MYT — real Desktop2 native WinForms PushButton acceptance

**Owned test fixture subset PASS. Overall production Computer Use remains RED.**

## Verified conditions
Real Windows virtual Desktop1 remains reserved for the owner; temporary HUD-backed Desktop2 lease used for a candidate-owned WinForms Form. Its root has WS_EX_NOACTIVATE from CreateParams, DWM cloak before first Show, placement to Desktop2 by native VDA, then deliberate uncloak. A passive foreground WinEvent + VDA notification observer watches the exact target HWND/PID; tripwire prevents subsequent actions. No global SendInput, foreground activation, OS clipboard, VM, or switching of the owner's virtual desktop.

Native implementation: test-area/desktop2-direct-uia/DirectUia.NativeButton.cs. Only real Button / WindowsForms10.Button child HWNDs with BS_PUSHBUTTON or BS_DEFPUSHBUTTON style, owning root/process match, enabled/visible, guarded observer, bounded SendMessageTimeout BM_CLICK. One-use semantic capability is separately issued from snapshotNativeButtons via Computer Use candidate and session.

## Real runs

| Local MYT time | Stage | Result |
| --- | --- | --- |
| ~16:19 | First button-inspect with default WinForms style | DENIED: Button class existed but style not whitelisted. No app input, focus change or virtual-desktop switch. |
| ~16:22 | button-inspect with FlatStyle.System | PASS: one native-button child capability, 0 app clicks, 0 focus/keyboard messages, 0 foreground events and 0 virtual-desktop switches. |
| ~16:23 | button-click one-shot BM_CLICK on exact System PushButton | PASS: application log exactly one BUTTON_WM_F5 and exactly one APP_BUTTON_CLICK=1. 0 unexpected Edit callbacks, 0 focus or keyboard messages, 0 passive observer alarm and no virtual-desktop change. Desktop1 active before/after. |

Evidence local:
- Rejected first stage: test-area/desktop2-real-acceptance/runs/native-button-inspect-2026-10-09T08-19-01-659Z/
- Successful inspect: latest test-area/desktop2-real-acceptance/runs/native-button-inspect-* dated ~2026-10-09T08-22Z
- Successful click: test-area/desktop2-real-acceptance/runs/native-button-click-2026-10-09T08-22-56-890Z/
- Observer for click: %LOCALAPPDATA%\DMC\t\deskmcp-d2-lease-4daa8f6a-F8KUfK\observer.events.jsonl; START only, no foreground-theft or VDA switch event.
- Raw runs are Git-ignored and preserved locally. No incident evidence erased, copied to Git or exposed.

Offline release gates: C# build 0 warnings/errors, TypeScript targeted 49/49 PASS, native security static 16/16 PASS including missing-observer deny and quarantined dangerous UIAutomation ValuePattern.SetValue.

## Limits
- One owned opt-in Windows Forms System-style PushButton does NOT prove all third-party dialogs, custom/owner-drawn controls, WPF, WinUI, Electron, browsers, popup/scroll/drag, or arbitrary GUI apps safe.
- Official Microsoft BM_CLICK documentation warns inactive dialogs may not respond; its SetActiveWindow workaround is explicitly forbidden by the Desktop1 zero-interference requirement. If BM_CLICK fails, report failure: do not automatically activate or switch desktops.
- Native BM_CLICK completion alone does not prove business Click callback. Only separate application event log confirmed the exact one callback for our fixture.
- Passive observer detects a first foreground theft but cannot undo it; prior protected WPF .NET ValuePattern.SetValue was proven to steal the owner's foreground and remains quarantined.
- Production desktop_ui_action and installed DeskMCP are unchanged. General Computer Use release remains RED.

**Capability:** system-style native WinForms PushButton verified for one owned fixture, not universally approved.
