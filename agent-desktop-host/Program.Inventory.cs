using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace DeskMCP.AgentDesktopHost;

internal static partial class Program
{
    /// <summary>
    /// Read-only inventory of non-shared windows on the real Windows virtual
    /// Desktop 2 while the local owner remains on Desktop 1. In particular,
    /// this code never calls WinApp/UIA, ShowWindow, input, focus or a desktop
    /// navigation API. Individual inconsistent windows are omitted.
    /// </summary>
    private static object ListVirtualWindows(Guid desktopId, VirtualDesktopAccessor vda)
    {
        if (!vda.Available || vda.CurrentDesktopNumber() != 0
            || vda.DesktopNumberById(desktopId) != 1)
            throw new InvalidOperationException("Passive inventory requires Desktop1 owner and exact real Desktop2 GUID.");

        List<object> windows = new();
        IVirtualDesktopManager manager = CreateManager();
        try
        {
            bool enumerated = EnumWindows((hwnd, _) =>
            {
                if (windows.Count >= 100 || !IsWindow(hwnd) || !IsWindowVisible(hwnd))
                    return true;
                if (!GetWindowRect(hwnd, out Rect bounds)
                    || bounds.Right - bounds.Left < 32
                    || bounds.Bottom - bounds.Top < 24)
                    return true;

                try
                {
                    // COM checks exclude pinned/shared/Desktop1 targets. The
                    // native shell may move/close a window during enumeration.
                    if (manager.GetWindowDesktopId(hwnd) != desktopId
                        || manager.IsWindowOnCurrentVirtualDesktop(hwnd))
                        return true;
                    GetWindowThreadProcessId(hwnd, out uint rawPid);
                    if (rawPid == 0 || rawPid > Int32.MaxValue) return true;
                    using Process owner = Process.GetProcessById(checked((int)rawPid));
                    string processName = owner.ProcessName;
                    StringBuilder cls = new(256);
                    if (GetClassNameW(hwnd, cls, cls.Capacity) <= 0) return true;
                    StringBuilder title = new(512);
                    GetWindowTextW(hwnd, title, title.Capacity);
                    if (title.ToString().StartsWith("DeskMCP Agent Desktop", StringComparison.OrdinalIgnoreCase))
                        return true;
                    // Catch a desktop reassignment or HWND recycling between
                    // enumeration and capability publication.
                    GetWindowThreadProcessId(hwnd, out uint pidAgain);
                    if (pidAgain != rawPid || manager.GetWindowDesktopId(hwnd) != desktopId
                        || manager.IsWindowOnCurrentVirtualDesktop(hwnd))
                        return true;
                    windows.Add(new
                    {
                        hwnd = hwnd.ToInt64(),
                        processId = checked((int)rawPid),
                        processName,
                        title = title.ToString(),
                        className = cls.ToString(),
                        width = bounds.Right - bounds.Left,
                        height = bounds.Bottom - bounds.Top,
                        isForeground = false,
                        desktopId = desktopId.ToString("D"),
                        desktopNumber = 2,
                        onCurrentDesktop = false
                    });
                }
                catch (Exception)
                {
                    // Inaccessible, stale, closing or shell-owned windows are
                    // never converted into a trusted Computer Use capability.
                }
                return true;
            }, IntPtr.Zero);
            if (!enumerated || vda.CurrentDesktopNumber() != 0
                || vda.DesktopNumberById(desktopId) != 1)
                throw new InvalidOperationException("Passive Desktop2 inventory lost Desktop1/target desktop identity.");
            return new { desktopId = desktopId.ToString("D"), desktopNumber = 2,
                currentDesktopNumber = 1, windows };
        }
        finally
        {
            if (Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager);
        }
    }
}
