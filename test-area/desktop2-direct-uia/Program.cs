using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Automation;

// Source-only, NOT connected to the production Computer Use MCP.
// No WinApp CLI, keyboard/mouse injection, window activation or clipboard use.
// ValuePattern/ScrollPattern providers CAN nevertheless cause app side effects.
// Without a verified passive observer, every action must fail closed.

internal sealed class SemanticPolicy
{
    public static bool Permitted(string? action) =>
        action is "inspect" or "inspect-tree" or "scroll-top" or "scroll-bottom";

    public static void Demand(string? action)
    {
        // Real Windows Desktop2 protected WPF still stole Desktop1 foreground
        // during ValuePattern.SetValue on 2026-10-09. The tripwire fired
        // AFTER the irreversible activation and app text mutation.
        if (action == "set-value")
            throw new InvalidOperationException("DIRECT_UIA_VALUEPATTERN_QUARANTINED_AFTER_FOREGROUND_THEFT");
        if (action == "invoke")
            throw new InvalidOperationException("INVOKE_DISABLED_UNTIL_DESKTOP2_POPUP_ACTIVATION_ACCEPTANCE");
        if (!Permitted(action))
            throw new InvalidOperationException("UNSUPPORTED_FOREGROUND_OR_UNVERIFIED_UIA_ACTION");
    }

    public static void DemandOwnerDesktop(int? currentIndex)
    {
        if (currentIndex != 0)
            throw new InvalidOperationException("OWNER_NOT_ON_DESKTOP1_ABORT");
    }
}

internal sealed class Request
{
    public string Action { get; set; } = "";
    public long Hwnd { get; set; }
    public int ProcessId { get; set; }
    public string DesktopId { get; set; } = "";
    public string AutomationId { get; set; } = "";
    public string? Value { get; set; }
    public string ObserverReady { get; set; } = "";
}

internal static class Native
{
    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
    private interface IVirtualDesktopManager
    {
        [return: MarshalAs(UnmanagedType.Bool)]
        bool IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow);
        Guid GetWindowDesktopId(IntPtr topLevelWindow);
        void MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetCurrentDesktopNumberDelegate();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtrW(IntPtr hwnd, int index);

    private const uint GaRoot = 2;
    private const int GwlExstyle = -20;
    private const long WsExNoactivate = 0x08000000L;

    // The original WPF A/B test showed an active-window steal BEFORE
    // the real virtual desktop transition. Guard the risky provider call,
    // not merely the after-the-fact virtual desktop index.
    internal static bool HasNoActivateStyle(long extendedStyle)
        => (extendedStyle & WsExNoactivate) == WsExNoactivate;
    internal sealed class Context : IDisposable
    {
        private readonly IntPtr dll;
        private readonly GetCurrentDesktopNumberDelegate current;
        private readonly IVirtualDesktopManager desktopManager;

        public Context(string explicitDll)
        {
            if (!File.Exists(explicitDll)) throw new InvalidOperationException("VERIFIED_VDA_DLL_REQUIRED");
            dll = NativeLibrary.Load(Path.GetFullPath(explicitDll));
            try
            {
                current = Marshal.GetDelegateForFunctionPointer<GetCurrentDesktopNumberDelegate>(
                    NativeLibrary.GetExport(dll, "GetCurrentDesktopNumber"));
                Type clsid = Type.GetTypeFromCLSID(new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A"),
                    throwOnError: true)!;
                desktopManager = (IVirtualDesktopManager)Activator.CreateInstance(clsid)!;
            }
            catch { NativeLibrary.Free(dll); throw; }
        }

        public int? Current() { int x = current(); return x < 0 ? null : x; }

