using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

namespace DeskMCP.AgentDesktopHost;

internal static partial class Program
{
    // Candidate-only: no activation, ShowWindow, global input, clipboard or
    // desktop switching. This only places one hidden, freshly spawned Winver
    // HWND. The strict early SHOW/foreground watcher is still mandatory on
    // the calling side: a guard cannot undo the app's FIRST focus steal.
    [DllImport("user32.dll",EntryPoint="GetAncestor")]
    private static extern IntPtr HiddenMoveGetAncestor(IntPtr hwnd,uint kind);
    [DllImport("user32.dll",EntryPoint="GetForegroundWindow")]
    private static extern IntPtr HiddenMoveGetForegroundWindow();

    private static Process VerifyFreshOwnedWinver(int pid,string startedAtUtc)
    {
        if(!DateTimeOffset.TryParse(startedAtUtc,out var expectedStart))
            throw new ArgumentException("EXTERNAL_PROBE_VALID_START_TIME_REQUIRED");
        Process process=Process.GetProcessById(pid);
        try
        {
            if(process.HasExited
                || !String.Equals(process.ProcessName,"winver",StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("EXTERNAL_PROBE_ONLY_WINVER_PROCESS_ALLOWED");
            string expectedPath=Path.GetFullPath(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                "System32","winver.exe"));
            if(!String.Equals(Path.GetFullPath(process.MainModule?.FileName??""),
                expectedPath,StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("EXTERNAL_PROBE_SYSTEM32_WINVER_PATH_REQUIRED");
            DateTimeOffset actualStart=new(process.StartTime.ToUniversalTime(),TimeSpan.Zero);
            if(Math.Abs((actualStart-expectedStart).TotalSeconds)>4
                ||(DateTimeOffset.UtcNow-actualStart).TotalSeconds>60
                ||actualStart>DateTimeOffset.UtcNow.AddSeconds(5))
                throw new InvalidOperationException("EXTERNAL_PROBE_PROCESS_START_PROOF_FAILED");
            return process;
        }
        catch {process.Dispose();throw;}
    }

    internal static bool HiddenMoveEligible(bool isRoot,bool hidden,bool owned,
        bool isForeground,bool ownerDesktop1,bool sourceDesktop1,bool destinationDesktop2)
        =>isRoot&&hidden&&owned&&!isForeground&&ownerDesktop1
          &&sourceDesktop1&&destinationDesktop2;

    private static void AssertFreshHiddenWindow(IntPtr hwnd,int pid,Guid expectedDesktopId,
        int expectedNativeDesktop,VirtualDesktopAccessor vda)
    {
        if(!IsWindow(hwnd))
            throw new InvalidOperationException("HIDDEN_MOVE_WINDOW_NOT_LIVE");
        GetWindowThreadProcessId(hwnd,out uint owner);
        if(!HiddenMoveEligible(
            HiddenMoveGetAncestor(hwnd,2)==hwnd,
            !IsWindowVisible(hwnd),owner==(uint)pid,
            HiddenMoveGetForegroundWindow()==hwnd,
            vda.CurrentDesktopNumber()==0,
            vda.WindowDesktopNumber(hwnd)==expectedNativeDesktop,
            GetDesktopId(hwnd)==expectedDesktopId))
            throw new InvalidOperationException("HIDDEN_MOVE_OWNER_ROOT_VISIBILITY_OR_DESKTOP_MISMATCH");
    }

    private static object MoveOwnedHiddenWinver(IntPtr hwnd,int pid,string startedUtc,
        Guid desktopId,string observerReady,string observerTripwire,
        string observerExe,int observerPid,VirtualDesktopAccessor vda)
    {
        // Fixed destination is the real Windows virtual Desktop2, not a
        // private Win32 Desktop Object. No ShowWindow or activation options.
        if(!vda.Available || vda.CurrentDesktopNumber()!=0
            || vda.DesktopNumberById(desktopId)!=1)
            throw new InvalidOperationException("HIDDEN_MOVE_DESKTOP1_TO_DESKTOP2_ONLY");
        Guid? desktop1Id=vda.DesktopIdByNumber(0);
        if(!desktop1Id.HasValue||desktop1Id==desktopId)
            throw new InvalidOperationException("HIDDEN_MOVE_INVALID_DESKTOP_PAIR");
        AssertStrictObserverLive(observerReady,observerTripwire,observerExe,observerPid);
        using Process owner=VerifyFreshOwnedWinver(pid,startedUtc);
        AssertFreshHiddenWindow(hwnd,pid,desktop1Id.Value,0,vda);
        // The same PID/start proof and exact hidden HWND are checked
        // immediately before the untrusted VDA move.
        if(owner.HasExited)throw new InvalidOperationException("HIDDEN_MOVE_WINVER_EXITED");
        AssertFreshHiddenWindow(hwnd,pid,desktop1Id.Value,0,vda);
        AssertStrictObserverLive(observerReady,observerTripwire,observerExe,observerPid);
        MoveWindowCore(hwnd,desktopId,1,false,false,vda);
        AssertStrictObserverLive(observerReady,observerTripwire,observerExe,observerPid);
        // After a move, even a successful VDA HRESULT is NOT enough.
        AssertFreshHiddenWindow(hwnd,pid,desktopId,1,vda);
        IVirtualDesktopManager manager=CreateManager();
        try{
            if(manager.IsWindowOnCurrentVirtualDesktop(hwnd))
                throw new InvalidOperationException("HIDDEN_MOVE_SHARED_WITH_DESKTOP1");
        }
        finally{if(Marshal.IsComObject(manager))Marshal.FinalReleaseComObject(manager);}
        return new {
            hwnd=HwndText(hwnd),desktopId=desktopId.ToString("D"),
            desktopNumber=2,onCurrentDesktop=false,isVisible=false,
            hiddenMoveVerified=true,ownerProcessId=pid
        };
    }

    private static object HiddenMoveSelfTest()
    {
        bool eligible=HiddenMoveEligible(true,true,true,false,true,true,true);
        bool deniesVisible=!HiddenMoveEligible(true,false,true,false,true,true,true);
        bool deniesForeign=!HiddenMoveEligible(true,true,false,false,true,true,true);
        bool deniesForeground=!HiddenMoveEligible(true,true,true,true,true,true,true);
        bool deniesNonroot=!HiddenMoveEligible(false,true,true,false,true,true,true);
        bool deniesWrongOwner=!HiddenMoveEligible(true,true,true,false,false,true,true);
        bool deniesWrongSource=!HiddenMoveEligible(true,true,true,false,true,false,true);
        bool deniesWrongTarget=!HiddenMoveEligible(true,true,true,false,true,true,false);
        return new {
            pass=eligible&&deniesVisible&&deniesForeign&&deniesForeground
               &&deniesNonroot&&deniesWrongOwner&&deniesWrongSource&&deniesWrongTarget,
            eligible,deniesVisible,deniesForeign,deniesForeground,deniesNonroot,
            deniesWrongOwner,deniesWrongSource,deniesWrongTarget
        };
    }
}
