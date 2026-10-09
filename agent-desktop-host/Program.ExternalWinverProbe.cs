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
        if(!vda.Available || vda.CurrentDesktopNumber()!=0)
            throw new InvalidOperationException("EXTERNAL_PROBE_OWNER_DESKTOP1_REQUIRED");
        using Process process=VerifyFreshOwnedWinver(pid,startedAtUtc);
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
