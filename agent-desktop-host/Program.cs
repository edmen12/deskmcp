using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;

namespace DeskMCP.AgentDesktopHost;

internal static class Program
{
    private static readonly Guid ClsidVirtualDesktopManager = new("AA509086-5CA9-4C25-8F95-589D3C07B48A");

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

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetDesktopCountDelegate();

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate Guid GetDesktopIdByNumberDelegate(int desktopNumber);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int MoveWindowToDesktopNumberDelegate(IntPtr hwnd, int desktopNumber);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int CreateDesktopDelegate();

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int RemoveDesktopDelegate(int removeDesktopNumber, int fallbackDesktopNumber);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetWindowDesktopNumberDelegate(IntPtr hwnd);

    private sealed class VirtualDesktopAccessor : IDisposable
    {
        private IntPtr library;
        private readonly GetCurrentDesktopNumberDelegate? getCurrentDesktopNumber;
        private readonly GetDesktopCountDelegate? getDesktopCount;
        private readonly GetDesktopIdByNumberDelegate? getDesktopIdByNumber;
        private readonly MoveWindowToDesktopNumberDelegate? moveWindowToDesktopNumber;
        private readonly CreateDesktopDelegate? createDesktop;
        private readonly RemoveDesktopDelegate? removeDesktop;
        private readonly GetWindowDesktopNumberDelegate? getWindowDesktopNumber;

        public bool Available => library != IntPtr.Zero;
        public string? Path { get; }

        public VirtualDesktopAccessor()
        {
            string configured = (Environment.GetEnvironmentVariable("DESKTOP_MCP_VDA_PATH") ?? String.Empty).Trim();
            string candidate = String.IsNullOrWhiteSpace(configured)
                ? System.IO.Path.Combine(AppContext.BaseDirectory, "virtual-desktop-accessor", "VirtualDesktopAccessor.dll")
                : System.IO.Path.GetFullPath(configured);
            Path = candidate;
            if (!File.Exists(candidate) || !NativeLibrary.TryLoad(candidate, out library)) return;
            try
            {
                getCurrentDesktopNumber = Load<GetCurrentDesktopNumberDelegate>("GetCurrentDesktopNumber");
                getDesktopCount = Load<GetDesktopCountDelegate>("GetDesktopCount");
                getDesktopIdByNumber = Load<GetDesktopIdByNumberDelegate>("GetDesktopIdByNumber");
                moveWindowToDesktopNumber = Load<MoveWindowToDesktopNumberDelegate>("MoveWindowToDesktopNumber");
                createDesktop = Load<CreateDesktopDelegate>("CreateDesktop");
                removeDesktop = Load<RemoveDesktopDelegate>("RemoveDesktop");
                getWindowDesktopNumber = Load<GetWindowDesktopNumberDelegate>("GetWindowDesktopNumber");
            }
            catch
            {
                NativeLibrary.Free(library);
                library = IntPtr.Zero;
            }
        }

        private T Load<T>(string name) where T : Delegate
        {
            IntPtr export = NativeLibrary.GetExport(library, name);
            return Marshal.GetDelegateForFunctionPointer<T>(export);
        }

        public int? CurrentDesktopNumber()
        {
            if (getCurrentDesktopNumber == null) return null;
            int value = getCurrentDesktopNumber();
            return value >= 0 ? value : null;
        }

        public int? DesktopCount()
        {
            if (getDesktopCount == null) return null;
            int value = getDesktopCount();
            return value >= 0 ? value : null;
        }

        public Guid? DesktopIdByNumber(int desktopNumber)
        {
            if (getDesktopIdByNumber == null || desktopNumber < 0) return null;
            Guid value = getDesktopIdByNumber(desktopNumber);
            return value == Guid.Empty ? null : value;
        }

        public int? DesktopNumberById(Guid desktopId)
        {
            int? count = DesktopCount();
            if (!count.HasValue) return null;
            for (int index = 0; index < count.Value; index++)
            {
                Guid? candidate = DesktopIdByNumber(index);
                if (candidate.HasValue && candidate.Value == desktopId) return index;
            }
            return null;
        }

        public bool MoveWindowToDesktopNumber(IntPtr hwnd, int desktopNumber)
        {
            if (moveWindowToDesktopNumber == null || desktopNumber < 0) return false;
            return moveWindowToDesktopNumber(hwnd, desktopNumber) == 1;
        }

        public int? CreateDesktop()
        {
            if (createDesktop == null) return null;
            int value = createDesktop();
            return value >= 0 ? value : null;
        }

        public bool RemoveDesktop(int removeDesktopNumber, int fallbackDesktopNumber)
        {
            if (removeDesktop == null) return false;
            return removeDesktop(removeDesktopNumber, fallbackDesktopNumber) == 1;
        }

