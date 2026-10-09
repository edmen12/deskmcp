using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;

namespace DeskMCP.AgentDesktopHost;

internal static partial class Program
{
    private static bool StrictObserverReadyFields(bool pumped,bool vda,bool foreground,
        bool strictForeground,bool strictWindowShow,int desktopIndex)
        =>pumped&&vda&&foreground&&strictForeground&&strictWindowShow&&desktopIndex==0;

    // Candidate-only, independent of the Node coordinator. A crashed/reused
    // watchdog PID, stale Ready, latching alarm or missing hook denies VDA move.
    // This guards the move timing; it cannot undo a window's FIRST activation.
    private static void AssertStrictObserverLive(string readyPath,string alarmPath,
        string observerExePath,int observerPid)
    {
        if(observerPid<=0 || !Path.IsPathFullyQualified(readyPath)
            || !Path.IsPathFullyQualified(alarmPath)
            || !Path.IsPathFullyQualified(observerExePath))
            throw new InvalidOperationException("HIDDEN_MOVE_OBSERVER_AUTHORITY_INVALID");
        string ready=Path.GetFullPath(readyPath);
        string alarm=Path.GetFullPath(alarmPath);
        string exe=Path.GetFullPath(observerExePath);
        if(!String.Equals(Path.GetFileName(ready),"observer.ready.json",
               StringComparison.OrdinalIgnoreCase)
            || !String.Equals(Path.GetFileName(alarm),"observer.tripwire.json",
                StringComparison.OrdinalIgnoreCase)
            || !String.Equals(Path.GetDirectoryName(ready),Path.GetDirectoryName(alarm),
                StringComparison.OrdinalIgnoreCase)
            || !String.Equals(Path.GetFileName(exe),"DeskMCP.Desktop2SwitchObserver.exe",
                StringComparison.OrdinalIgnoreCase)
            || File.Exists(alarm) || !File.Exists(ready))
            throw new InvalidOperationException("HIDDEN_MOVE_OBSERVER_READY_OR_ALARM_INVALID");
        using Process owner=Process.GetProcessById(observerPid);
        if(owner.HasExited
            || !String.Equals(Path.GetFullPath(owner.MainModule?.FileName??""),
                exe,StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("HIDDEN_MOVE_OBSERVER_PID_OR_EXE_MISMATCH");
        using JsonDocument doc=JsonDocument.Parse(File.ReadAllText(ready));
        JsonElement v=doc.RootElement;
        if(v.ValueKind!=JsonValueKind.Object)
            throw new InvalidOperationException("HIDDEN_MOVE_OBSERVER_READY_INVALID");
        bool trusted= v.GetProperty("processId").GetInt32()==observerPid
            && StrictObserverReadyFields(
                v.GetProperty("messagePumpRunning").GetBoolean(),
                v.GetProperty("hasVirtualDesktopNotifications").GetBoolean(),
                v.GetProperty("hasForegroundHook").GetBoolean(),
                v.GetProperty("strictForegroundArmed").GetBoolean(),
                v.GetProperty("strictWindowShowArmed").GetBoolean(),
                v.GetProperty("expectedDesktopIndex").GetInt32())
            && String.Equals(Path.GetFullPath(v.GetProperty("tripwireFile").GetString()??""),
                alarm,StringComparison.OrdinalIgnoreCase)
            && String.Equals(Path.GetFullPath(v.GetProperty("eventLog").GetString()??""),
                Path.Combine(Path.GetDirectoryName(ready)!,"observer.events.jsonl"),
                StringComparison.OrdinalIgnoreCase);
        DateTime started=owner.StartTime.ToUniversalTime();
        DateTime published=v.GetProperty("firstStartUtc").GetDateTime().ToUniversalTime();
        if(!trusted || published<started.AddSeconds(-2)
            || published>DateTime.UtcNow.AddSeconds(3)
            || (DateTime.UtcNow-published).TotalSeconds>60
            || (DateTime.UtcNow-started).TotalSeconds>90)
            throw new InvalidOperationException("HIDDEN_MOVE_OBSERVER_READY_IDENTITY_UNTRUSTED");
        if(owner.HasExited || File.Exists(alarm) || !File.Exists(ready))
            throw new InvalidOperationException("HIDDEN_MOVE_OBSERVER_DIED_OR_TRIPPED");
    }

    private static object StrictObserverGuardSelfTest()
    {
        bool valid=StrictObserverReadyFields(true,true,true,true,true,0);
        bool rejectsNoPump=!StrictObserverReadyFields(false,true,true,true,true,0);
        bool rejectsNoVda=!StrictObserverReadyFields(true,false,true,true,true,0);
        bool rejectsNoForeground=!StrictObserverReadyFields(true,true,false,true,true,0);
        bool rejectsNoStrictForeground=!StrictObserverReadyFields(true,true,true,false,true,0);
        bool rejectsNoShowHook=!StrictObserverReadyFields(true,true,true,true,false,0);
        bool rejectsDesktop2=!StrictObserverReadyFields(true,true,true,true,true,1);
        return new{
            pass=valid&&rejectsNoPump&&rejectsNoVda&&rejectsNoForeground
                &&rejectsNoStrictForeground&&rejectsNoShowHook&&rejectsDesktop2,
            valid,rejectsNoPump,rejectsNoVda,rejectsNoForeground,
            rejectsNoStrictForeground,rejectsNoShowHook,rejectsDesktop2
        };
    }
}
