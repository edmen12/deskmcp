// Candidate-only WPF HUD window-placement probe: uses actual AgentDesktopOverlay class
// from the separately compiled candidate Control Panel, not a second Panel.
// Never switches desktops, presses keys, clicks, or writes production lease files.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;

internal static class CandidateHudPlacementProbe
{
    private static readonly string DefaultControlPath =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DesktopMCP", "agent-desktop", "control.json");
    private static bool HasOwnedLiveLease(string leaseId, Guid desktopId)
    {
        using JsonDocument json=JsonDocument.Parse(File.ReadAllText(DefaultControlPath));
        var root=json.RootElement;
        JsonElement controls;
        if(!root.TryGetProperty("controls",out controls) ||
           controls.ValueKind!=JsonValueKind.Array)return false;
        foreach(var item in controls.EnumerateArray()) {
            if(item.TryGetProperty("leaseId",out var id) &&
               item.TryGetProperty("desktopId",out var desktop) &&
               string.Equals(id.GetString(),leaseId,StringComparison.OrdinalIgnoreCase) &&
               Guid.TryParse(desktop.GetString(),out Guid actual) && actual==desktopId)
                return true;
        }
        return false;
    }
    private static bool WaitFor(Task task,int maxMs)
    {
        var dispatcher=Dispatcher.CurrentDispatcher;
        var frame=new DispatcherFrame();
        using var timeout=new CancellationTokenSource(maxMs);
        timeout.Token.Register(()=>dispatcher.BeginInvoke((Action)(()=>frame.Continue=false)));
        task.ContinueWith(_=>dispatcher.BeginInvoke((Action)(()=>frame.Continue=false)));
        Dispatcher.PushFrame(frame);
        return task.IsCompleted;
    }
    // Called ONLY by the test-mode managed bootstrap already running on STA.
    internal static int Run(Assembly panel, string[] args)
    {
        if(args.Length!=4 || args[0]!="--hud-placement-probe" ||
           !Guid.TryParse(args[1],out var desktopId) ||
           !Guid.TryParse(args[2],out var leaseId) ||
           !int.TryParse(args[3],out int durationMs) ||
           durationMs<1500 || durationMs>15000)
            return 2;
        if(!HasOwnedLiveLease(leaseId.ToString("D"),desktopId)) {
            Console.Error.WriteLine("HUD_TEST_LEASE_NOT_ACTIVE");
            return 3;
        }
        System.Windows.Threading.Dispatcher dispatcher=Dispatcher.CurrentDispatcher;
        SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(dispatcher));
        // Direct use of genuine candidate AgentDesktopOverlay, not a simplified fake.
        var type=panel.GetType("AgentDesktopOverlay",throwOnError:true)!;
        var overlay=Activator.CreateInstance(type,BindingFlags.NonPublic|BindingFlags.Public|
            BindingFlags.Instance,null,new object[]{"Isolated HUD placement test",new Action(()=>{})},null)!;
        try {
            var show=type.GetMethod("ShowOnDesktopAsync",BindingFlags.Public|BindingFlags.Instance)!;
            var isOn=type.GetMethod("IsOnDesktop",BindingFlags.Public|BindingFlags.Instance)!;
            var details=type.GetProperty("PlacementDiagnostics",BindingFlags.Public|BindingFlags.Instance)!;
            bool stillAllowed()=>HasOwnedLiveLease(leaseId.ToString("D"),desktopId);
            var task=(Task)show.Invoke(overlay,new object[]{desktopId,new Func<bool>(stillAllowed)})!;
            if(!WaitFor(task,6000))throw new TimeoutException("HUD candidate placement timed out");
            task.GetAwaiter().GetResult();
            int checkedCount=0;
            int wrongCount=0;
            var watch=Stopwatch.StartNew();
            while(watch.ElapsedMilliseconds<durationMs) {
                bool correct=(bool)isOn.Invoke(overlay,new object[]{desktopId})!;
                if(!correct || !stillAllowed())++wrongCount;
                ++checkedCount;
                var delay=Task.Delay(125);
                if(!WaitFor(delay,1000))throw new TimeoutException("HUD dispatcher stopped");
            }
            var location=(string)details.GetValue(overlay)!;
            Console.WriteLine($"WPF_CANDIDATE_HUD_PLACEMENT checks={checkedCount} mismatches={wrongCount} elapsed_ms={watch.ElapsedMilliseconds} {location}");
            return checkedCount>=8 && wrongCount==0?0:8;
        }
        finally {
            ((IDisposable)overlay).Dispose();
        }
    }
}
