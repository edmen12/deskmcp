using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Native HWND Edit transport, no UIAutomation providers. SOURCE CANDIDATE
// ONLY: no production MCP route, no Windows GUI live validation yet.
// WM_SETTEXT can trigger app callbacks/focus in custom window procedures;
// foreground observer remains a mandatory fail-closed guard.
internal static class NativeEdit
{
    private const uint WmSetText = 0x000C, WmGetText = 0x000D, WmGetTextLength = 0x000E;
    private const uint SmtoAbortIfHung = 0x0002, SmtoBlock = 0x0001;
    private const uint TimeoutMs = 350;
    private const int GwlStyle = -16;
    private const long EsMultiLine = 0x0004, EsPassword = 0x0020, EsReadOnly = 0x0800;
    private const int MaxChildren = 128, MaxEdits = 32, MaxTextLength = 512;

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW", SetLastError = true)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint kind);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    private delegate bool EnumChildCallback(IntPtr child, IntPtr context);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumChildWindows(IntPtr parent, EnumChildCallback callback, IntPtr context);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    private static extern IntPtr SendNoBuffer(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam, uint flags, uint ms, out IntPtr output);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    private static extern IntPtr SendReadBuffer(IntPtr hwnd, uint msg, IntPtr wparam, StringBuilder buffer, uint flags, uint ms, out IntPtr output);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    private static extern IntPtr SendWriteBuffer(IntPtr hwnd, uint msg, IntPtr wparam,
        [MarshalAs(UnmanagedType.LPWStr)] string buffer, uint flags, uint ms, out IntPtr output);
    private static readonly uint Flags = SmtoAbortIfHung | SmtoBlock;

    private static string ClassName(IntPtr hwnd)
    {
        StringBuilder buffer = new(256);
        if (GetClassName(hwnd, buffer, buffer.Capacity) <= 0)
            throw new InvalidOperationException("NATIVE_EDIT_CLASS_UNAVAILABLE");
        return buffer.ToString();
    }
    private static bool IsSupportedEdit(string name) =>
        name.Equals("Edit", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("WindowsForms10.Edit.", StringComparison.OrdinalIgnoreCase);

    private static string AssertSupportedChild(IntPtr root, IntPtr child, int processId)
    {
        if (child == root || child == IntPtr.Zero || !IsWindow(root) || !IsWindow(child)
            || GetAncestor(child, 2) != root || !IsWindowEnabled(child) || !IsWindowVisible(child))
            throw new InvalidOperationException("NATIVE_EDIT_CHILD_NOT_OWNED_ENABLED_VISIBLE");
        GetWindowThreadProcessId(root, out uint rootPid);
        GetWindowThreadProcessId(child, out uint childPid);
        if (rootPid != (uint)processId || childPid != rootPid)
            throw new InvalidOperationException("NATIVE_EDIT_CHILD_PROCESS_MISMATCH");
        string name = ClassName(child);
        if (!IsSupportedEdit(name))
            throw new InvalidOperationException("NATIVE_EDIT_CLASS_NOT_WHITELISTED");
        long style = GetWindowLongPtr(child, GwlStyle).ToInt64();
        if ((style & (EsMultiLine | EsPassword | EsReadOnly)) != 0)
            throw new InvalidOperationException("NATIVE_EDIT_PASSWORD_MULTILINE_READONLY_DENIED");
        return name;
    }
    private static List<(IntPtr child, string className)> Children(
        IntPtr root, int pid, Action guard, out int visited)
    {
        List<(IntPtr child, string className)> edits = new();
        int scanned = 0;
        bool exhausted = false;
        guard();
        bool enumerationCompleted = EnumChildWindows(root, (hwnd, _) => {
            // Only capture HWNDs here. Exceptions inside Win32 callbacks
            // must not cross the unmanaged callback boundary.
            scanned++;
            if (scanned > MaxChildren) { exhausted = true; return false; }
            if (edits.Count >= MaxEdits) { exhausted = true; return false; }
            if (IsWindow(hwnd))
            {
                StringBuilder buffer = new(256);
                if (GetClassName(hwnd, buffer, buffer.Capacity) > 0 && IsSupportedEdit(buffer.ToString()))
                    edits.Add((hwnd, buffer.ToString()));
            }
            return true;
        }, IntPtr.Zero);
        guard();
        if (exhausted) throw new InvalidOperationException("NATIVE_EDIT_CHILD_ENUMERATION_BUDGET_EXCEEDED");
        if (!enumerationCompleted)
            throw new InvalidOperationException("NATIVE_EDIT_CHILD_ENUMERATION_INCOMPLETE");
        visited = scanned;
        // No partial trust: a supported but disabled, password or multiline
        // candidate is filtered, rather than becoming an arbitrary handle.
        return edits.Where(pair => {
            try { AssertSupportedChild(root, pair.child, pid); return true; }
            catch (InvalidOperationException) { return false; }
        }).ToList();
    }

    private static IntPtr Message(IntPtr child, uint msg)
    {
        if (SendNoBuffer(child, msg, IntPtr.Zero, IntPtr.Zero, Flags, TimeoutMs, out IntPtr result) == IntPtr.Zero)
            throw new InvalidOperationException("NATIVE_EDIT_MESSAGE_TIMEOUT_OR_UIPI_DENIED");
        return result;
    }
    private static string ReadText(IntPtr child, Action guard)
    {
        guard();
        long count = Message(child, WmGetTextLength).ToInt64();
        if (count < 0 || count > MaxTextLength)
            throw new InvalidOperationException("NATIVE_EDIT_PREVIOUS_CONTENT_TOO_LONG");
        StringBuilder text = new((int)count + 1);
        if (SendReadBuffer(child, WmGetText, new IntPtr(count + 1), text,
              Flags, TimeoutMs, out IntPtr copied) == IntPtr.Zero)
            throw new InvalidOperationException("NATIVE_EDIT_READ_TIMEOUT_OR_UIPI_DENIED");
        guard();
        if (copied.ToInt64() != text.Length)
            throw new InvalidOperationException("NATIVE_EDIT_GETTEXT_INCOMPLETE");
        return text.ToString();
    }

    public static object Inspect(IntPtr root, int pid, Action guard)
    {
        var controls = Children(root, pid, guard, out int visited).Select(pair => new {
            automationId = "native-edit:" + pair.child.ToInt64(),
            controlType = "NativeWin32.Edit",
            className = pair.className,
            canSetValue = false, canScrollTopBottom = false, canSetNativeValue = true
        }).ToArray();
        guard();
        return new {
            operation = "inspect-native-edits", hwnd = root.ToInt64(),
            processId = pid, scannedNodes = visited,
            controls, uiaReadbackConfirmed = false, appEventConfirmed = false
        };
    }

    public static object Set(IntPtr root, int pid, string automationId,
        string? value, string? expectedPrevious, Action guard)
    {
        // Caller has a one-use lease-bound semantic observation, derived
        // from a successful native-only bounded snapshot (NO UIA provider).
        if (!automationId.StartsWith("native-edit:", StringComparison.Ordinal)
            || !long.TryParse(automationId.AsSpan("native-edit:".Length), out long id)
            || id <= 0 || value == null || expectedPrevious == null
            || value.Length > MaxTextLength || expectedPrevious.Length > MaxTextLength
            || value.Contains('\0') || expectedPrevious.Contains('\0')
            || value.Any(char.IsControl) || expectedPrevious.Any(char.IsControl))
            throw new InvalidOperationException("NATIVE_EDIT_VALUE_OR_CHILD_CAPABILITY_INVALID");
        IntPtr child = new(id);
        guard();
        // Full re-enumeration ensures the child was not replaced/reparented
        // after snapshot. Never send WM_SETTEXT to a top-level or user window.
        List<(IntPtr child, string className)> entries = Children(root, pid, guard, out _);
        if (entries.Count(pair => pair.child == child) != 1)
            throw new InvalidOperationException("NATIVE_EDIT_CHILD_CAPABILITY_STALE_OR_UNKNOWN");
        AssertSupportedChild(root, child, pid);
        if (ReadText(child, guard) != expectedPrevious)
            throw new InvalidOperationException("NATIVE_EDIT_EXPECTED_PREVIOUS_TEXT_MISMATCH");
        guard();
        AssertSupportedChild(root, child, pid);
        if (SendWriteBuffer(child, WmSetText, IntPtr.Zero, value,
              Flags, TimeoutMs, out IntPtr applied) == IntPtr.Zero || applied == IntPtr.Zero)
            throw new InvalidOperationException("NATIVE_EDIT_SETTEXT_FAILED_OR_TIMEOUT");
        guard();
        AssertSupportedChild(root, child, pid);
        if (ReadText(child, guard) != value)
            throw new InvalidOperationException("NATIVE_EDIT_READBACK_MISMATCH");
        Thread.Sleep(80);
        guard();
        if (ReadText(child, guard) != value)
            throw new InvalidOperationException("NATIVE_EDIT_EXTRA_EDIT_AFTER_SETTEXT");
        guard();
        return new { operation = "set-native-edit", textReadbackConfirmed = true,
            appEventConfirmed = false, foregroundSafetyUnproven = true };
    }
}
