# Desktop 2 原生 UIA 直连候选（**源码实验，不在正式 MCP 中启用**）

背景：2026-10-09 用户报告 4 次非预期切屏。本候选绕过 WinApp CLI 的操作调度层，直接向指定的真实 Windows 虚拟 Desktop2 应用调用 UI Automation `ValuePattern` / `ScrollPattern`，不以 Win32 Desktop Object、VM 或自动切回桌面替代要求。

## 能力与限制

- `inspect`：仅按唯一 `AutomationId` 读取控件类型、类名及可用模式；不抓取用户输入内容。
- `set-value`：仅 WPF TextBox 与 WinForms Edit、唯一控件、可用且未离屏、可写 ValuePattern；设置后原值精确读回，最大 2048 字符，不通过系统键盘，也不接触剪贴板。
- `scroll-top` / `scroll-bottom`：仅支持纵向 ScrollPattern 的唯一容器，确认 UIA 滚动百分比为 0 或 100；不发系统滚轮。
- `invoke` / `click` / `drag` / `send-keys` / `focus` 及其它输入模式：**默认拒绝**。即使直接 UIA 的 InvokePattern 不一定显式调用系统激活 API，应用响应也可能创建窗口、改变焦点。未验收前不能无条件放行。
- 返回的 `uiaReadbackConfirmed=true` **不表示应用事件已验证**，`appEventConfirmed=false` 是真实状态。

## 强制约束

对每次操作校验：真实桌面 GUID，精确 HWND、进程 PID、一致的最顶层 Root，Windows 虚拟 Desktop2 所属，当前 Desktop1，拒绝 pinned/shared 窗口；已就绪、PID 与启动时间一致、仍存活的被动事件观察器以及未触发的 tripwire。控件不唯一或模式不支持，失败关闭。动作前后都复查。**绝不借用 WinApp CLI 控制桌面**，不调用 SetForegroundWindow / SendInput / SetCursorPos / SwitchDesktop / 剪贴板操作。

仍须完成的工作：将观察器真实 Windows Desktop1↔2 通知交付和时序验证通过、将窗口 ownership 与 DeskMCP 的真实 Agent lease 对齐、进行隔离测试以确保第一次输入不会导致切屏。**已有 tripwire 只能阻止后续操作，不能防止第一次切屏。**

注意：直接操作应用的 UIA provider 也可能产生窗口或焦点副作用。因此，本适配层目前**不会连接到 MCP 工具路由或生产 Gateway**，不声称零干扰已经通过。

## 无 GUI 离线验收

在仓库候选 worktree 根目录执行：

```powershell
node .\test-area\desktop2-direct-uia\offline-acceptance.mjs
```

用户机器的 PowerShell ExecutionPolicy 禁止直接执行 .ps1，**不修改也不绕过该安全策略**；本测试直接用项目已有 Node.js 运行。验收已在 2026-10-09 返回 `DIRECT_UIA_OFFLINE_ACCEPTANCE_PASS`，退出码 0。

该脚本使用本机 DeskMCP 自带 .NET SDK（无需安装或联网），运行编译、纯逻辑自检、无观察器拒绝执行、未验收 invoke 拒绝执行和 Node 静态安全契约测试。**不会创建测试 GUI、不会移动窗口、不会发送鼠标键盘输入**。拒绝测试的请求文件包含虚构 HWND/PID 和固定不存在的观察器路径，脚本还会检查它确实不存在。

## 资料

微软 UIA 官方文档：https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-control-patterns-overview 。WinApp CLI 当前说明：https://learn.microsoft.com/en-nz/windows/apps/dev-tools/winapp-cli/ui-automation 。其中 WinApp 的 `invoke` 等操作有“独占桌面”协调语义；该语义不必然等于 Windows 虚拟桌面切换，但绝不可以据此认定在真实 Desktop2 上零干扰。

事件观察器：`test-area/desktop2-switch-observer/`；旧 WPF GUI 测试脚本由于 `invoke` 路径仍不安全，继续标记 **RED / 禁止重跑**。
