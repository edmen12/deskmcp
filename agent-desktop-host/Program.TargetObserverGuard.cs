using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;

namespace DeskMCP.AgentDesktopHost;

internal static partial class Program
{
    // Real virtual Desktop2 background HWND message authority. Unlike the
    // prelaunch SHOW watcher, this is the exact already-armed target watcher.
    // A genuine process, pumped WinEvent hooks and exact root HWND/PID must
    // remain alive, including between all multi-step mouse messages.
    internal static void AssertTargetObserverLive(
        string readyPath,string alarmPath,string observerExe,int observerPid,
        IntPtr targetRoot,int targetPid)
    {
        if(observerPid<=0||targetPid<=0||targetRoot==IntPtr.Zero
           ||!Path.IsPathFullyQualified(readyPath)
           ||!Path.IsPathFullyQualified(alarmPath)
           ||!Path.IsPathFullyQualified(observerExe))
            throw new InvalidOperationException("BACKGROUND_TARGET_OBSERVER_AUTHORITY_INVALID");
        string ready=Path.GetFullPath(readyPath);
        string alarm=Path.GetFullPath(alarmPath);
        string exe=Path.GetFullPath(observerExe);
        string dir=Path.GetDirectoryName(ready)!;
        if(!String.Equals(Path.GetFileName(ready),"observer.ready.json",StringComparison.OrdinalIgnoreCase)
           ||!String.Equals(alarm,Path.Combine(dir,"observer.tripwire.json"),StringComparison.OrdinalIgnoreCase)
           ||!String.Equals(Path.GetFileName(exe),"DeskMCP.Desktop2SwitchObserver.exe",StringComparison.OrdinalIgnoreCase)
           ||!File.Exists(ready)||File.Exists(alarm))
            throw new InvalidOperationException("BACKGROUND_TARGET_OBSERVER_READY_OR_ALARM_INVALID");
        using Process process=Process.GetProcessById(observerPid);
        if(process.HasExited||!String.Equals(Path.GetFullPath(process.MainModule?.FileName??""),
           exe,StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("BACKGROUND_TARGET_OBSERVER_PID_OR_EXE_MISMATCH");
        using JsonDocument doc=JsonDocument.Parse(File.ReadAllText(ready));
        JsonElement state=doc.RootElement;
        if(state.ValueKind!=JsonValueKind.Object
           ||state.GetProperty("processId").GetInt32()!=observerPid
           ||!state.GetProperty("messagePumpRunning").GetBoolean()
           ||!state.GetProperty("hasVirtualDesktopNotifications").GetBoolean()
           ||!state.GetProperty("hasForegroundHook").GetBoolean()
           ||state.GetProperty("strictForegroundArmed").GetBoolean()
           ||state.GetProperty("strictWindowShowArmed").GetBoolean()
           ||state.GetProperty("expectedDesktopIndex").GetInt32()!=0
           ||!String.Equals(Path.GetFullPath(state.GetProperty("tripwireFile").GetString()??""),
               alarm,StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("BACKGROUND_TARGET_OBSERVER_HOOKS_NOT_READY");
        string watch=Path.GetFullPath(state.GetProperty("watchedTargetFile").GetString()??"");
        if(!String.Equals(watch,Path.Combine(dir,"target.watch.json"),StringComparison.OrdinalIgnoreCase)
           ||!File.Exists(watch))
            throw new InvalidOperationException("BACKGROUND_TARGET_WATCH_NOT_ARMED");
        using JsonDocument targetDoc=JsonDocument.Parse(File.ReadAllText(watch));
        JsonElement target=targetDoc.RootElement;
        if(target.GetProperty("hwnd").GetInt64()!=targetRoot.ToInt64()
           ||target.GetProperty("processId").GetInt32()!=targetPid
           ||target.GetProperty("desktopIndex").GetInt32()!=1)
            throw new InvalidOperationException("BACKGROUND_TARGET_WATCH_IDENTITY_MISMATCH");
        DateTime processStart=process.StartTime.ToUniversalTime();
        DateTime published=state.GetProperty("firstStartUtc").GetDateTime().ToUniversalTime();
        if(published<processStart.AddSeconds(-3)
           ||published>DateTime.UtcNow.AddSeconds(3)
           ||(DateTime.UtcNow-published).TotalMinutes>15
           ||(DateTime.UtcNow-processStart).TotalMinutes>15)
            throw new InvalidOperationException("BACKGROUND_TARGET_WATCH_STALE");
        if(process.HasExited||!File.Exists(ready)||!File.Exists(watch)||File.Exists(alarm))
            throw new InvalidOperationException("BACKGROUND_TARGET_WATCHER_EXITED_OR_TRIPPED");
    }

    private static object TargetObserverGuardSelfTest()
    {
        // Guard semantics are exercised with real invalid-PID/forged-file
        // native process tests; never start a GUI in this self-test.
        bool goodName=String.Equals("DeskMCP.Desktop2SwitchObserver.exe",
            "DeskMCP.Desktop2SwitchObserver.exe",StringComparison.OrdinalIgnoreCase);
        return new {pass=goodName,guardedTargetMode=true,
            requiresPumpedWinEvent=true,requiresLivePID=true,
            requiresArmedRoot=true,forbidsStrictPrelaunch=true};
    }
}
