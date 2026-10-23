using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

// Passive, candidate-only observer. NEVER foreground, move, manipulate,
// or grant a control lease. It reads installed control.json and only inspects
// two exact DeskMCP safety window titles; unrelated windows are ignored.
internal static class Program
{
    private const string Edge = "DeskMCP Agent Desktop Edge";
    private const string Hud = "DeskMCP Agent Desktop Control";
    private static readonly Guid Clsid = new("AA509086-5CA9-4C25-8F95-589D3C07B48A");

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
    private interface IVirtualDesktopManager
    {
        [return: MarshalAs(UnmanagedType.Bool)]
        bool IsWindowOnCurrentVirtualDesktop(IntPtr hwnd);
        Guid GetWindowDesktopId(IntPtr hwnd);
        void MoveWindowToDesktop(IntPtr hwnd, ref Guid desktopId);
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetCurrentDesktopNumber();

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lparam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lparam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetWindowTextW")]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("dwmapi.dll", PreserveSig=true)]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute,
        out int value, int cbAttribute);

    private static IntPtr initialEdgeHwnd = IntPtr.Zero;
    private static IntPtr initialHudHwnd = IntPtr.Zero;
    private sealed record Lease(Guid Desktop, int Generation, bool Active);
    private sealed record WindowState(string Affinity, string CurrentVisibility, bool WpfVisible,
        int MatchingWindows, bool? SameOriginalHandle, bool? Layered,
        bool? NoActivate, bool? ToolWindow, bool? Topmost,
        int? DwmCloaked);

    private static Lease? ReadLease(string file)
    {
        try
        {
            using JsonDocument parsed = JsonDocument.Parse(File.ReadAllText(file));
            JsonElement root = parsed.RootElement;
            int generation = root.GetProperty("generation").GetInt32();
            JsonElement list = root.GetProperty("controls");
            if (list.GetArrayLength() != 1) return new(Guid.Empty, generation, false);
            var control = list[0];
            if (control.GetProperty("active").GetBoolean()
                && control.GetProperty("desktopNumber").GetInt32() == 2
                && Guid.TryParse(control.GetProperty("desktopId").GetString(), out Guid id)
                && id != Guid.Empty)
                return new(id, generation, true);
            return new(Guid.Empty, generation, false);
        }
        catch { return null; }
    }

