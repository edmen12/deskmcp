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

### 2026-10-09 事故复现后的防激活修复（候选）

用户批准的受监控 A/B GUI 测试发现：原版 WPF 没有 `WS_EX_NOACTIVATE` 时，直接运行 `winapp ui set-value`，**目标 WPF HWND/PID 先成为 Desktop1 系统前台，约 118ms 后 Windows 真实切到 Desktop2**。VirtualDesktopAccessor 已捕获真正的切屏通知 `old=0,new=1,current=1`。新版 WPF 具有 `WS_EX_NOACTIVATE` 后，整轮相同操作没有观察到前台激活或切屏。完整证据：`test-area/desktop2-incident-trace/findings-20261009.md`。

本轮实现两阶段候选防护：
1. **启动被动监听**：使用编译出的 `DeskMCP.Desktop2SwitchObserver.exe --observe-target <VDA DLL> <events> <ready> <tripwire> <absolute watch-file>`，必须在 Desktop1 且 watch-file 尚不存在。注意使用 `.exe` AppHost（以便按进程名称核对监控身份），不能把此流程随意换成 `dotnet observer.dll`。
2. **监控目标自动登记**：`DeskMCP.Desktop2DirectUia.dll --arm-target <absolute inspect-only request JSON> --vda <VDA DLL>`。核实监控身份与运行状态、Desktop1 当前桌面、目标根窗口 HWND/PID/真实 Desktop2 GUID、非 pinned 目标、现成的 `WS_EX_NOACTIVATE`。再将已验证的 `{hwnd, processId, desktopIndex:1}` 原子写入监控目标文件。**不自动给第三方软件改 WS_EX_NOACTIVATE**。
3. **受限修改**：`--request` 的 ValuePattern/ScrollPattern 操作在进入 UIA provider **之前**复核全部上述条件及登记 HWND/PID，动作后再次检查；监控监听目标窗口意外成为前台时立即锁存 `TARGET_FOREGROUND_EARLY_ABORT`，25ms 辅助轮询，并继续捕捉 Windows 真实切屏。不会触发系统级键盘、鼠标、剪贴板或自动切回。

**限制：前台激活→桌面切换的 118ms 仅为一次观察，不是恒定时间窗口。** 提前中止也不保证能抢在 Windows 桌面切换之前阻断已排队的 OS 激活。该候选仅允许有明确非激活设计的窗口；其他软件、WinUI/Electron、多窗口弹窗未验收。候选 TypeScript 适配层已接入真实 Agent Desktop lease/HUD 校验和一次性窗口/控件观察凭证，但**没有接入正式 Computer Use MCP**，发布状态继续 RED。

2026-10-09 新增：`--request inspect` 也必须先核实非激活窗口样式及已登记的监控目标，堵住之前的只读 UIA 防护缺口。`--request inspect-tree` 只遍历受限 UIA ControlView：最多 128 节点 / 32 个可操作控件，拒绝重复 AutomationId 和无法完整检查的树，不读取任何文本框内容。候选 `snapshotWindow` 产生绑定租约/窗口/监控就绪文件的**一次性语义授权**，不能凭空传 AutomationId 进行输入。停止租约时如有原生 UIA 调用仍执行，先禁止新操作但继续监听，等它结束后关闭监控。

仍须完成的工作：在真实 Desktop2 的受保护窗口上验证完整快照→动作链，并独立验收 WinForms/WinUI/Electron 的控件事件和焦点语义。请勿重新启用已封锁的原版诊断入口。

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

### 2026-10-09 06:03 MYT 实机发现：`ValuePattern.SetValue` 抢走 Desktop1 前台，已封锁

更晚的受保护 WPF 实测推翻了此前“WS_EX_NOACTIVATE 足以避免直接 UIA 抢焦点”的假设。**窗口枚举、监控登记与只读元数据快照成功**（确认 `WpfEdit` / `WpfScroller`）；但第一次原生 `ValuePattern.SetValue` 使 Desktop2 的 WPF 窗口成为系统 foreground，同时用户仍在虚拟 Desktop1。监控立即锁存 `TARGET_FOREGROUND_EARLY_ABORT`，窗口仍收到激活与焦点消息，且文本被修改两次，其中一次多了意外的前导字符。**本次没有检测到虚拟桌面切换**，但已有实际 Desktop1 输入/焦点干扰。原始报告：`test-area/desktop2-real-acceptance/incident-20261009-direct-uia-focus-steal.md`。

因此，当前候选版的 `set-value` **已在 TS 层与原生 C# policy 层提前拒绝**，C# 可执行程序中的 `pattern.SetValue` 已移除；之前的受监控 WPF live 测试脚本也被无条件封锁。这个结论只针对已确认不安全的直连 UIA 修改传输，**不代表所有 Computer Use 已关闭**。`inspect-tree` 对单个受保护 WPF fixture 的实测只读路径通过；`scroll` 尚未单独验收。任何文本编辑替代方案必须独立证明不抢前台、不碰共享键盘、不产生额外编辑。发布 RED，正式 MCP/安装版不变。
