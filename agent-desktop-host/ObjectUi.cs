using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace DeskMCP.AgentDesktopHost;

/// <summary>
/// Strictly limited non-input Win32 Desktop Object UIA fallback for native
/// WinForms EDIT and BUTTON children. Never uses SendInput, SwitchDesktop,
/// system clipboard or foreground activation.
/// </summary>
internal static class ObjectUi
{
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr context);
    private const uint DesktopReadObjects = 0x0001;
    private const uint DesktopEnumerate = 0x0040;
    private const uint WmSetText = 0x000C;
    private const uint WmGetText = 0x000D;
    private const uint BmClick = 0x00F5;
    private const uint SmtoAbortIfHung = 0x0002;
    private const uint SmtoBlock = 0x0001;
    private const int GwlStyle = -16;
    private const int EsPassword = 0x0020;
    private const int TimeoutMs = 2500;

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint="OpenDesktopW",SetLastError=true)]
    private static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError=true)]
    private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError=true)]
    private static extern bool EnumDesktopWindows(IntPtr desktop, EnumWindowsProc callback, IntPtr state);
    [DllImport("user32.dll", SetLastError=true)]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr state);
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hwnd, StringBuilder output, int capacity);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder output, int capacity);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")]
    private static extern int GetWindowLongW(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW",SetLastError=true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hwnd, uint message, IntPtr wp, IntPtr lp,
        uint flags, uint timeoutMs, out IntPtr result);

    private sealed record Control(IntPtr Hwnd, string Role, string ClassName, string Name);

    private static List<Control> ControlsFor(string desktopName, IntPtr root)
    {
        if (!Regex.IsMatch(desktopName, @"\ADeskMCP-Agent-[0-9a-fA-F]{32}\z", RegexOptions.CultureInvariant))
            throw new ArgumentException("Invalid isolated desktop lease object name.");
        if (root == IntPtr.Zero || !IsWindow(root))
            throw new InvalidOperationException("Target isolated window no longer exists.");

        IntPtr desktop = OpenDesktop(desktopName, 0, false, DesktopReadObjects | DesktopEnumerate);
        if (desktop == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open isolated Agent Desktop.");
        bool found=false;
        try
        {
            if (!EnumDesktopWindows(desktop, (hwnd, _) =>
                {
                    if (hwnd != root) return true;
                    found=true;
                    return false;
                }, IntPtr.Zero) && !found)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Desktop HWND enumeration failed.");
        }
        finally { CloseDesktop(desktop); }
        if (!found) throw new InvalidOperationException("Target HWND belongs to a different Win32 Desktop Object.");
        GetWindowThreadProcessId(root, out uint owner);
        if (owner == 0) throw new InvalidOperationException("Target window has no verified process.");

        List<Control> controls = new();
        if (!EnumChildWindows(root, (hwnd, _) =>
        {
            if (!IsWindow(hwnd) || !IsWindowEnabled(hwnd)) return true;
            GetWindowThreadProcessId(hwnd, out uint childOwner);
            if (childOwner != owner) return true;
            StringBuilder cls = new(512);
            GetClassNameW(hwnd, cls, cls.Capacity);
            string role = cls.ToString().StartsWith("WindowsForms10.EDIT.",StringComparison.Ordinal)
                ? "edit" : cls.ToString().StartsWith("WindowsForms10.BUTTON.",StringComparison.Ordinal)
                    ? "button" : String.Empty;
            if (role.Length == 0) return true;
            StringBuilder title = new(512);
            // Button text is safe as its name. Never return EDIT text.
            if (role == "button") GetWindowTextW(hwnd,title,title.Capacity);
            controls.Add(new Control(hwnd,role,cls.ToString(),
                role=="button" ? title.ToString() : "WinForms edit"));
            return true;
        }, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Isolated child enumeration failed.");
        return controls;
    }

    public static object Inspect(string desktopName, IntPtr root)
    {
        List<object> elements = new();
        foreach (Control control in ControlsFor(desktopName,root))
        {
            elements.Add(new {
                type = control.Role == "edit" ? "Edit" : "Button",
                name = control.Name,
                className = control.ClassName,
                selector = $"native:{control.Role}:{control.Hwnd.ToInt64().ToString(CultureInfo.InvariantCulture)}",
                isEnabled = true,
                isInvokable = control.Role == "button"
            });
        }
        return new { hwnd = root.ToInt64(), elements };
    }

    public static object Act(string desktopName, IntPtr root, string action,
        string selector, string? valueBase64)
    {
        Match parsed=Regex.Match(selector, @"\Anative:(edit|button):([1-9][0-9]{0,15})\z",
            RegexOptions.CultureInvariant);
        if (!parsed.Success || !long.TryParse(parsed.Groups[2].Value,NumberStyles.None,
            CultureInfo.InvariantCulture,out long rawHandle))
            throw new InvalidOperationException("Native control selector is invalid.");
        IntPtr child=new(rawHandle);
        Control? control=ControlsFor(desktopName,root).Find(row=>row.Hwnd==child);
        if (control==null || control.Role!=parsed.Groups[1].Value)
            throw new InvalidOperationException("Native child control changed or closed.");
        // Window handles can be recycled between snapshot and action. Recheck
        // the HWND's present root, process owner and WinForms class.
        if (!IsWindow(child) || GetAncestor(child, 2) != root)
            throw new InvalidOperationException("Native control changed parent or desktop.");
        GetWindowThreadProcessId(root, out uint rootOwner);
        GetWindowThreadProcessId(child, out uint childOwner);
        StringBuilder liveClass=new(512);
        GetClassNameW(child,liveClass,liveClass.Capacity);
        if (rootOwner==0 || rootOwner!=childOwner ||
            !String.Equals(liveClass.ToString(),control.ClassName,StringComparison.Ordinal))
            throw new InvalidOperationException("Native control identity changed before action.");

        if (action=="set_value" && control.Role=="edit")
        {
            if ((GetWindowLongW(child,GwlStyle)&EsPassword)!=0)
                throw new InvalidOperationException("Password fields require human takeover.");
            byte[] bytes=Convert.FromBase64String(valueBase64??String.Empty);
            if(bytes.Length>65536)throw new ArgumentException("Native field value exceeds limit.");
            string value = new UTF8Encoding(false,true).GetString(bytes);
            IntPtr buffer=Marshal.StringToHGlobalUni(value);
            try
            {
                if (SendMessageTimeout(child,WmSetText,IntPtr.Zero,buffer,
                    SmtoAbortIfHung|SmtoBlock,TimeoutMs,out _) == IntPtr.Zero)
                    throw new InvalidOperationException("Native edit did not accept text.");
            }
            finally { Marshal.FreeHGlobal(buffer); }
            // Readback confirms actual remote value, but never includes it in response.
            IntPtr output=Marshal.AllocHGlobal((value.Length+1)*2);
            try
            {
                if(SendMessageTimeout(child,WmGetText,new IntPtr(value.Length+1),output,
                    SmtoAbortIfHung|SmtoBlock,TimeoutMs,out _)==IntPtr.Zero ||
                    Marshal.PtrToStringUni(output)!=value)
                    throw new InvalidOperationException("Native edit readback did not match.");
            }
            finally { Marshal.FreeHGlobal(output); }
            return new { action, acknowledged=true, readback_verified=true };
        }
        if (action=="invoke" && control.Role=="button")
        {
            if(SendMessageTimeout(child,BmClick,IntPtr.Zero,IntPtr.Zero,
                SmtoAbortIfHung|SmtoBlock,TimeoutMs,out _)==IntPtr.Zero)
                throw new InvalidOperationException("Native button message was not delivered.");
            return new {action, acknowledged=true, effect_requires_reobservation=true};
        }
        throw new InvalidOperationException("Only WinForms EDIT set_value and BUTTON invoke are allowed.");
    }
}
