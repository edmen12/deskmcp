// Owned WinForms fixture read-only Win32 child-window evidence.
// Never sends a window message, synthesizes input, activates a window, or reads text.
// Not a general-purpose remote HWND inspection endpoint.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal static class Program
{
    private const uint GaRoot = 2;
    private const int GwlStyle = -16;
    private const long EsMultiline = 0x0004, EsPassword = 0x0020, EsReadOnly = 0x0800;
    private const int MaxChildren = 128;
    private delegate bool EnumChildCallback(IntPtr hwnd, IntPtr context);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumChildWindows(IntPtr parent, EnumChildCallback callback, IntPtr context);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint kind);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);

    private static string Class(IntPtr hwnd)
    {
        StringBuilder buffer = new(256);
        if (GetClassName(hwnd, buffer, buffer.Capacity) < 1)
            throw new InvalidOperationException("WINDOW_CLASS_UNAVAILABLE");
        return buffer.ToString();
    }

    private static string? Kind(string klass)
    {
        if (klass.Equals("Edit", StringComparison.OrdinalIgnoreCase)
            || klass.StartsWith("WindowsForms10.Edit.", StringComparison.OrdinalIgnoreCase)) return "edit";
        if (klass.Equals("Button", StringComparison.OrdinalIgnoreCase)
            || klass.StartsWith("WindowsForms10.Button.", StringComparison.OrdinalIgnoreCase)) return "button";
        if (klass.Equals("ListBox", StringComparison.OrdinalIgnoreCase)
            || klass.StartsWith("WindowsForms10.ListBox.", StringComparison.OrdinalIgnoreCase)) return "list";
        return null;
    }

    private static object Verify(IntPtr child, IntPtr root, int pid, string expectedKind,
        IReadOnlyCollection<IntPtr> enumerated)
    {
        if (child == IntPtr.Zero || child == root || !IsWindow(child) ||
            !enumerated.Contains(child) || GetAncestor(child, GaRoot) != root)
            throw new InvalidOperationException("OWNED_CHILD_NOT_ENUMERATED_OR_ROOT_CHANGED");
        GetWindowThreadProcessId(child, out uint owner);
        if (owner != (uint)pid) throw new InvalidOperationException("OWNED_CHILD_PID_CHANGED");
        string klass = Class(child);
        if (Kind(klass) != expectedKind) throw new InvalidOperationException("OWNED_CHILD_CLASS_CHANGED");
        var style = GetWindowLongPtr(child, GwlStyle).ToInt64();
        return new
        {
            present = true,
            control_class = expectedKind,
            visible_win32 = IsWindowVisible(child),
            enabled_win32 = IsWindowEnabled(child),
            // These are Win32 control properties only, not authorization to execute.
            edit_single_line = expectedKind == "edit" && (style & EsMultiline) == 0,
            edit_not_password = expectedKind == "edit" && (style & EsPassword) == 0,
            edit_not_readonly = expectedKind == "edit" && (style & EsReadOnly) == 0,
            button_system_push_style = expectedKind == "button" && ((style & 0xF) is 0 or 1),
            inspection_only = true,
            app_callback_verified = false
        };
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 6 || args[0] != "OWNED_WINFORMS_INVENTORY_READ_ONLY" ||
                !long.TryParse(args[1], out long rootValue) || rootValue <= 0 ||
                !int.TryParse(args[2], out int pid) || pid <= 0 ||
                !long.TryParse(args[3], out long editValue) || editValue <= 0 ||
                !long.TryParse(args[4], out long buttonValue) || buttonValue <= 0 ||
                !long.TryParse(args[5], out long listValue) || listValue <= 0)
                throw new InvalidOperationException("EXACT_OWNED_WINDOW_CAPABILITY_REQUIRED");
            var root = new IntPtr(rootValue);
            if (!IsWindow(root) || !Class(root).StartsWith("WindowsForms10.Window.", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("WINFORMS_ROOT_NOT_VERIFIED");
            GetWindowThreadProcessId(root, out uint rootPid);
            if (rootPid != (uint)pid) throw new InvalidOperationException("WINFORMS_ROOT_PID_MISMATCH");
            int visited = 0;
            bool overflow = false;
            HashSet<IntPtr> children = [];
            var callback = new EnumChildCallback((child, _) =>
            {
                if (++visited > MaxChildren) { overflow = true; return false; }
                children.Add(child);
                return true;
            });
            bool success = EnumChildWindows(root, callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            if (overflow || !success || visited < 3)
                throw new InvalidOperationException("CHILD_ENUMERATION_INCOMPLETE_OR_EXCEEDED_BUDGET");
            // Every expected child is independently verified after enumeration.
            var output = new
            {
                status = "native_hwnd_read_only_verified",
                fixture_root_owned = true,
                enumerated_children = visited,
                edit = Verify(new IntPtr(editValue), root, pid, "edit", children),
                button = Verify(new IntPtr(buttonValue), root, pid, "button", children),
                list = Verify(new IntPtr(listValue), root, pid, "list", children),
                supports_native_action = false,
                dispatch_count = 0
            };
            Console.WriteLine(JsonSerializer.Serialize(output));
            return 0;
        }
        catch (Exception error)
        {
            // No native handle, PID, UI text or sensitive exception stack traces.
            Console.Error.WriteLine("READ_ONLY_WINFORMS_INVENTORY_DENIED:" + error.Message);
            return 2;
        }
    }
}
