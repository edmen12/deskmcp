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
    private const uint WinEventOutOfContext = 0;
    private const uint WinEventSkipOwnProcess = 2;
    private readonly NativeVirtualDesktopApi vda;
    private readonly StreamWriter log;
    private readonly string readyFile;
    private readonly string tripwireFile;
    private readonly SwitchPolicy policy;
    private readonly int desktopCount;
    private readonly WinEventProc foregroundCallback;
    private readonly System.Windows.Forms.Timer heartbeat = new();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly int durationMs;
    private IntPtr foregroundHook;
    private bool registered;
    private bool disposed;
    private int notifications;
    private int heartbeatChanges;

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint thread, uint eventTime);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
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

    public DesktopEventListener(string dll, string eventsFile, string ready, string tripwire, int seconds)
    {
        if (seconds is < 5 or > 900) throw new ArgumentOutOfRangeException(nameof(seconds));
        durationMs = checked(seconds * 1000);
        readyFile = ready;
        tripwireFile = tripwire;
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
            foregroundHook = SetWinEventHook(ForegroundEvent, ForegroundEvent, IntPtr.Zero,
                foregroundCallback, 0, 0, WinEventOutOfContext | WinEventSkipOwnProcess);
            if (foregroundHook == IntPtr.Zero)
                throw new InvalidOperationException("Cannot register foreground event observer.");
            Log("START", policy.ExpectedDesktopIndex, 0, 0, "No GUI control, no clipboard reads.");
            heartbeat.Interval = 25;
            heartbeat.Tick += (_, _) => Heartbeat();
            heartbeat.Start();
            File.WriteAllText(readyFile, JsonSerializer.Serialize(new
            {
                processId = Environment.ProcessId,
                expectedDesktopIndex = policy.ExpectedDesktopIndex,
                firstStartUtc = DateTime.UtcNow,
                eventLog = eventsFile,
                tripwireFile,
                hasVirtualDesktopNotifications = true,
                hasForegroundHook = true
            }));
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

    private void Observe(int desktopIndex, string kind, string? detail = null)
    {
        bool alreadyAborted = policy.Aborted;
        policy.Observe(desktopIndex, kind);
        IntPtr front = GetForegroundWindow();
        GetWindowThreadProcessId(front, out uint pid);
        Log(kind, desktopIndex, front.ToInt64(), pid, detail);
        // A user's own switch also pauses test actions: it is not accused of being agent-caused.
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

    private void ForegroundChanged(IntPtr hook, uint kind, IntPtr hwnd, int objectId, int childId, uint thread, uint eventTime)
    {
        try
        {
            if (objectId != 0 || childId != 0) return;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            int current = vda.CurrentIndex();
            bool already = policy.Aborted;
            policy.Observe(current, "FOREGROUND_CURRENT_DESKTOP");
            Log("FOREGROUND_CHANGED", current, hwnd.ToInt64(), pid);
            if (!already && policy.Aborted)
                File.WriteAllText(tripwireFile, JsonSerializer.Serialize(new
                {
                    utc = DateTime.UtcNow.ToString("O"),
                    outcome = "PAUSE_ALL_AGENT_INPUT_NO_AUTO_RETURN",
                    expectedDesktopIndex = policy.ExpectedDesktopIndex,
                    observedDesktopIndex = current,
                    attribution = "UNKNOWN_UNTIL_OWNER_CORRELATION"
                }));
        }
        catch (Exception ex) { Log("OBSERVER_ERROR", -1, 0, 0, ex.GetType().Name); }
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
        // Idle-only passive smoke test: bounded runtime without any desktop
        // switch, window placement, GUI creation, automation or injected input.
        bool idle = args.Length == 6 && args[0] == "--observe-idle";
        bool synthetic = args.Length == 6 && args[0] == "--self-test-notification";
        if (!idle && !synthetic && (args.Length != 5 || args[0] != "--observe"))
            return 2;
        int seconds = 90;
        if ((idle || synthetic) && (!int.TryParse(args[5], out seconds) || seconds is < 5 or > 15))
            return 2;
        try
        {
            using DesktopEventListener observer = new(args[1], args[2], args[3], args[4], seconds);
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