        public void VerifyTarget(IntPtr hwnd, int processId, Guid desktopId)
        {
            SemanticPolicy.DemandOwnerDesktop(Current());
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
                throw new InvalidOperationException("TARGET_HWND_NOT_LIVE");
            IntPtr root = GetAncestor(hwnd, GaRoot);
            if (root == IntPtr.Zero || root != hwnd)
                throw new InvalidOperationException("ONLY_TOP_LEVEL_ROOT_HWND_ALLOWED");
            GetWindowThreadProcessId(root, out uint pid);
            if (pid != checked((uint)processId))
                throw new InvalidOperationException("TARGET_PROCESS_OWNER_MISMATCH");
            if (desktopManager.GetWindowDesktopId(root) != desktopId)
                throw new InvalidOperationException("TARGET_VIRTUAL_DESKTOP_GUID_MISMATCH");
            if (desktopManager.IsWindowOnCurrentVirtualDesktop(root))
                throw new InvalidOperationException("PINNED_OR_SHARED_TARGET_VISIBLE_ON_DESKTOP1");
            IntPtr foreground = GetForegroundWindow();
            if (foreground == root)
                throw new InvalidOperationException("TARGET_IS_FOREGROUND_ABORT");
            SemanticPolicy.DemandOwnerDesktop(Current());
        }

        // Never retrofit WS_EX_NOACTIVATE onto an unknown third-party window:
        // modifying its styles can break its interaction model. Only opt-in
        // app-owned windows that already carry this style may receive mutating
        // UIA operations in real Windows virtual Desktop2.
        public void VerifyNonActivatingTarget(IntPtr hwnd)
        {
            if (!IsWindow(hwnd))
                throw new InvalidOperationException("NOACTIVATE_TARGET_NOT_LIVE");
            long extendedStyle = GetWindowLongPtrW(hwnd, GwlExstyle).ToInt64();
            if (!HasNoActivateStyle(extendedStyle))
                throw new InvalidOperationException("DESKTOP2_TARGET_NOT_PROTECTED_WS_EX_NOACTIVATE");
        }

        public void Dispose()
        {
            if (Marshal.IsComObject(desktopManager)) Marshal.FinalReleaseComObject(desktopManager);
            NativeLibrary.Free(dll);
        }
    }
}

internal static class ObserverGuard
{
    private sealed class Ready
    {
        public int ProcessId { get; set; }
        public int ExpectedDesktopIndex { get; set; }
        public DateTime FirstStartUtc { get; set; }
        public string? TripwireFile { get; set; }
        public string? WatchedTargetFile { get; set; }
        public bool HasVirtualDesktopNotifications { get; set; }
        public bool HasForegroundHook { get; set; }
    }
    private sealed class WatchedTarget
    {
        public long Hwnd { get; set; }
        public int ProcessId { get; set; }
        public int DesktopIndex { get; set; }
    }

    internal static string AssertLive(string readyFile)
    {
        if (!Path.IsPathFullyQualified(readyFile) || !File.Exists(readyFile))
            throw new InvalidOperationException("PASSIVE_OBSERVER_NOT_READY");
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        Ready ready = JsonSerializer.Deserialize<Ready>(File.ReadAllText(readyFile), options)
            ?? throw new InvalidOperationException("PASSIVE_OBSERVER_INVALID_READY");
        if (ready.ExpectedDesktopIndex != 0 || !ready.HasForegroundHook || !ready.HasVirtualDesktopNotifications
            || ready.ProcessId <= 0 || String.IsNullOrWhiteSpace(ready.TripwireFile))
            throw new InvalidOperationException("PASSIVE_OBSERVER_UNTRUSTED_STATE");
        if (!Path.IsPathFullyQualified(ready.TripwireFile))
            throw new InvalidOperationException("PASSIVE_TRIPWIRE_PATH_UNTRUSTED");
        if (File.Exists(ready.TripwireFile))
            throw new InvalidOperationException("DESKTOP_SWITCH_TRIPWIRE_LATCHED");
        using Process process = Process.GetProcessById(ready.ProcessId);
        if (process.HasExited || !process.ProcessName.Equals("DeskMCP.Desktop2SwitchObserver", StringComparison.Ordinal))
            throw new InvalidOperationException("PASSIVE_OBSERVER_WRONG_PROCESS");
        if (Math.Abs((process.StartTime.ToUniversalTime() - ready.FirstStartUtc.ToUniversalTime()).TotalSeconds) > 10)
            throw new InvalidOperationException("PASSIVE_OBSERVER_PID_REUSED");
        // This is a liveness gate, NOT evidence that the hook catches every switch.
        if (File.Exists(ready.TripwireFile)) throw new InvalidOperationException("DESKTOP_SWITCH_TRIPWIRE_LATCHED");
        return ready.TripwireFile;
    }

