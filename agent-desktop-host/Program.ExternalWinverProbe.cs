using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace DeskMCP.AgentDesktopHost;

internal static partial class Program
{
    // Read-only admission *candidate* for a new, short-lived, owned Microsoft
    // Winver instance started hidden. Not an input authorization and never
    // used by production Computer Use. Does not create, show, move, focus or
    // otherwise interact with any window.
    private static object ProbeHiddenWinver(int pid,string startedAtUtc,VirtualDesktopAccessor vda)
    {
        if(!DateTimeOffset.TryParse(startedAtUtc,out var expectedStart))
            throw new ArgumentException("EXTERNAL_PROBE_VALID_START_TIME_REQUIRED");
        if(!vda.Available || vda.CurrentDesktopNumber()!=0)
            throw new InvalidOperationException("EXTERNAL_PROBE_OWNER_DESKTOP1_REQUIRED");
        using Process process=Process.GetProcessById(pid);
        if(!String.Equals(process.ProcessName,"winver",StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("EXTERNAL_PROBE_ONLY_WINVER_PROCESS_ALLOWED");
        string expectedPath=Path.GetFullPath(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","winver.exe"));
        if(!String.Equals(Path.GetFullPath(process.MainModule?.FileName??""),
            expectedPath,StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("EXTERNAL_PROBE_SYSTEM32_WINVER_PATH_REQUIRED");
        DateTimeOffset actualStart=new(process.StartTime.ToUniversalTime(),TimeSpan.Zero);
        if(Math.Abs((actualStart-expectedStart).TotalSeconds)>4
            ||(DateTimeOffset.UtcNow-actualStart).TotalSeconds>60
            ||actualStart>DateTimeOffset.UtcNow.AddSeconds(5))
            throw new InvalidOperationException("EXTERNAL_PROBE_PROCESS_START_PROOF_FAILED");
        List<object> hidden=new();
        bool wrongDesktop=false,ambiguous=false,visibleWindow=false;
        bool success=EnumWindows((hwnd,_)=>{
            if(!IsWindow(hwnd))return true;
            GetWindowThreadProcessId(hwnd,out uint owner);
            if(owner!=(uint)pid)return true;
            if(IsWindowVisible(hwnd)){visibleWindow=true;return false;}
            StringBuilder name=new(128);
            if(GetClassNameW(hwnd,name,name.Capacity)<=0
                ||!name.ToString().Equals("#32770",StringComparison.Ordinal))
                return true;
            int? desk=vda.WindowDesktopNumber(hwnd);
            if(desk!=0){wrongDesktop=true;return false;}
            if(hidden.Count>=1){ambiguous=true;return false;}
            hidden.Add(new {
                hwnd=hwnd.ToInt64(),className="#32770",
                visible=false,desktopNumber=1,allowedForInput=false
            });
            return true;
        },IntPtr.Zero);
        if(visibleWindow)
            throw new InvalidOperationException("EXTERNAL_PROBE_VISIBLE_WINDOW_BEFORE_PLACEMENT");
        if(wrongDesktop)
            throw new InvalidOperationException("EXTERNAL_PROBE_HIDDEN_WINDOW_WRONG_DESKTOP");
        if(ambiguous)
            throw new InvalidOperationException("EXTERNAL_PROBE_AMBIGUOUS_DIALOGS");
        if(!success || vda.CurrentDesktopNumber()!=0)
            throw new InvalidOperationException("EXTERNAL_PROBE_DESKTOP_CHANGED_OR_ENUM_FAILED");
        // A matching system filename/path is NOT a checked Authenticode
        // signature, and the hidden handle is not an action permit.
        return new {
            pass=true,ownerDesktopBefore=1,ownerDesktopAfter=1,
            candidateCount=hidden.Count,hiddenWindows=hidden,
            signatureVerified=false,authorizedForInput=false
        };
    }
}
