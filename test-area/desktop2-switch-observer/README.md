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

**新增实际无 GUI 监听验收（2026-10-09）**：`--observe-idle` 在真实用户会话中持续监听 **9 秒**，退出码 `0`，日志有 START/END、`desktopIndex=0`、无 tripwire，退出后 ready 标记已清理。这证明本地 DLL 加载、事件注册和资源销毁能正常运行，但期间没有发生真实桌面切换（notifications=0），不证明真实切换的捕获能力。

**新增消息处理验收**：`--self-test-notification` 通过 `PostMessageW` 向**自己的 HWND_MESSAGE** 发送模拟 `old=0,new=1`，没有调用虚拟桌面切换 API。第二轮修正日志共享方式后 **exit 0**，事件旧/新桌面完整，tripwire 在真实桌面仍为 0 时维持锁存，5 秒后 ready 清理成功。首轮 exit 3 是读取自己未关闭的日志造成文件占用，非真实桌面切换；已修复并重新验收。

**仍未验证**：VirtualDesktopAccessor 在真实 Desktop1↔Desktop2 切换时的事件回调完整性与实时性；GUI 执行期间的因果归因、前台焦点变化。没有再次运行 WPF GUI。

测试前需有独立的被动监听运行安全审查；单独启用观察器不能授权 GUI 测试。只有在验证它确实能记录手动 Desktop 1→2→1 且不会切屏、并把每次测试动作关联到时间线之后，才能考虑重新申请实机 GUI 验收。测试过程中第一条没有得到解释的切换就保持 RED。

## 候选构建及纯逻辑测试

使用仓库已有 `runtime/dotnet-sdk/dotnet.exe`，不安装 .NET。运行 WinExe 测试要先设置 `DOTNET_ROOT` 为 SDK 路径。

```powershell
& 'C:\Users\User\Desktop\DeskMCP\runtime\dotnet-sdk\dotnet.exe' build .\test-area\desktop2-switch-observer\DeskMCP.Desktop2SwitchObserver.csproj -c Release --nologo
& 'C:\Users\User\Desktop\DeskMCP\runtime\dotnet-sdk\dotnet.exe' .\test-area\desktop2-switch-observer\bin\Release\net10.0-windows\DeskMCP.Desktop2SwitchObserver.dll --self-test .\test-area\desktop2-switch-observer\policy-selftest.json
```

`--observe <absolute DLL> <eventLogFile> <readyFile> <tripwireFile>` 是原始观察模式。2026-10-09 用户批准的真实 A/B 复现中，已证实 VirtualDesktopAccessor 可以把实际桌面切换通知 `old=0,new=1,current=1` 送到观察器。新增 `--observe-target <absolute DLL> <eventLogFile> <readyFile> <tripwireFile> <absolute watchFile>` 模式：启动时 watchFile 不存在，之后仅由通过 HWND/PID、Desktop2 GUID、Desktop1 当前桌面、现有 `WS_EX_NOACTIVATE` 核查的候选 DirectUia `--arm-target` 原子发布。捕捉到该窗口在 Desktop1 仍活跃时成为前台，即锁存 `TARGET_FOREGROUND_EARLY_ABORT`；此外 25ms 心跳也复查目标前台。它只能尝试提前中止，**不是系统级焦点拦截，也不能阻止已经在 Windows 内部排队的切屏**。新模式仅代码编译与纯策略回归通过，未执行新的 GUI 实测。短时 `--observe-idle ... 9`、模拟 `--self-test-notification ... 5` 已运行并通过各自验收。后者只向自己的隐藏 HWND 发布消息，并不会切换 Windows 桌面。不要把监听器单独运行成功理解为 GUI Computer Use 的零干扰证明。四次用户报告切屏已记录，不能靠正式版 Agent lease 日志未增加来否认，因为原 WPF 测试没有 Agent lease。


2026-10-09 候选更新：`--observe-target` 的默认寿命上限为 **900 秒（15 分钟）**，到时退出；调用方必须因 ready/进程消失而 fail closed。新增 `src/desktop2-observer-lifecycle.ts` 管理 owned observer + HUD/租约有效性和文件生命周期，`src/desktop2-computer-use-session.ts` 不接受用户自己指定监控 ready 路径或租约。仅通过 **mock 进程的离线测试**，未开展新的 GUI 输入验收。停止时保留实际事故的 events/tripwire，不自动切回 Desktop1。