    internal static string GetUnarmedTargetSlot(string readyFile)
    {
        AssertLive(readyFile);
        Ready ready = JsonSerializer.Deserialize<Ready>(File.ReadAllText(readyFile),
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("PASSIVE_OBSERVER_INVALID_READY");
        string? targetFile = ready.WatchedTargetFile;
        if (String.IsNullOrWhiteSpace(targetFile)
            || !Path.IsPathFullyQualified(targetFile) || File.Exists(targetFile)
            || !Directory.Exists(Path.GetDirectoryName(targetFile)))
            throw new InvalidOperationException("EARLY_FOREGROUND_WATCH_SLOT_INVALID_OR_USED");
        return targetFile;
    }

    internal static void AssertWatchedTarget(string readyFile, long hwnd, int processId)
    {
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        Ready ready = JsonSerializer.Deserialize<Ready>(File.ReadAllText(readyFile), options)
            ?? throw new InvalidOperationException("PASSIVE_OBSERVER_INVALID_READY");
        string? watchedFile = ready.WatchedTargetFile;
        if (String.IsNullOrWhiteSpace(watchedFile)
            || !Path.IsPathFullyQualified(watchedFile) || !File.Exists(watchedFile))
            throw new InvalidOperationException("EARLY_FOREGROUND_WATCH_NOT_ARMED");
        WatchedTarget watched = JsonSerializer.Deserialize<WatchedTarget>(
            File.ReadAllText(watchedFile), options)
            ?? throw new InvalidOperationException("EARLY_FOREGROUND_WATCH_INVALID");
        if (watched.Hwnd != hwnd || watched.ProcessId != processId
            || watched.DesktopIndex != 1)
            throw new InvalidOperationException("EARLY_FOREGROUND_WATCH_TARGET_MISMATCH");
        if (ready.TripwireFile == null || File.Exists(ready.TripwireFile))
            throw new InvalidOperationException("EARLY_FOREGROUND_WATCH_TRIPWIRE_LATCHED");
    }
}

internal static partial class DirectUia
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    private static Request ParseRequest(string path)
    {
        if (!Path.IsPathFullyQualified(path) || !File.Exists(path))
            throw new InvalidOperationException("EXPLICIT_REQUEST_FILE_REQUIRED");
        FileInfo info = new(path);
        if (info.Length is < 3 or > 81920)
            throw new InvalidOperationException("INVALID_REQUEST_SIZE");
        Request req = JsonSerializer.Deserialize<Request>(File.ReadAllText(path), Json)
            ?? throw new InvalidOperationException("INVALID_REQUEST_JSON");
        SemanticPolicy.Demand(req.Action);
        if (req.Hwnd <= 0 || req.ProcessId <= 0 || req.AutomationId.Length is < 1 or > 128
            || req.AutomationId.Contains('\0'))
            throw new InvalidOperationException("INVALID_TARGET_IDENTITY_OR_AUTOMATION_ID");
        if (!Guid.TryParseExact(req.DesktopId, "D", out Guid id) || id == Guid.Empty)
            throw new InvalidOperationException("INVALID_VIRTUAL_DESKTOP_ID");
        if (req.Action == "set-value" && (req.Value is null || req.Value.Length > 2048))
            throw new InvalidOperationException("INVALID_VALUE");
        if (req.Action != "set-value" && req.Value is not null)
            throw new InvalidOperationException("EXTRA_VALUE_NOT_ALLOWED");
        if (req.Action is "set-value" or "scroll-top" or "scroll-bottom"
            && req.AutomationId.Length == 0)
            throw new InvalidOperationException("AUTOMATION_ID_REQUIRED");
        if (req.Action == "set-value" && req.Value!.Any(char.IsControl))
            throw new InvalidOperationException("CONTROL_CHARACTER_NOT_PERMITTED");
        if (req.Action == "inspect-tree" && req.AutomationId != "__tree_snapshot__")
            throw new InvalidOperationException("TREE_SNAPSHOT_SENTINEL_REQUIRED");
        return req;
    }