        public int? WindowDesktopNumber(IntPtr hwnd)
        {
            if (getWindowDesktopNumber == null) return null;
            int value = getWindowDesktopNumber(hwnd);
            return value >= 0 ? value : null;
        }

        public void Dispose()
        {
            if (library == IntPtr.Zero) return;
            NativeLibrary.Free(library);
            library = IntPtr.Zero;
        }
    }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr hwnd, int command);

    private const int SwShowNoActivate = 4;
    private const int SwRestore = 9;

    public static int Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Agent Desktop is only available on Windows.");
            if (args.Length == 0) throw new ArgumentException("Missing Agent Desktop host command.");
            string command = args[0].Trim().ToLowerInvariant();
            Dictionary<string, string> options = ParseOptions(args, 1);
            using VirtualDesktopAccessor vda = new();
            object result = command switch
            {
                "info" => Info(vda),
                "current-desktop" => CurrentDesktop(vda),
                "desktop-info" => DesktopInfo(ParsePositiveInt(Required(options, "desktop-number"), "desktop-number", allowZero: true), vda),
                "create-desktop" => CreateDesktop(vda),
                "remove-desktop" => RemoveDesktop(ParsePositiveInt(Required(options, "desktop-number"), "desktop-number", allowZero: true), ParsePositiveInt(Required(options, "fallback-number"), "fallback-number", allowZero: true), vda),
                "window-info" => WindowInfo(ParseHwnd(Required(options, "hwnd")), vda),
                "move-window" => MoveWindow(ParseHwnd(Required(options, "hwnd")), ParseDesktopId(Required(options, "desktop-id")), options.ContainsKey("restore"), options.ContainsKey("show-no-activate"), vda),
                "move-process" => MoveProcess(ParsePositiveInt(Required(options, "pid"), "pid"), ParseDesktopId(Required(options, "desktop-id")), ParseTimeout(options), options.ContainsKey("restore"), options.ContainsKey("show-no-activate"), vda),
                "self-test" => SelfTest(vda),
                _ => throw new ArgumentException("Unsupported Agent Desktop host command.")
            };
            Console.Out.Write(JsonSerializer.Serialize(result));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.Write(error.Message);
            return 1;
        }
    }

    private static object Info(VirtualDesktopAccessor vda)
    {
        return new
        {
            officialApi = true,
            virtualDesktopAccessor = vda.Available,
            currentDesktopNumber = vda.CurrentDesktopNumber(),
            desktopCount = vda.DesktopCount()
        };
    }

    private static object CurrentDesktop(VirtualDesktopAccessor vda)
    {
        if (!vda.Available)
            throw new InvalidOperationException("VirtualDesktopAccessor is required to resolve the current virtual desktop.");
        int? desktopNumber = vda.CurrentDesktopNumber();
        int? desktopCount = vda.DesktopCount();
        if (!desktopNumber.HasValue || !desktopCount.HasValue || desktopNumber.Value < 0 || desktopNumber.Value >= desktopCount.Value)
            throw new InvalidOperationException("Windows did not report a valid current virtual desktop.");
        Guid? desktopId = vda.DesktopIdByNumber(desktopNumber.Value);
        if (!desktopId.HasValue)
            throw new InvalidOperationException("Windows did not report the current virtual desktop id.");
        return new
        {
            desktopId = desktopId.Value.ToString("D"),
            desktopNumber = desktopNumber.Value,
            desktopCount = desktopCount.Value
        };
    }

    private static object DesktopInfo(int desktopNumber, VirtualDesktopAccessor vda)
    {
        if (!vda.Available)
            throw new InvalidOperationException("VirtualDesktopAccessor is required to resolve a virtual desktop by number.");
        int? desktopCount = vda.DesktopCount();
        if (!desktopCount.HasValue || desktopNumber < 0 || desktopNumber >= desktopCount.Value)
            throw new ArgumentOutOfRangeException(nameof(desktopNumber), "Requested virtual desktop number does not exist.");
        Guid? desktopId = vda.DesktopIdByNumber(desktopNumber);
        if (!desktopId.HasValue)
            throw new InvalidOperationException("Windows did not report the requested virtual desktop id.");
        return new
        {
            desktopId = desktopId.Value.ToString("D"),
            desktopNumber,
            desktopCount = desktopCount.Value,
            currentDesktopNumber = vda.CurrentDesktopNumber()
        };
    }

    private static object CreateDesktop(VirtualDesktopAccessor vda)
    {
        if (!vda.Available)
            throw new InvalidOperationException("VirtualDesktopAccessor is required to create a virtual desktop.");
        int? beforeCurrent = vda.CurrentDesktopNumber();
        int? beforeCount = vda.DesktopCount();
        int? desktopNumber = vda.CreateDesktop();
        if (!desktopNumber.HasValue)
            throw new InvalidOperationException("Windows did not create a virtual desktop.");
        int? desktopCount = vda.DesktopCount();
        Guid? desktopId = vda.DesktopIdByNumber(desktopNumber.Value);
        if (!desktopId.HasValue)
            throw new InvalidOperationException("Windows created a virtual desktop but did not report its id.");
        int? afterCurrent = vda.CurrentDesktopNumber();
        return new
        {
            desktopId = desktopId.Value.ToString("D"),
            desktopNumber = desktopNumber.Value,
            desktopCount,
            currentDesktopBefore = beforeCurrent,
            currentDesktopAfter = afterCurrent,
            desktopCountBefore = beforeCount
        };
    }

    private static object RemoveDesktop(int desktopNumber, int fallbackNumber, VirtualDesktopAccessor vda)
    {
        if (!vda.Available)
            throw new InvalidOperationException("VirtualDesktopAccessor is required to remove a virtual desktop.");
        if (desktopNumber == fallbackNumber)
            throw new ArgumentException("Agent Desktop removal requires a different fallback desktop.");
        int? current = vda.CurrentDesktopNumber();
        if (current == desktopNumber)
            throw new InvalidOperationException("Refusing to remove the currently active virtual desktop.");
        if (!vda.RemoveDesktop(desktopNumber, fallbackNumber))
            throw new InvalidOperationException("Windows did not remove the requested virtual desktop.");
        return new { removed = true, desktopNumber, fallbackNumber, desktopCount = vda.DesktopCount(), currentDesktopNumber = vda.CurrentDesktopNumber() };
    }

    private static object WindowInfo(IntPtr hwnd, VirtualDesktopAccessor vda)
    {
        EnsureWindow(hwnd);
        IVirtualDesktopManager manager = CreateManager();
        try
        {
            Guid desktopId = manager.GetWindowDesktopId(hwnd);
            bool current = manager.IsWindowOnCurrentVirtualDesktop(hwnd);
            return new
            {
                hwnd = HwndText(hwnd),
                desktopId = desktopId.ToString("D"),
                desktopNumber = vda.WindowDesktopNumber(hwnd),
                onCurrentDesktop = current
            };
        }
        finally
        {
            if (Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager);
        }
    }

    private static object MoveWindow(IntPtr hwnd, Guid desktopId, bool restore, bool showNoActivate, VirtualDesktopAccessor vda)
    {
        EnsureWindow(hwnd);
        if (restore && showNoActivate)
            throw new ArgumentException("restore and show-no-activate cannot be combined.");
        if (!vda.Available)
            throw new InvalidOperationException("VirtualDesktopAccessor is required to move another process to Agent Desktop.");
        int? desktopNumber = vda.DesktopNumberById(desktopId);
        if (!desktopNumber.HasValue)
            throw new InvalidOperationException("Agent Desktop id is not present in the current Windows virtual desktop set.");
        MoveWindowCore(hwnd, desktopId, desktopNumber.Value, restore, showNoActivate, vda);
        return WindowInfo(hwnd, vda);
    }

    private static object MoveProcess(int processId, Guid desktopId, int timeoutMs, bool restore, bool showNoActivate, VirtualDesktopAccessor vda)
    {
        if (restore && showNoActivate)
            throw new ArgumentException("restore and show-no-activate cannot be combined.");
        if (!vda.Available)
            throw new InvalidOperationException("VirtualDesktopAccessor is required to move another process to Agent Desktop.");
        int? desktopNumber = vda.DesktopNumberById(desktopId);
        if (!desktopNumber.HasValue)
            throw new InvalidOperationException("Agent Desktop id is not present in the current Windows virtual desktop set.");

        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        List<IntPtr> moved = new();
        do
        {
            foreach (IntPtr hwnd in EnumerateTopLevelWindows(processId))
            {
                if (moved.Contains(hwnd)) continue;
                try
                {
                    MoveWindowCore(hwnd, desktopId, desktopNumber.Value, restore, showNoActivate, vda);
                    moved.Add(hwnd);
                }
                catch (InvalidOperationException) { }
            }
            if (moved.Count > 0) break;
            Thread.Sleep(75);
        } while (DateTime.UtcNow < deadline);

        if (moved.Count == 0)
            throw new TimeoutException("No movable top-level window appeared for the requested process before timeout.");

        List<object> windows = new();
        foreach (IntPtr hwnd in moved)
        {
            windows.Add(new
            {
                hwnd = HwndText(hwnd),
                desktopId = GetDesktopId(hwnd).ToString("D"),
                desktopNumber = vda.WindowDesktopNumber(hwnd)
            });
        }
        return new { processId, moved = moved.Count, windows };
    }

    private static object SelfTest(VirtualDesktopAccessor vda)
    {
        IVirtualDesktopManager manager = CreateManager();
        if (Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager);
        return new
        {
            ok = true,
            officialApi = true,
            virtualDesktopAccessor = vda.Available,
            currentDesktopNumber = vda.CurrentDesktopNumber(),
            desktopCount = vda.DesktopCount()
        };
    }

    private static void MoveWindowCore(IntPtr hwnd, Guid desktopId, int desktopNumber, bool restore, bool showNoActivate, VirtualDesktopAccessor vda)
    {
        if (!vda.MoveWindowToDesktopNumber(hwnd, desktopNumber))
            throw new InvalidOperationException("VirtualDesktopAccessor could not move the target window.");

        int? actualNumber = vda.WindowDesktopNumber(hwnd);
        if (actualNumber.HasValue && actualNumber.Value != desktopNumber)
            throw new InvalidOperationException("Windows reported a different virtual desktop number after the move.");

        Guid actual = GetDesktopId(hwnd);
        if (actual != desktopId)
            throw new InvalidOperationException("Windows reported a different virtual desktop after the move.");
        if (restore) ShowWindow(hwnd, SwRestore);
        else if (showNoActivate) ShowWindow(hwnd, SwShowNoActivate);
    }

    private static Guid GetDesktopId(IntPtr hwnd)
    {
        IVirtualDesktopManager manager = CreateManager();
        try { return manager.GetWindowDesktopId(hwnd); }
        finally { if (Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager); }
    }

    private static IVirtualDesktopManager CreateManager()
    {
        Type type = Type.GetTypeFromCLSID(ClsidVirtualDesktopManager, throwOnError: true)
            ?? throw new InvalidOperationException("Windows VirtualDesktopManager COM class is unavailable.");
        object instance = Activator.CreateInstance(type)
            ?? throw new InvalidOperationException("Windows VirtualDesktopManager COM class could not be created.");
        return (IVirtualDesktopManager)instance;
    }

    private static List<IntPtr> EnumerateTopLevelWindows(int processId)
    {
        List<IntPtr> windows = new();
        EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd)) return true;
            GetWindowThreadProcessId(hwnd, out uint owner);
            if (owner == (uint)processId) windows.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    private static void EnsureWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) throw new ArgumentException("Target HWND is not a live Windows top-level window.");
    }

    private static Dictionary<string, string> ParseOptions(string[] args, int start)
    {
        Dictionary<string, string> options = new(StringComparer.OrdinalIgnoreCase);
        for (int i = start; i < args.Length; i++)
        {
            string item = args[i];
            if (!item.StartsWith("--", StringComparison.Ordinal)) throw new ArgumentException("Invalid Agent Desktop host argument.");
            string name = item.Substring(2);
            if (name == "restore" || name == "show-no-activate") { options[name] = "true"; continue; }
            if (i + 1 >= args.Length) throw new ArgumentException("Incomplete Agent Desktop host argument.");
            options[name] = args[++i];
        }
        return options;
    }

    private static string Required(Dictionary<string, string> options, string name)
    {
        if (!options.TryGetValue(name, out string? value) || String.IsNullOrWhiteSpace(value))
            throw new ArgumentException("Missing --" + name + ".");
        return value;
    }

    private static IntPtr ParseHwnd(string value)
    {
        ulong raw;
        if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            if (!UInt64.TryParse(value.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out raw))
                throw new ArgumentException("Invalid HWND.");
        }
        else if (!UInt64.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out raw))
            throw new ArgumentException("Invalid HWND.");
        if (raw == 0 || raw > Int64.MaxValue) throw new ArgumentException("Invalid HWND.");
        return new IntPtr(unchecked((long)raw));
    }

    private static Guid ParseDesktopId(string value)
    {
        if (!Guid.TryParse(value, out Guid result) || result == Guid.Empty) throw new ArgumentException("Invalid desktop id.");
        return result;
    }

    private static int ParsePositiveInt(string value, string name, bool allowZero = false)
    {
        if (!Int32.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int result) || (allowZero ? result < 0 : result <= 0))
            throw new ArgumentException("Invalid " + name + ".");
        return result;
    }

    private static int ParseTimeout(Dictionary<string, string> options)
    {
        if (!options.TryGetValue("timeout-ms", out string? raw)) return 5000;
        if (!Int32.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value) || value < 100 || value > 30000)
            throw new ArgumentException("timeout-ms must be between 100 and 30000.");
        return value;
    }

    private static string HwndText(IntPtr hwnd) => "0x" + unchecked((ulong)hwnd.ToInt64()).ToString("X", CultureInfo.InvariantCulture);
}