    private static bool IsDeskMcpOwned(IntPtr hwnd)
    {
        GetWindowThreadProcessId(hwnd, out uint pid);
        if (pid == 0 || pid > int.MaxValue) return false;
        try
        {
            using var process = Process.GetProcessById((int)pid);
            return process.ProcessName.StartsWith("DeskMCP", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    private static (WindowState edge, WindowState hud) Inspect(IVirtualDesktopManager manager, Guid expected)
    {
        var edgeHandles = new List<IntPtr>();
        var hudHandles = new List<IntPtr>();
        // Exact-title allowlist; neither other window metadata nor titles are persisted.
        EnumWindows((hwnd, _) =>
        {
            StringBuilder title = new(256);
            GetWindowText(hwnd, title, title.Capacity);
            string name = title.ToString();
            if ((name == Edge || name == Hud) && IsDeskMcpOwned(hwnd))
            {
                if (name == Edge) edgeHandles.Add(hwnd);
                else hudHandles.Add(hwnd);
            }
            return true;
        }, IntPtr.Zero);

        WindowState Categorize(List<IntPtr> handles, bool isEdge)
        {
            if (handles.Count != 1) return new(handles.Count == 0 ? "window_missing" : "ambiguous_windows",
                "not_checked", false, handles.Count, null, null, null, null, null, null);
            IntPtr hwnd = handles[0];
            ref IntPtr initialHwnd = ref (isEdge ? ref initialEdgeHwnd : ref initialHudHwnd);
            if (initialHwnd == IntPtr.Zero) initialHwnd = hwnd;
            long style = GetWindowLongPtr(hwnd, -20).ToInt64();
            string category;
            try
            {
                Guid actual = manager.GetWindowDesktopId(hwnd);
                category = actual == Guid.Empty ? "desktop_id_unresolved"
                    : actual == expected ? "correct_desktop" : "wrong_desktop";
            }
            catch (COMException error)
            {
                category = "com_hresult_0x" + unchecked((uint)error.ErrorCode).ToString("X8");
            }
            catch { category = "desktop_query_failed"; }

            string isCurrent;
            try { isCurrent = manager.IsWindowOnCurrentVirtualDesktop(hwnd) ? "on_owner_desktop" : "not_on_owner_desktop"; }
            catch (COMException error) { isCurrent = "com_hresult_0x" + unchecked((uint)error.ErrorCode).ToString("X8"); }
            catch { isCurrent = "visibility_query_failed"; }
            int dwmResult = DwmGetWindowAttribute(hwnd, 14, out int dwmCloaked, sizeof(int));
            return new(category, isCurrent, IsWindowVisible(hwnd), 1,
                hwnd == initialHwnd,
                (style & 0x80000L) != 0, // WS_EX_LAYERED
                (style & 0x08000000L) != 0, // WS_EX_NOACTIVATE
                (style & 0x80L) != 0, // WS_EX_TOOLWINDOW
                (style & 0x8L) != 0, // WS_EX_TOPMOST
                dwmResult == 0 ? dwmCloaked : null);
        }

        return (Categorize(edgeHandles, true), Categorize(hudHandles, false));
    }

    [STAThread]
    private static int Main(string[] args)
    {
        bool prearm = args.Length == 5 && args[4] == "WAIT_NEXT_LEASE_READ_ONLY";
        if ((!prearm && args.Length != 4) || !int.TryParse(args[2], out int seconds) || seconds < 15 || seconds > 150)
        {
            Console.Error.WriteLine("EXACT_PASSIVE_OBSERVER_ARGUMENTS_REQUIRED");
            return 9;
        }

        string controlPath = Path.GetFullPath(args[0]);
        string vdaPath = Path.GetFullPath(args[1]);
        string outputPath = Path.GetFullPath(args[3]);
        if (!File.Exists(controlPath) || !File.Exists(vdaPath)
            || !controlPath.EndsWith(Path.Combine("agent-desktop", "control.json"), StringComparison.OrdinalIgnoreCase)
            || !outputPath.Contains("agent-desktop-hud-affinity-observer", StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine("OBSERVATION_PATH_GUARD_FAILED");
            return 9;
        }
        Lease? initial = ReadLease(controlPath);
        if (prearm && initial is not { Active: false })
        {
            Console.Error.WriteLine("PREARM_REQUIRES_FREE_AGENT_DESKTOP");
            return 9;
        }
        if (!prearm && initial is not { Active: true })
        {
            Console.Error.WriteLine("HUD_LEASE_NOT_ACTIVE");
            return 9;
        }

        IntPtr dll = IntPtr.Zero;
        IVirtualDesktopManager? manager = null;
        try
        {
            dll = NativeLibrary.Load(vdaPath);
            var current = Marshal.GetDelegateForFunctionPointer<GetCurrentDesktopNumber>(
                NativeLibrary.GetExport(dll, "GetCurrentDesktopNumber"));
            if (current() != 0)
            {
                Console.Error.WriteLine("OWNER_NOT_DESKTOP1_PRECHECK");
                return 9;
            }

            if (prearm)
            {
                int previousGeneration = initial!.Generation;
                Stopwatch startup = Stopwatch.StartNew();
                Console.WriteLine("PASSIVE_OBSERVER_ARMED_FOR_NEXT_LEASE");
                initial = null;
                while (startup.Elapsed < TimeSpan.FromSeconds(24))
                {
                    if (current() != 0) throw new InvalidOperationException("OWNER_DESKTOP_CHANGED_WHILE_ARMED");
                    Lease? observed = ReadLease(controlPath);
                    if (observed is { Active: true } && observed.Generation > previousGeneration)
                    {
                        initial = observed;
                        break;
                    }
                    Thread.Sleep(25);
                }
                if (initial is not { Active: true })
                {
                    Console.Error.WriteLine("WAIT_FOR_NEXT_LEASE_TIMED_OUT");
                    return 9;
                }
            }
            Lease baseline = initial is { Active: true } ? initial
                : throw new InvalidOperationException("ACTIVE_LEASE_NOT_OBSERVED");
            manager = (IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(Clsid, true)!)!;
            Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
            using StreamWriter log = new(outputPath, append:false, new UTF8Encoding(false)) {AutoFlush = true};
            Stopwatch elapsed = Stopwatch.StartNew();
            int samples = 0;
            int failures = 0;
            string? previous = null;
            int exit = 0;
            while (elapsed.Elapsed.TotalSeconds < seconds)
            {
                Lease? live = ReadLease(controlPath);
                int owner = current();
                bool leaseActive = live?.Active == true
                    && live.Desktop == baseline.Desktop
                    && live.Generation == baseline.Generation;
                var windows = Inspect(manager, baseline.Desktop);
                var state = new
                {
                    timestamp = DateTime.UtcNow.ToString("O"),
                    elapsed_ms = elapsed.ElapsedMilliseconds,
                    owner_desktop1 = owner == 0,
                    lease_active = leaseActive,
                    generation_changed = live?.Generation != baseline.Generation,
                    edge = windows.edge,
                    hud = windows.hud
                };
                string key = JsonSerializer.Serialize(new {state.owner_desktop1, state.lease_active,
                    state.generation_changed, state.edge, state.hud});
                // Keep transition and 1-second heartbeat; also retain the final loss sample.
                if (samples % 10 == 0 || key != previous || !leaseActive || owner != 0)
                {
                    log.WriteLine(JsonSerializer.Serialize(state));
                    previous = key;
                }
                samples++;
                if (windows.edge.Affinity != "correct_desktop" || windows.hud.Affinity != "correct_desktop") failures++;
                if (owner != 0) { exit = 4; break; }
                if (!leaseActive) { exit = 2; break; }
                Thread.Sleep(100);
            }
            Console.WriteLine(JsonSerializer.Serialize(new {
                status = exit == 0 ? "PASSIVE_WINDOW_OBSERVER_COMPLETED" :
                    exit == 2 ? "LEASE_LOST_DURING_PASSIVE_WINDOW_OBSERVATION" : "OWNER_DESKTOP_CHANGED",
                duration_ms = elapsed.ElapsedMilliseconds,
                samples, window_anomaly_samples = failures, output_path = outputPath,
                no_input_or_gui_actions = true
            }));
            return exit;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine("PASSIVE_OBSERVER_FAILED " + exception.GetType().Name);
            return 5;
        }
        finally
        {
            if (manager != null && Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager);
            if (dll != IntPtr.Zero) NativeLibrary.Free(dll);
        }
    }
}