    private static AutomationElement FindExactElement(IntPtr hwnd, string automationId)
    {
        // Do not focus or activate. No clickable fallback and no fuzzy selector.
        AutomationElement root = AutomationElement.FromHandle(hwnd)
            ?? throw new InvalidOperationException("UIA_ROOT_NOT_AVAILABLE");
        Condition match = new PropertyCondition(AutomationElement.AutomationIdProperty, automationId);
        AutomationElementCollection elements = root.FindAll(TreeScope.Descendants, match);
        if (elements.Count != 1)
            throw new InvalidOperationException("UIA_AUTOMATION_ID_NOT_UNIQUE");
        AutomationElement element = elements[0];
        if (!element.Current.IsEnabled || element.Current.IsOffscreen)
            throw new InvalidOperationException("UIA_CONTROL_DISABLED_OR_OFFSCREEN");
        return element;
    }

    // Explicit two-phase arm. The hidden observer runs FIRST and publishes
    // its own ready file. Only after verifying root HWND/PID/Desktop2 AND
    // non-activating style may this process atomically publish that target's
    // identity for early foreground-theft detection.
    private static object ArmTarget(Request request, Native.Context ctx)
    {
        if (request.Action != "inspect")
            throw new InvalidOperationException("ARM_TARGET_REQUIRES_READONLY_IDENTITY_REQUEST");
        IntPtr hwnd = new(request.Hwnd);
        Guid targetId = Guid.ParseExact(request.DesktopId, "D");
        ObserverGuard.AssertLive(request.ObserverReady);
        ctx.VerifyTarget(hwnd, request.ProcessId, targetId);
        ctx.VerifyNonActivatingTarget(hwnd);
        string slot = ObserverGuard.GetUnarmedTargetSlot(request.ObserverReady);
        string temporary = slot + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(new
            {
                hwnd = request.Hwnd,
                processId = request.ProcessId,
                desktopIndex = 1
            }));
            // Atomic same-directory rename: observer never sees partial JSON.
            File.Move(temporary, slot, overwrite: false);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
        ObserverGuard.AssertWatchedTarget(request.ObserverReady, request.Hwnd, request.ProcessId);
        ObserverGuard.AssertLive(request.ObserverReady);
        ctx.VerifyTarget(hwnd, request.ProcessId, targetId);
        ctx.VerifyNonActivatingTarget(hwnd);
        return new { armed = true, hwnd = request.Hwnd, processId = request.ProcessId,
            desktopIndex = 1, activationGuard = "WS_EX_NOACTIVATE",
            foregroundTripwire = true, appEventConfirmed = false };
    }

    private static object Perform(Request request, Native.Context ctx)
    {
        if (request.Action == "set-value")
            throw new InvalidOperationException("DIRECT_UIA_VALUEPATTERN_QUARANTINED_AFTER_FOREGROUND_THEFT");
        IntPtr hwnd = new(request.Hwnd);
        Guid targetId = Guid.ParseExact(request.DesktopId, "D");
        void Guard()
        {
            ObserverGuard.AssertLive(request.ObserverReady);
            ctx.VerifyTarget(hwnd, request.ProcessId, targetId);
            // Even read-only UIA pattern/property discovery can invoke a
            // misbehaving third-party provider. Require the same already-
            // armed observer and NOACTIVATE root for inspect/inspect-tree too.
            ctx.VerifyNonActivatingTarget(hwnd);
            ObserverGuard.AssertWatchedTarget(request.ObserverReady,
                request.Hwnd, request.ProcessId);
            ObserverGuard.AssertLive(request.ObserverReady);
        }
        Guard();
        // Enumerate bounded, metadata-only eligible controls only AFTER the
        // observer is armed; no tree traversal in --arm-target.
        if (request.Action == "inspect-tree")
            return InspectTree(hwnd, request.ProcessId, Guard);
        AutomationElement element = FindExactElement(hwnd, request.AutomationId);
        if (element.Current.ProcessId != request.ProcessId)
            throw new InvalidOperationException("UIA_ELEMENT_PROCESS_ID_MISMATCH");
        Guard();
        if (request.Action == "inspect")
        {
            var snapshot = new {
                operation = "inspect",
                elementControlType = element.Current.ControlType.ProgrammaticName,
                className = element.Current.ClassName,
                hasValuePattern = element.TryGetCurrentPattern(ValuePattern.Pattern, out _),
                hasScrollPattern = element.TryGetCurrentPattern(ScrollPattern.Pattern, out _),
                allowedToInvoke = false,
                uiaReadbackConfirmed = false,
                appEventConfirmed = false
            };
            Guard();
            return snapshot;
        }
        if (request.Action is "scroll-top" or "scroll-bottom")
        {
            if (!element.TryGetCurrentPattern(ScrollPattern.Pattern, out object? raw) || raw is not ScrollPattern pattern
                || !pattern.Current.VerticallyScrollable)
                throw new InvalidOperationException("VERTICAL_SCROLLPATTERN_REQUIRED");
            double percent = request.Action == "scroll-top" ? 0.0 : 100.0;
            Guard();
            pattern.SetScrollPercent(ScrollPattern.NoScroll, percent);
            Guard();
            double observed = pattern.Current.VerticalScrollPercent;
            Guard();
            if (double.IsNaN(observed) || Math.Abs(observed - percent) > 1)
                throw new InvalidOperationException("VERTICAL_SCROLL_READBACK_MISMATCH");
            return new { operation = request.Action, target = request.AutomationId,
                scrollPercent = observed, uiaReadbackConfirmed = true,
                appEventConfirmed = false };
        }
        throw new InvalidOperationException("UIA_ACTION_FAIL_CLOSED");
    }

    // Offline self-test touches no windows, UIA clients, VDA or observer process.
    private static object SelfTest()
    {
        bool[] allow = new[] {"inspect", "inspect-tree", "scroll-top", "scroll-bottom"}
            .Select(SemanticPolicy.Permitted).ToArray();
        bool[] deny = new[] {"set-value", "invoke", "click", "drag", "send-keys", "focus", "hover", "wheel", "paste"}
            .Select(SemanticPolicy.Permitted).ToArray();
        bool owner0 = false, owner1 = false, ownerNull = false;
        try { SemanticPolicy.DemandOwnerDesktop(0); owner0 = true; } catch {}
        try { SemanticPolicy.DemandOwnerDesktop(1); owner1 = true; } catch {}
        try { SemanticPolicy.DemandOwnerDesktop(null); ownerNull = true; } catch {}
        bool protectedWindow = Native.HasNoActivateStyle(0x08000000L);
        bool unprotectedWindow = Native.HasNoActivateStyle(0L);
        bool unrelatedStyle = Native.HasNoActivateStyle(0x00080000L);
        bool combinedStyle = Native.HasNoActivateStyle(0x08080000L);
        bool pass = allow.All(x=>x) && deny.All(x=>!x) && owner0 && !owner1 && !ownerNull
            && protectedWindow && !unprotectedWindow && !unrelatedStyle && combinedStyle;
        return new { pass, allowedActions = allow.Length, deniedActions = deny.Length,
            desktop1 = owner0, desktop2 = owner1, unreadable = ownerNull,
            invokeIsDisabled = !SemanticPolicy.Permitted("invoke"),
            protectedWindow, unprotectedWindow, unrelatedStyle, combinedStyle };
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--self-test")
            {
                object result = SelfTest();
                Console.WriteLine(JsonSerializer.Serialize(result));
                return (bool)(result.GetType().GetProperty("pass")!.GetValue(result)!) ? 0 : 2;
            }
            if (args.Length != 4
                || (args[0] != "--request" && args[0] != "--arm-target")
                || args[2] != "--vda")
                throw new InvalidOperationException("EXPLICIT_LOCAL_REQUEST_AND_VDA_REQUIRED");
            Request request = ParseRequest(args[1]);
            using Native.Context ctx = new(args[3]);
            object output = args[0] == "--arm-target"
                ? ArmTarget(request, ctx)
                : Perform(request, ctx);
            Console.WriteLine(JsonSerializer.Serialize(output));
            return 0;
        }
        catch (Exception ex)
        {
            // Do not print request values or UIA content to logs.
            Console.Error.WriteLine("DIRECT_UIA_DENIED_OR_FAILED: " + ex.GetType().Name + ": " + ex.Message);
            return 3;
        }
    }
}
