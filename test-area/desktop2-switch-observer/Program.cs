using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;

// SOURCE-ONLY diagnostic. No calls to GoToDesktopNumber, SendInput,
// SetForegroundWindow, virtual desktop creation, or clipboard APIs.
// A notification proves a change happened, NOT who caused it.
internal sealed class SwitchPolicy
{
    public int ExpectedDesktopIndex { get; }
    public bool Aborted { get; private set; }
    public string? FirstReason { get; private set; }

    public SwitchPolicy(int expectedDesktopIndex)
    {
        if (expectedDesktopIndex < 0) throw new ArgumentOutOfRangeException(nameof(expectedDesktopIndex));
        ExpectedDesktopIndex = expectedDesktopIndex;
    }

    public bool Observe(int observedIndex, string origin)
    {
        if (observedIndex < 0 || observedIndex != ExpectedDesktopIndex)
        {
            Aborted = true;
            FirstReason ??= origin;
        }
        return !Aborted;
    }
}

internal sealed class NativeVirtualDesktopApi : IDisposable
{
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetDesktopDelegate();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int RegisterHookDelegate(IntPtr listenerHwnd, uint message);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int UnregisterHookDelegate(IntPtr listenerHwnd);

    private readonly IntPtr library;
    private readonly GetDesktopDelegate getCurrent;
    private readonly GetDesktopDelegate getCount;
    private readonly RegisterHookDelegate register;
    private readonly UnregisterHookDelegate unregister;

    public NativeVirtualDesktopApi(string path)
    {
        if (String.IsNullOrWhiteSpace(path) || !File.Exists(path))
            throw new FileNotFoundException("Explicit VirtualDesktopAccessor DLL is required.", path);
        library = NativeLibrary.Load(Path.GetFullPath(path));
        try
        {
            getCurrent = Marshal.GetDelegateForFunctionPointer<GetDesktopDelegate>(
                NativeLibrary.GetExport(library, "GetCurrentDesktopNumber"));
            getCount = Marshal.GetDelegateForFunctionPointer<GetDesktopDelegate>(
                NativeLibrary.GetExport(library, "GetDesktopCount"));
            register = Marshal.GetDelegateForFunctionPointer<RegisterHookDelegate>(
                NativeLibrary.GetExport(library, "RegisterPostMessageHook"));
            unregister = Marshal.GetDelegateForFunctionPointer<UnregisterHookDelegate>(
                NativeLibrary.GetExport(library, "UnregisterPostMessageHook"));
        }
        catch
        {
            NativeLibrary.Free(library);
            throw;
        }
    }
    public int CurrentIndex()
    {
        int index = getCurrent();
        if (index < 0) throw new InvalidOperationException("Cannot resolve current Windows virtual desktop.");
        return index;
    }
    public int Count()
    {
        int count = getCount();
        if (count < 1 || count > 64) throw new InvalidOperationException("Invalid virtual desktop count.");
        return count;
    }
    public void Register(IntPtr hwnd, uint message)
    {
        if (register(hwnd, message) != 1) throw new InvalidOperationException("VDA desktop notifications unavailable; do not run GUI test.");
    }
    public void Unregister(IntPtr hwnd) => unregister(hwnd);
    public void Dispose() => NativeLibrary.Free(library);
}

