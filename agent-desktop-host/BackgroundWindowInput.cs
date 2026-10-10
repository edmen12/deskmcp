using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;

namespace DeskMCP.AgentDesktopHost;

/// <summary>
/// Window-message input only for a verified Windows virtual Desktop 2+ HWND.
/// Intentionally has NO SendInput, SetCursorPos, SetForegroundWindow, SwitchDesktop,
/// CreateDesktop or hypervisor routes. This is not equivalent to hardware HID.
/// </summary>
internal static class BackgroundWindowInput
{
    private const uint WmMouseMove = 0x0200;
    private const uint WmLButtonDown = 0x0201;
    private const uint WmLButtonUp = 0x0202;
    private const uint WmLButtonDblClk = 0x0203;
    private const uint WmRButtonDown = 0x0204;
    private const uint WmRButtonUp = 0x0205;
    private const uint WmMouseWheel = 0x020A;
    private const uint WmKeyDown = 0x0100;
    private const uint WmKeyUp = 0x0101;
    private const uint WmChar = 0x0102;
    private const uint BmClick = 0x00F5;
    private const uint MkLButton = 0x0001;
    private const uint MkRButton = 0x0002;
    private const uint GaRoot = 2;
    private const uint SmtoAbortIfHung = 0x0002;
    private const uint TimeoutMs = 450;
    private const int GwlExStyle = -20;
    private const long WsExNoActivate = 0x08000000L;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; public Point(int x, int y) { X=x; Y=y; } }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

    [ComImport, Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IVirtualDesktopManager
    {
        [return: MarshalAs(UnmanagedType.Bool)]
        bool IsWindowOnCurrentVirtualDesktop(IntPtr hwnd);
        Guid GetWindowDesktopId(IntPtr hwnd);
        void MoveWindowToDesktop(IntPtr hwnd, ref Guid desktopId);
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hwnd, StringBuilder value, int maxCount);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetWindowLongPtrW", SetLastError=true)]
    private static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeoutW(
        IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam,
        uint flags, uint timeout, out IntPtr result);

    internal static bool EligibleNoActivateStyle(long exStyle)
        =>(exStyle & WsExNoActivate)!=0;

    internal static object SelfTestRootSafety()
    {
        bool protectedRoot=EligibleNoActivateStyle(WsExNoActivate);
        bool ordinaryDenied=!EligibleNoActivateStyle(0);
        bool topmostOnlyDenied=!EligibleNoActivateStyle(0x00000008L);
        bool toolWindowOnlyDenied=!EligibleNoActivateStyle(0x00000080L);
        return new {
            pass=protectedRoot&&ordinaryDenied&&topmostOnlyDenied&&toolWindowOnlyDenied,
            protectedRoot,ordinaryDenied,topmostOnlyDenied,toolWindowOnlyDenied
        };
    }

    private static void AssertNonActivatingRoot(IntPtr root)
    {
        // Virtual Desktop2 shares the Windows input desktop with Desktop1.
        // Never deliver background WM input to an ordinary activatable root.
        if(!EligibleNoActivateStyle(GetWindowLongPtr(root,GwlExStyle).ToInt64()))
            throw new InvalidOperationException("BACKGROUND_INPUT_ROOT_NOACTIVATE_REQUIRED");
    }

    private static IntPtr Params(int x, int y)
    {
        // Mouse message lParam uses two signed 16-bit client coordinates.
        if (x < 0 || y < 0 || x > 32767 || y > 32767)
            throw new ArgumentOutOfRangeException(nameof(x), "Window-local mouse coordinates must be in 0..32767.");
        return new IntPtr((y << 16) | (x & 0xffff));
    }

    private static int Bounded(Dictionary<string, string> options, string name, int min, int max)
    {
        if (!options.TryGetValue(name, out string? raw)
            || !int.TryParse(raw, out int value) || value < min || value > max)
            throw new ArgumentException($"Invalid or missing --{name}; expected integer in {min}..{max}.");
        return value;
    }

    // Independent receiver message queue. It does not move the OS mouse or change focus.
    private static void Deliver(IntPtr hwnd, uint message, int wParam, IntPtr lParam)
    {
        if (SendMessageTimeoutW(hwnd, message, new IntPtr(wParam), lParam, SmtoAbortIfHung, TimeoutMs, out _) == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Target window did not process a bounded message.");
    }

    private static void Move(IntPtr hwnd, int x, int y, int held = 0)
        => Deliver(hwnd, WmMouseMove, held, Params(x, y));

    public static object Apply(
        IntPtr hwnd,
        Guid desktopId,
        int expectedProcessId,
        string action,
        Dictionary<string, string> options,
        Func<Guid, int?> desktopNumberById,
        Func<int?> currentDesktopNumber,
        string observerReady,string observerTripwire,string observerExe,int observerPid)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            throw new ArgumentException("Target HWND is not a live window.");
        if (expectedProcessId <= 0)
            throw new ArgumentException("A positive expected HWND owner PID is required.");
        int? targetDesktop = desktopNumberById(desktopId);
        if (!targetDesktop.HasValue || targetDesktop.Value < 1)
            throw new InvalidOperationException("Background input accepts only genuine Windows virtual Desktop 2 or later.");

        // For child controls: verify the parent top-level window is truly in Desktop 2.
        // A valid HWND supplied by a caller must not be allowed to redirect to Desktop 1.
        IntPtr root = GetAncestor(hwnd, GaRoot);
        if (root == IntPtr.Zero || !IsWindow(root))
            throw new InvalidOperationException("Target HWND has no live root window.");
        GetWindowThreadProcessId(hwnd, out uint childPid);
        GetWindowThreadProcessId(root, out uint rootPid);
        if (childPid != unchecked((uint)expectedProcessId) || rootPid != childPid)
            throw new InvalidOperationException("HWND owner PID mismatch or cross-process child window.");
        AssertNonActivatingRoot(root);
        Type managerType = Type.GetTypeFromCLSID(new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A"), throwOnError: true)!;
        IVirtualDesktopManager manager = (IVirtualDesktopManager)Activator.CreateInstance(managerType)!;
        try
        {
            if (manager.GetWindowDesktopId(root) != desktopId)
                throw new InvalidOperationException("Target HWND does not belong to the expected virtual Desktop 2.");
            int? current = currentDesktopNumber();
            if (!current.HasValue)
                throw new InvalidOperationException("Cannot verify the current Windows virtual desktop.");
            // Autonomous background input is valid only while the owner is still
            // on Desktop 1 (VDA index zero). Owner Desktop 2 visits pause the Agent.
            if (current.Value != 0)
                throw new InvalidOperationException("Owner left Desktop 1; autonomous Agent background input is paused.");
            if (manager.IsWindowOnCurrentVirtualDesktop(root))
                throw new InvalidOperationException("Window is also exposed on the owner's active Desktop 1; pinned/shared windows cannot receive Agent background input.");
        }
        finally
        {
            if (Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager);
        }

        string kind = action.Trim().ToLowerInvariant();
        if (kind == "invoke-button")
        {
            if (hwnd == root || !IsWindowEnabled(hwnd))
                throw new InvalidOperationException("Semantic button activation requires an enabled child Button HWND.");
            StringBuilder className = new(256);
            if (GetClassNameW(hwnd, className, className.Capacity) <= 0
                || !(className.ToString().Equals("Button", StringComparison.OrdinalIgnoreCase)
                || className.ToString().StartsWith("WindowsForms10.BUTTON.", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("Semantic button activation refuses non-Button HWNDs.");
        }
        bool mouse = kind is "move" or "click" or "right-click" or "double-click" or "drag" or "wheel";
        int x = 0, y = 0;
        if (mouse)
        {
            x = Bounded(options, "x", 0, 32767);
            y = Bounded(options, "y", 0, 32767);
            if (!GetClientRect(hwnd, out Rect bounds)
                || x >= bounds.Right || y >= bounds.Bottom)
                throw new InvalidOperationException("Mouse point lies outside the target HWND client area.");
        }

        int toX = 0, toY = 0, steps = 0, delta = 0, vk = 0;
        string text = String.Empty;
        if (kind == "drag")
        {
            toX = Bounded(options, "to-x", 0, 32767);
            toY = Bounded(options, "to-y", 0, 32767);
            steps = Bounded(options, "steps", 2, 60);
            if (!GetClientRect(hwnd, out Rect bounds) || toX >= bounds.Right || toY >= bounds.Bottom)
                throw new InvalidOperationException("Drag endpoint lies outside the target HWND client area.");
        }
        else if (kind == "wheel")
        {
            delta = Bounded(options, "delta", -1200, 1200);
            if (delta == 0) throw new ArgumentException("Mouse wheel delta cannot be zero.");
        }
        else if (kind == "key")
        {
            vk = Bounded(options, "vk", 1, 254);
        }
        else if (kind == "text")
        {
            if (!options.TryGetValue("text", out string? inputText) || inputText is null || inputText.Length < 1 || inputText.Length > 128)
                throw new ArgumentException("Bounded literal text must contain 1..128 UTF-16 code units.");
            text = inputText;
            foreach (char c in text)
                if (char.IsControl(c) && c != '\r' && c != '\n' && c != '\t')
                    throw new ArgumentException("Control characters are not allowed.");
        }
        else if (!mouse && kind != "invoke-button")
        {
            throw new ArgumentException("Unsupported window-message input action.");
        }


        void VerifyMoveAuthority()
        {
            // This process cannot trust a previous TS/HUD health check: the
            // actual strict watcher may die during a multi-message drag.
            Program.AssertTargetObserverLive(
                observerReady,observerTripwire,observerExe,observerPid,
                root,expectedProcessId);
            if(currentDesktopNumber()!=0 || !IsWindow(hwnd) || !IsWindow(root))
                throw new InvalidOperationException("BACKGROUND_INPUT_DESKTOP_OR_WINDOW_CHANGED");
            AssertNonActivatingRoot(root);
            GetWindowThreadProcessId(hwnd,out uint liveChild);
            GetWindowThreadProcessId(root,out uint liveRoot);
            if(liveChild!=(uint)expectedProcessId || liveRoot!=liveChild)
                throw new InvalidOperationException("BACKGROUND_INPUT_TARGET_OWNER_CHANGED");
            IVirtualDesktopManager recheck=(IVirtualDesktopManager)Activator.CreateInstance(managerType)!;
            try {
                if(recheck.GetWindowDesktopId(root)!=desktopId
                    || recheck.IsWindowOnCurrentVirtualDesktop(root))
                    throw new InvalidOperationException("BACKGROUND_INPUT_TARGET_LEFT_DESKTOP2");
            } finally {
                if(Marshal.IsComObject(recheck))Marshal.FinalReleaseComObject(recheck);
            }
        }
        void DeliverVerified(IntPtr target,uint message,int param,IntPtr data)
        {
            VerifyMoveAuthority();
            Deliver(target,message,param,data);
            VerifyMoveAuthority();
        }
        void MoveVerified(IntPtr target,int px,int py,int held=0)
            =>DeliverVerified(target,WmMouseMove,held,Params(px,py));

        // All validation occurs before ANY window input message is dispatched.
        switch (kind)
        {
            case "invoke-button":
                DeliverVerified(hwnd, BmClick, 0, IntPtr.Zero);
                break;
            case "move":
                MoveVerified(hwnd, x, y);
                break;
            case "click":
            case "right-click":
            case "double-click":
                MoveVerified(hwnd, x, y);
                bool right = kind == "right-click";
                uint down = right ? WmRButtonDown : WmLButtonDown;
                uint up = right ? WmRButtonUp : WmLButtonUp;
                int mask = right ? (int)MkRButton : (int)MkLButton;
                DeliverVerified(hwnd, down, mask, Params(x, y));
                DeliverVerified(hwnd, up, 0, Params(x, y));
                if (kind == "double-click")
                {
                    DeliverVerified(hwnd, WmLButtonDblClk, mask, Params(x, y));
                    DeliverVerified(hwnd, up, 0, Params(x, y));
                }
                break;
            case "drag":
                MoveVerified(hwnd, x, y);
                DeliverVerified(hwnd, WmLButtonDown, (int)MkLButton, Params(x, y));
                try
                {
                    for (int i = 1; i <= steps; i++)
                    {
                        int nx = x + (int)Math.Round((toX - x) * (double)i / steps);
                        int ny = y + (int)Math.Round((toY - y) * (double)i / steps);
                        MoveVerified(hwnd, nx, ny, (int)MkLButton);
                    }
                }
                finally
                {
                    DeliverVerified(hwnd, WmLButtonUp, 0, Params(toX, toY));
                }
                break;
            case "wheel":
                Point screenPoint = new(x, y);
                if (!ClientToScreen(hwnd, ref screenPoint))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "ClientToScreen failed.");
                DeliverVerified(hwnd, WmMouseWheel, delta << 16, Params(screenPoint.X, screenPoint.Y));
                break;
            case "key":
                DeliverVerified(hwnd, WmKeyDown, vk, new IntPtr(1));
                DeliverVerified(hwnd, WmKeyUp, vk, new IntPtr(unchecked((int)0xC0000001)));
                break;
            case "text":
                foreach (char c in text)
                    DeliverVerified(hwnd, WmChar, c, new IntPtr(1));
                break;
        }

        // A successful WM dispatch is not permission to continue if the owner
        // changed desktops during the operation. This cannot prevent the first
        // unexpected switch; the independent tripwire must catch fast round trips.
        if (currentDesktopNumber() != 0)
            throw new InvalidOperationException("Owner desktop changed during background input; pause all further Agent actions.");

        return new {
            acceptedByWindowProcedure = true,
            confirmedAppState = false,
            input = kind,
            hwnd = hwnd.ToInt64(),
            expectedProcessId,
            desktopId = desktopId.ToString("D"),
            desktopNumber = targetDesktop.Value + 1,
            hostInputWasNotUsed = true
        };
    }
}
