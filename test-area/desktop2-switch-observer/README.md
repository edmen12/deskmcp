# Desktop 2 切屏观察器（候选 / 不可直接当发布证明）

背景：2026-10-09 用户确认本轮 WPF 实测期间 Desktop 1 **被非预期切走 4 次**。GUI 功能通过不等于桌面隔离通过；本轮安全验收 **RED**。正式 DeskMCP 0.9.23 不修改。

## 实现边界

- 独立 `WinExe` .NET 10 Windows Forms NativeWindow，使用 **HWND_MESSAGE** 消息窗口，不显示 GUI / 不进入任务栏；无桌面切换、窗口激活、键鼠输入或剪贴板调用。
- 从 DeskMCP 自带的 VirtualDesktopAccessor 加载 `GetCurrentDesktopNumber`、`GetDesktopCount`、`RegisterPostMessageHook`、`UnregisterPostMessageHook`。按 upstream 示例约定使用 `0x141e` 消息和目标 desktop index。必须在真实 Windows 11 上单独验证其通知语义，不可因静态编译通过就视为准确。
- 使用 Win32 `SetWinEventHook(EVENT_SYSTEM_FOREGROUND, OUTOFCONTEXT|SKIPOWNPROCESS)` 记录前台 HWND/PID，并提供 25 ms Timer **辅助**检查；采样只能补充通知，不能证明不存在短暂切换。
- 输出 JSONL：UTC、单调经过毫秒、事件类型、Desktop index、HWND、PID、监听次数。**不获取窗口标题、UI 字段、账号、剪贴板内容**。
- 遇到目标 Desktop 编号与 Desktop 1 不符、通知无效、监控故障，写入**一次性粘性 tripwire**；Desktop 1 恢复后也保留。切换可能由用户手动执行，**不能自动归因为 Agent**。不得自动切回 Desktop 1。
- WPF `d2-wpf-matrix.ps1` 必须检查有效、存活、未过期的监听进程及无 tripwire，才允许创建测试 GUI。每次 Native/WinApp 操作前后再次核查；含动作时间线。**这仍无法阻止第一次非预期切换**，只是避免继续发后续操作，因此不能直接打开实机测试发布门槛。

## 验证范围

候选代码静态编译与 `--self-test` 只测试逻辑；**没有**启动实时监听，也没有再运行 WPF GUI。观察器的消息通知、前台事件、UIA 行为仍是 **UNVERIFIED**。

测试前需有独立的被动监听运行安全审查；单独启用观察器不能授权 GUI 测试。只有在验证它确实能记录手动 Desktop 1→2→1 且不会切屏、并把每次测试动作关联到时间线之后，才能考虑重新申请实机 GUI 验收。测试过程中第一条没有得到解释的切换就保持 RED。

## 候选构建及纯逻辑测试

使用仓库已有 `runtime/dotnet-sdk/dotnet.exe`，不安装 .NET。运行 WinExe 测试要先设置 `DOTNET_ROOT` 为 SDK 路径。

```powershell
& 'C:\Users\User\Desktop\DeskMCP\runtime\dotnet-sdk\dotnet.exe' build .\test-area\desktop2-switch-observer\DeskMCP.Desktop2SwitchObserver.csproj -c Release --nologo
& 'C:\Users\User\Desktop\DeskMCP\runtime\dotnet-sdk\dotnet.exe' .\test-area\desktop2-switch-observer\bin\Release\net10.0-windows\DeskMCP.Desktop2SwitchObserver.dll --self-test .\test-area\desktop2-switch-observer\policy-selftest.json
```

`--observe <absolute DLL> <eventLogFile> <readyFile> <tripwireFile>` 是未完成验收的被动监听模式，**没有在当前会话运行**；不要和 WPF GUI 测试联动运行，直到完成单独审核。四次用户报告切屏已记录，不能靠日志里没有新增正式 Agent lease 事件来否认，因为过去的 GUI 测试没有 Agent lease。