internal sealed class DesktopEventListener : NativeWindow, IDisposable
{
    private const uint NotificationMessage = 0x141e;
    private const uint ForegroundEvent = 0x0003;
    private const uint WindowShowEvent = 0x8002;
    private const uint WinEventOutOfContext = 0;
    private const uint WinEventSkipOwnProcess = 2;
    private readonly NativeVirtualDesktopApi vda;
    private readonly StreamWriter log;
    private readonly string eventLogPath;
    private readonly string readyFile;
    private readonly string tripwireFile;
    private readonly string? watchedTargetFile;
    private readonly SwitchPolicy policy;
    private readonly int desktopCount;
    private readonly WinEventProc foregroundCallback;
    private readonly WinEventProc windowShownCallback;
    private readonly System.Windows.Forms.Timer heartbeat = new();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly int durationMs;
    private IntPtr foregroundHook;
    private IntPtr windowShowHook;
    private bool registered;
    private bool disposed;
    private bool readyPublished;
    private readonly bool strictPrelaunch;
    private readonly IntPtr baselineForeground;
    private int notifications;
    private int heartbeatChanges;

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint thread, uint eventTime);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    private sealed class WatchedTarget
    {
        public long Hwnd { get; set; }
        public int ProcessId { get; set; }
        public int DesktopIndex { get; set; }
    }
    internal static bool IsWatchedForeground(long rootHwnd, uint actualPid, int current,
        long watchedHwnd, int watchedPid, int watchedDesktopIndex) =>
        current == 0 && watchedDesktopIndex >= 1
        && rootHwnd > 0 && watchedHwnd == rootHwnd
        && watchedPid > 0 && actualPid == (uint)watchedPid;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint processId, uint threadId, uint flags);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr oldDesktop, IntPtr newDesktop);

    // Dedicated diagnostic only: inject a Windows message into our OWN message-only
    // listener HWND. Does NOT invoke VDA GoToDesktopNumber or change user desktops.
    public void PostSyntheticNotificationForSelfTest()
    {
        if (!PostMessageW(Handle, NotificationMessage, IntPtr.Zero, new IntPtr(1)))
            throw new InvalidOperationException("Synthetic self-notification could not be queued.");
    }

    public DesktopEventListener(string dll, string eventsFile, string ready, string tripwire, int seconds,
        string? watchFile = null, bool strictLaunch = false)
    {
        if (seconds is < 5 or > 900) throw new ArgumentOutOfRangeException(nameof(seconds));
        if (watchFile != null && (!Path.IsPathFullyQualified(watchFile)
            || File.Exists(watchFile)))
            throw new InvalidOperationException("Target watch file must be an absolute, not-yet-existing path.");
        durationMs = checked(seconds * 1000);
        readyFile = ready;
        eventLogPath = eventsFile;
        tripwireFile = tripwire;
        watchedTargetFile = watchFile;
        strictPrelaunch = strictLaunch;
        baselineForeground = GetForegroundWindow();
        if (strictPrelaunch && baselineForeground == IntPtr.Zero)
            throw new InvalidOperationException("STRICT_LAUNCH_FOREGROUND_BASELINE_MISSING");
        if (File.Exists(readyFile) || File.Exists(tripwireFile))
            throw new InvalidOperationException("Stale ready/tripwire files must be reviewed and cleared before creating a fresh observer.");
        vda = new NativeVirtualDesktopApi(dll);
        try
        {
            desktopCount = vda.Count();
            policy = new SwitchPolicy(vda.CurrentIndex());
            if (policy.ExpectedDesktopIndex != 0)
                throw new InvalidOperationException("Passive safety observer must start while the owner's Desktop 1 is active.");
            log = new StreamWriter(new FileStream(eventsFile, FileMode.CreateNew, FileAccess.Write, FileShare.Read));
            log.AutoFlush = true;
        }
        catch { vda.Dispose(); throw; }
        try
        {
            CreateParams parameters = new() { Caption = "DeskMCP message-only switch listener", Parent = new IntPtr(-3) };
            CreateHandle(parameters); // HWND_MESSAGE: not a visible/taskbar window.
            vda.Register(Handle, NotificationMessage);
            registered = true;
            foregroundCallback = ForegroundChanged;
            windowShownCallback = WindowShown;
            foregroundHook = SetWinEventHook(ForegroundEvent, ForegroundEvent, IntPtr.Zero,
                foregroundCallback, 0, 0, WinEventOutOfContext | WinEventSkipOwnProcess);
            if (foregroundHook == IntPtr.Zero)
                throw new InvalidOperationException("Cannot register foreground event observer.");
            if (strictPrelaunch)
            {
                windowShowHook = SetWinEventHook(WindowShowEvent, WindowShowEvent, IntPtr.Zero,
                    windowShownCallback, 0, 0, WinEventOutOfContext | WinEventSkipOwnProcess);
                if (windowShowHook == IntPtr.Zero)
                    throw new InvalidOperationException("Cannot register strict root-window show observer.");
            }
            if (strictPrelaunch && (GetForegroundWindow() != baselineForeground || vda.CurrentIndex() != 0))
                throw new InvalidOperationException("STRICT_LAUNCH_FOREGROUND_CHANGED_BEFORE_READY");
            Log("START", policy.ExpectedDesktopIndex, 0, 0, "No GUI control, no clipboard reads.");
            heartbeat.Interval = 25;
            heartbeat.Tick += (_, _) => Heartbeat();
            heartbeat.Start();
            // The first UI message-loop heartbeat, not this constructor,
            // publishes READY. Hooks can register before the message pump
            // actually starts; a premature marker creates a prelaunch race.
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    private void Log(string kind, int desktopIndex, long hwnd, uint pid, string? detail = null)
    {
        log.WriteLine(JsonSerializer.Serialize(new
        {
            utc = DateTime.UtcNow.ToString("O"),
            elapsedMs = clock.ElapsedMilliseconds,
            kind,
            desktopIndex,
            hwnd,
            processId = pid,
            detail,
            notifications,
            heartbeatChanges,
            latchedAbort = policy.Aborted
        }));
    }

    private void Observe(int desktopIndex, string kind, string? detail = null, bool forceAbort = false)
    {
        bool alreadyAborted = policy.Aborted;
        // Foreground theft can precede a virtual Desktop2 switch. A forced
        // tripwire preserves the *actual* desktopIndex=0 in the event log.
        policy.Observe(forceAbort ? -1 : desktopIndex, kind);
        IntPtr front = GetForegroundWindow();
        GetWindowThreadProcessId(front, out uint pid);
        Log(kind, desktopIndex, front.ToInt64(), pid, detail);
        if (!alreadyAborted && policy.Aborted)
            File.WriteAllText(tripwireFile, JsonSerializer.Serialize(new
            {
                utc = DateTime.UtcNow.ToString("O"),
                firstReason = policy.FirstReason,
                expectedDesktopIndex = policy.ExpectedDesktopIndex,
                observedDesktopIndex = desktopIndex,
                outcome = "PAUSE_ALL_AGENT_INPUT_NO_AUTO_RETURN",
                attribution = "UNKNOWN_UNTIL_OWNER_CORRELATION"
            }));
    }

    private void CheckWatchedForeground(IntPtr hwnd, uint pid, int currentIndex)
    {
        if (watchedTargetFile == null || policy.Aborted || !File.Exists(watchedTargetFile))
            return;
        // The controller must create its manifest ATOMICALLY *after*
        // independently verifying ownership and real virtual Desktop2.
        // A malformed or partially written manifest causes fail-close.
        WatchedTarget? watched = JsonSerializer.Deserialize<WatchedTarget>(
            File.ReadAllText(watchedTargetFile),
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        if (watched == null || watched.Hwnd <= 0 || watched.ProcessId <= 0
            || watched.DesktopIndex < 1 || watched.DesktopIndex >= desktopCount)
            throw new InvalidOperationException("INVALID_WATCHED_DESKTOP2_TARGET");
        IntPtr foregroundRoot = hwnd == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hwnd, 2);
        if (IsWatchedForeground(foregroundRoot.ToInt64(), pid, currentIndex,
            watched.Hwnd, watched.ProcessId, watched.DesktopIndex))
        {
            // This is an EARLY focus-steal signal, not an assertion that
            // Windows already switched virtual desktops. Never auto-return.
            Observe(currentIndex, "TARGET_FOREGROUND_EARLY_ABORT",
                "watched_desktop_index=" + watched.DesktopIndex, forceAbort: true);
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == NotificationMessage)
        {
            notifications++;
            try
            {
                // VDA notification lParam encodes target zero-based desktop index.
                // Preserve both notification payload and a fresh VDA read because
                // the user can switch back before the message is handled.
                int eventDesktopIndex = unchecked((int)m.LParam.ToInt64());
                int oldDesktopIndex = unchecked((int)m.WParam.ToInt64());
                int current = vda.CurrentIndex();
                if (eventDesktopIndex >= 0 && eventDesktopIndex < desktopCount)
                    Observe(eventDesktopIndex, "VIRTUAL_DESKTOP_NOTIFICATION",
                        "old=" + oldDesktopIndex + " new=" + eventDesktopIndex + " current=" + current);
                else
                    Observe(-1, "VIRTUAL_DESKTOP_NOTIFICATION_INVALID_PAYLOAD", "payload=" + eventDesktopIndex);
                if (current != eventDesktopIndex)
                    Observe(current, "VIRTUAL_DESKTOP_NOTIFICATION_CURRENT_RECHECK");
            }
            catch (Exception ex)
            {
                // A broken monitor cannot authorize any GUI interaction.
                Observe(-1, "VIRTUAL_DESKTOP_NOTIFICATION_MONITOR_FAILED", ex.GetType().Name);
            }
        }
        base.WndProc(ref m);
    }

    private void WindowShown(IntPtr hook, uint kind, IntPtr hwnd, int objectId, int childId, uint thread, uint eventTime)
    {
        try
        {
            if (!strictPrelaunch || policy.Aborted || objectId != 0 || childId != 0)
                return;
            // Only top-level root windows; including dialogs the app may show
            // before its PID/HWND is known. This is deliberately conservative.
            if (hwnd == IntPtr.Zero || GetAncestor(hwnd, 2) != hwnd) return;
            int index = vda.CurrentIndex();
            Observe(index, "PRELAUNCH_VISIBLE_ROOT", forceAbort: true);
        }
        catch (Exception ex)
        {
            Observe(-1, "PRELAUNCH_SHOW_MONITOR_FAILED", ex.GetType().Name);
        }
    }

    private void ForegroundChanged(IntPtr hook, uint kind, IntPtr hwnd, int objectId, int childId, uint thread, uint eventTime)
    {
        try
        {
            if (objectId != 0 || childId != 0) return;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            int current = vda.CurrentIndex();
            // For external GUI startup, there is no target HWND yet. Trip
            // on ANY foreground change while on Desktop1, even from owner
            // activity; never leave the pre-HWND launch gap unprotected.
            Log("FOREGROUND_CHANGED", current, hwnd.ToInt64(), pid);
            if (strictPrelaunch && !policy.Aborted)
                Observe(current, "STRICT_PRELAUNCH_FOREGROUND_EARLY_ABORT", forceAbort: true);
            if (current != policy.ExpectedDesktopIndex)
                Observe(current, "FOREGROUND_CURRENT_DESKTOP");
            else
                CheckWatchedForeground(hwnd, pid, current);
        }
        catch (Exception ex)
        {
            // Missing hooks, invalid manifests and other monitor faults
            // cannot authorize one more UIA input operation.
            Observe(-1, "FOREGROUND_MONITOR_FAILED", ex.GetType().Name);
        }
    }

    private void Heartbeat()
    {
        try
        {
            int current = vda.CurrentIndex();
            if (current != policy.ExpectedDesktopIndex && !policy.Aborted)
            {
                heartbeatChanges++;
                Observe(current, "POLL_DESKTOP_CHANGE");
            }
            if (!policy.Aborted && current == policy.ExpectedDesktopIndex)
            {
                // Foreground hook is primary. This is a 25ms fallback when
                // a callback is late or missed during a focus transition.
                IntPtr front = GetForegroundWindow();
                if (strictPrelaunch && front != baselineForeground)
                    Observe(current, "STRICT_PRELAUNCH_FOREGROUND_POLL_ABORT", forceAbort: true);
                GetWindowThreadProcessId(front, out uint frontPid);
                CheckWatchedForeground(front, frontPid, current);
            }
            if (!readyPublished && !policy.Aborted
                && current == policy.ExpectedDesktopIndex)
            {
                // Reaching this point proves the actual WinForms message pump
                // is servicing callbacks, not merely that hooks registered.
                // Recheck the baseline immediately before publishing READY.
                if (strictPrelaunch && GetForegroundWindow() != baselineForeground)
                    Observe(current, "STRICT_READY_FOREGROUND_RECHECK_ABORT", forceAbort: true);
                if (!policy.Aborted)
                {
                    File.WriteAllText(readyFile, JsonSerializer.Serialize(new
                    {
                        processId = Environment.ProcessId,
                        expectedDesktopIndex = policy.ExpectedDesktopIndex,
                        firstStartUtc = DateTime.UtcNow,
                        eventLog = eventLogPath,
                        tripwireFile,
                        watchedTargetFile,
                        hasVirtualDesktopNotifications = true,
                        hasForegroundHook = true,
                        strictForegroundArmed = strictPrelaunch,
                        strictWindowShowArmed = strictPrelaunch && windowShowHook != IntPtr.Zero,
                        messagePumpRunning = true
                    }));
                    readyPublished = true;
                    Log("READY_AFTER_MESSAGE_PUMP", current, 0, 0);
                }
            }
            if (clock.ElapsedMilliseconds >= durationMs)
            {
                Log("END", current, 0, 0);
                Application.ExitThread();
            }
        }
        catch (Exception ex)
        {
            Observe(-1, "MONITOR_FAILURE", ex.GetType().Name);
            Application.ExitThread();
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        heartbeat.Stop();
        heartbeat.Dispose();
        if (foregroundHook != IntPtr.Zero) UnhookWinEvent(foregroundHook);
        if (windowShowHook != IntPtr.Zero) UnhookWinEvent(windowShowHook);
        if (registered) vda.Unregister(Handle);
        if (Handle != IntPtr.Zero) DestroyHandle();
        vda.Dispose();
        if (File.Exists(readyFile)) File.Delete(readyFile);
        log.Dispose();
    }
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--self-test")
        {
            SwitchPolicy p = new(0);
            bool safeInitial = p.Observe(0, "START");
            bool unsafeSwitch = p.Observe(1, "VIRTUAL_DESKTOP_NOTIFICATION");
            bool stillBlockedAfterReturn = p.Observe(0, "RETURNED_TO_DESKTOP1");
            bool invalidFailsClosed = new SwitchPolicy(0).Observe(-1, "UNAVAILABLE");
            bool pass = safeInitial && !unsafeSwitch && !stillBlockedAfterReturn && p.Aborted && !invalidFailsClosed;
            File.WriteAllText(args[1], JsonSerializer.Serialize(new {pass, safeInitial, unsafeSwitch,
                stillBlockedAfterReturn, invalidFailsClosed}));
            return pass ? 0 : 2;
        }
        // Pure policy test: NO desktop/window calls, foreground hooks, GUI
        // processes, input or listener registration.
        if (args.Length == 2 && args[0] == "--self-test-foreground")
        {
            bool target = DesktopEventListener.IsWatchedForeground(100, 42, 0, 100, 42, 1);
            bool otherPid = DesktopEventListener.IsWatchedForeground(100, 43, 0, 100, 42, 1);
            bool otherHwnd = DesktopEventListener.IsWatchedForeground(101, 42, 0, 100, 42, 1);
            bool ownerIsDesktop2 = DesktopEventListener.IsWatchedForeground(100, 42, 1, 100, 42, 1);
            bool targetNotDesktop2 = DesktopEventListener.IsWatchedForeground(100, 42, 0, 100, 42, 0);
            SwitchPolicy p = new(0);
            p.Observe(target ? -1 : 0, "TARGET_FOREGROUND_EARLY_ABORT");
            bool stillBlockedAfterReturn = !p.Observe(0, "SAFE_AGAIN");
            bool pass = target && !otherPid && !otherHwnd && !ownerIsDesktop2
                && !targetNotDesktop2 && p.Aborted && stillBlockedAfterReturn;
            File.WriteAllText(args[1], JsonSerializer.Serialize(new
            {
                pass, target, otherPid, otherHwnd, ownerIsDesktop2,
                targetNotDesktop2, stillBlockedAfterReturn
            }));
            return pass ? 0 : 2;
        }
        // The optional TARGET mode watches an atomically published file
        // containing verified Desktop2 root HWND + PID; early focus theft
        // latches before the virtual-desktop transition where observable.
        bool targetMode = args.Length == 6 && args[0] == "--observe-target";
        bool strictLaunch = args.Length == 6 && args[0] == "--observe-strict-launch";
        bool idle = args.Length == 6 && args[0] == "--observe-idle";
        bool synthetic = args.Length == 6 && args[0] == "--self-test-notification";
        if (!targetMode && !strictLaunch && !idle && !synthetic && (args.Length != 5 || args[0] != "--observe"))
            return 2;
        int seconds = targetMode || strictLaunch ? 900 : 90; // 15-minute max; supervisor must fail closed at expiry.
        if ((idle || synthetic) && (!int.TryParse(args[5], out seconds) || seconds is < 5 or > 15))
            return 2;
        try
        {
            using DesktopEventListener observer = new(args[1], args[2], args[3], args[4],
                seconds, targetMode || strictLaunch ? args[5] : null, strictLaunch);
            if (synthetic)
                observer.PostSyntheticNotificationForSelfTest();
            Application.Run();
            if (synthetic)
            {
                // Only the observer's own HWND receives a simulated message;
                // the real Windows active desktop remains unchanged.
                bool latched = File.Exists(args[4]);
                using FileStream stream = new(args[2], FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                using StreamReader reader = new(stream);
                string log = reader.ReadToEnd();
                bool delivered = log.Contains("VIRTUAL_DESKTOP_NOTIFICATION")
                    && log.Contains("VIRTUAL_DESKTOP_NOTIFICATION_CURRENT_RECHECK")
                    && log.Contains("END");
                return latched && delivered ? 0 : 4;
            }
            return 0;
        }
        catch (Exception ex)
        {
            // The listener has no console: persist startup/ABI failures locally.
            try { File.WriteAllText(args[2] + ".startup-error.txt", ex.ToString()); } catch { }
            return 3;
        }
    }
}
