using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace DeskMCP.AgentDesktopHost;

internal static partial class Program
{
    // Read-only source-candidate diagnostic. Does not send, show, move,
    // activate or focus HWNDs. Unlike the production mover it INCLUDES
    // invisible top-level HWNDs for one freshly-created exact Chrome PID.
    // A discovered handle is NEVER an authorization to interact with a user app.
    private static object ProbeHiddenChrome(int pid, string startedAtUtc, VirtualDesktopAccessor vda)
    {
        if (!vda.Available || vda.CurrentDesktopNumber() != 0)
            throw new InvalidOperationException("HIDDEN_CHROME_PROBE_OWNER_DESKTOP1_REQUIRED");
        if (!DateTimeOffset.TryParse(startedAtUtc, out DateTimeOffset started))
            throw new ArgumentException("HIDDEN_CHROME_PROBE_START_TIMESTAMP_REQUIRED");
        using Process p = Process.GetProcessById(pid);
        if (p.HasExited || !String.Equals(p.ProcessName, "chrome", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("HIDDEN_CHROME_PROBE_CHROME_PID_ONLY");
        string actualPath = Path.GetFullPath(p.MainModule?.FileName ?? "");
        string installedPath = Path.GetFullPath(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Google", "Chrome", "Application", "chrome.exe"));
        if (!actualPath.Equals(installedPath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("HIDDEN_CHROME_PROBE_EXACT_CHROME_BINARY_ONLY");
        DateTimeOffset actualStart = new(p.StartTime.ToUniversalTime(), TimeSpan.Zero);
        if (Math.Abs((actualStart - started).TotalSeconds) > 4 ||
            (DateTimeOffset.UtcNow - actualStart).TotalSeconds > 120 ||
            actualStart > DateTimeOffset.UtcNow.AddSeconds(5))
            throw new InvalidOperationException("HIDDEN_CHROME_PROBE_PID_START_IDENTITY_MISMATCH");

        List<object> windows = new();
        bool changed = false;
        bool enumerated = EnumWindows((hwnd, _) => {
            if (!IsWindow(hwnd)) return true;
            GetWindowThreadProcessId(hwnd, out uint owner);
            if (owner != (uint)pid) return true;
            StringBuilder cls = new(128);
            GetClassNameW(hwnd, cls, cls.Capacity);
            string className = cls.ToString();
            bool visible = IsWindowVisible(hwnd);
            bool foreground = HiddenMoveGetForegroundWindow() == hwnd;
            bool root = HiddenMoveGetAncestor(hwnd, 2) == hwnd;
            string? desktop = null;
            try { desktop = GetDesktopId(hwnd).ToString("D"); }
            catch (COMException) { }
            catch (InvalidOperationException) { }
            int? desktopNumber = vda.WindowDesktopNumber(hwnd);
            windows.Add(new {
                hwnd = hwnd.ToInt64(), processId = pid, className,
                root, visible, foreground,
                desktopNumber = desktopNumber.HasValue ? desktopNumber.Value + 1 : (int?)null,
                desktopId = desktop
            });
            if (foreground) changed = true;
            return windows.Count < 50;
        }, IntPtr.Zero);
        if (!enumerated && windows.Count < 50)
            throw new InvalidOperationException("HIDDEN_CHROME_PROBE_ENUMWINDOWS_FAILED");
        if (vda.CurrentDesktopNumber() != 0)
            throw new InvalidOperationException("HIDDEN_CHROME_PROBE_OWNER_CHANGED_DURING_CENSUS");
        return new {
            pass = true,
            ownerDesktopBefore = 1, ownerDesktopAfter = 1,
            processId = pid, freshProcess = true,
            observedForeground = changed,
            windowCount = windows.Count,
            windows,
            authorizedForInput = false, authorizedForMove = false
        };
    }
}
