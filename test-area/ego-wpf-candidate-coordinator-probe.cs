// Isolated candidate ControlCoordinator heartbeat/revocation exercise.
// NEVER calls Coordinator.Start(), which registers global desktop-switch hooks.
// NEVER writes installed control state. A separate private state directory
// holds synthetic test lease/lock/HUD heartbeat. A REAL active DeskMCP D2 lease
// is required and checked continuously before any WPF overlay is created.
using System;
using System.Collections;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;

internal static class CandidateCoordinatorProbe
{
    private static readonly string RealControlPath =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DesktopMCP","agent-desktop","control.json");

    private static bool StillOwned(Guid liveLease, Guid desktop)
    {
        if(!File.Exists(RealControlPath))return false;
        try{
            using var json=JsonDocument.Parse(File.ReadAllText(RealControlPath));
            if(!json.RootElement.TryGetProperty("controls",out var list) || list.ValueKind!=JsonValueKind.Array)
                return false;
            foreach(var entry in list.EnumerateArray()){
                if(entry.TryGetProperty("leaseId",out var lease) &&
                   entry.TryGetProperty("desktopId",out var id) &&
                   Guid.TryParse(lease.GetString(),out var foundLease) &&
                   Guid.TryParse(id.GetString(),out var foundDesktop) &&
                   foundLease==liveLease && foundDesktop==desktop)
                    return true;
            }
        }catch{return false;}
        return false;
    }
    private static void Pump(int timeMs)
    {
        var dispatcher=Dispatcher.CurrentDispatcher;
        var frame=new DispatcherFrame();
        dispatcher.BeginInvoke(DispatcherPriority.Background,new Action(async ()=>{
            await Task.Delay(timeMs);
            frame.Continue=false;
        }));
        Dispatcher.PushFrame(frame);
    }
    private static string IsoStateDir()=>Path.Combine(AppContext.BaseDirectory,"candidate-coordinator-state-"+Guid.NewGuid().ToString("N"));
    private static bool IsCandidateHudFresh(string file,Guid syntheticLease)
    {
        if(!File.Exists(file))return false;
        try{
            using var doc=JsonDocument.Parse(File.ReadAllText(file));
            if(!doc.RootElement.TryGetProperty("entries",out var list))return false;
            foreach(var entry in list.EnumerateArray()){
                if(entry.GetProperty("leaseId").GetString()==syntheticLease.ToString("D") &&
                   entry.GetProperty("armed").GetBoolean() &&
                   entry.GetProperty("processId").GetInt32()==Environment.ProcessId &&
                   DateTime.TryParse(entry.GetProperty("heartbeatAtUtc").GetString(),out var stamp) &&
                   DateTime.UtcNow-stamp.ToUniversalTime()<TimeSpan.FromSeconds(3))
                    return true;
            }
        }catch{return false;}
        return false;
    }
    internal static int Run(Assembly panel,string[] args)
    {
        if(args.Length!=4 || args[0]!="--coordinator-isolated-probe" ||
           !Guid.TryParse(args[1],out var desktop) ||
           !Guid.TryParse(args[2],out var realLease) ||
           !int.TryParse(args[3],out int durationMs) ||
           durationMs<2500 || durationMs>14000)return 2;
        if(!StillOwned(realLease,desktop))return 3;
        // Keep async Tick/ShowOnDesktopAsync continuations on the WPF STA.
        var dispatcher=Dispatcher.CurrentDispatcher;
        SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(dispatcher));
        var isolated=IsoStateDir();
        var agentDir=Path.Combine(isolated,"agent-desktop");
        Directory.CreateDirectory(agentDir);
        var config=Path.Combine(agentDir,"config.json");
        var control=Path.Combine(agentDir,"control.json");
        var hud=Path.Combine(agentDir,"hud-state.json");
        var errors=Path.Combine(agentDir,"control-error.log");
        var ownLease=Guid.NewGuid();
        var now=DateTime.UtcNow.ToString("O");
        var notifyCount=0;
        var ownWindow=new Window {Title="DeskMCP isolated coordinator test owner",ShowInTaskbar=false,ShowActivated=false};
        object? coordinator=null;
        try {
            File.WriteAllText(config,JsonSerializer.Serialize(new {
                schemaVersion=2,bindings=new[]{new {schemaVersion=1,desktopId=desktop.ToString("D"),
                  desktopNumber=2,boundAtUtc=now}}
            }));
            File.WriteAllText(control,JsonSerializer.Serialize(new {
                schemaVersion=2,generation=1,controls=new[]{new {
                    schemaVersion=1,generation=1,active=true,leaseId=ownLease.ToString("D"),
                    desktopId=desktop.ToString("D"),desktopNumber=2,taskLabel="Candidate isolated D2",
                    taskId="isolated-test",startedAtUtc=now,revokedAtUtc=(string?)null
                }}
            }));
            var coordinatorType=panel.GetType("AgentDesktopControlCoordinator",throwOnError:true)!;
            string installed=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs","DesktopMCP");
            coordinator=Activator.CreateInstance(coordinatorType,BindingFlags.Public|BindingFlags.NonPublic|
                BindingFlags.Instance,null,new object[]{isolated,installed,AppContext.BaseDirectory,
                    ownWindow,new Action<string,bool>((_,__)=>notifyCount++)},null)!;
            // DO NOT call Start(). Start() revokes stale leases and registers a
            // process-global desktop-switch hook. Only private Tick on private state.
            var tick=coordinatorType.GetMethod("Tick",BindingFlags.NonPublic|BindingFlags.Instance)!;
            var overlayField=coordinatorType.GetField("overlays",BindingFlags.NonPublic|BindingFlags.Instance)!;
            int checks=0, mismatches=0, heartbeats=0;
            var timer=Stopwatch.StartNew();
            while(timer.ElapsedMilliseconds<durationMs){
                if(!StillOwned(realLease,desktop))throw new InvalidOperationException("Real D2 lease lost");
                tick.Invoke(coordinator,null);
                Pump(190);
                if(!StillOwned(realLease,desktop))throw new InvalidOperationException("Real D2 lease lost");
                var overlays=(IDictionary)overlayField.GetValue(coordinator)!;
                if(overlays.Count!=1){++mismatches;continue;}
                foreach(DictionaryEntry item in overlays){
                    var owner=item.Value!;
                    var overlayType=owner.GetType();
                    bool located=(bool)overlayType.GetMethod("IsOnDesktop")!.Invoke(owner,new object[]{desktop})!;
                    if(!located)++mismatches;
                    ++checks;
                }
                if(IsCandidateHudFresh(hud,ownLease))++heartbeats;
            }
            if(checks<8 || heartbeats<8 || mismatches!=0)throw new InvalidOperationException(
                $"Heartbeat/placement failure checks={checks} heartbeats={heartbeats} mismatches={mismatches}");
            // Failure path: corrupt ONLY candidate binding configuration and
            // verify candidate coordinator revokes ITS OWN synthetic lease.
            File.WriteAllText(config,"{\"schemaVersion\":2,\"bindings\":[]}");
            tick.Invoke(coordinator,null);
            Pump(240);
            tick.Invoke(coordinator,null);
            Pump(240);
            using var final=JsonDocument.Parse(File.ReadAllText(control));
            int remaining=final.RootElement.GetProperty("controls").GetArrayLength();
            bool rejectionLog=File.Exists(errors) &&
                File.ReadAllText(errors).Contains("binding disappeared",StringComparison.OrdinalIgnoreCase);
            Console.WriteLine($"WPF_REAL_COORDINATOR_TEST checks={checks} fresh_heartbeats={heartbeats} mismatches={mismatches} "+
                $"local_leases_after_fault={remaining} local_revoke_log={rejectionLog} notifications={notifyCount} "+
                $"elapsed_ms={timer.ElapsedMilliseconds}");
            return remaining==0 && rejectionLog && mismatches==0?0:8;
        }catch(Exception ex){
            Console.Error.WriteLine("WPF_COORDINATOR_CANDIDATE_FAIL="+ex.GetType().Name+": "+ex.Message);
            return 9;
        }finally {
            if(coordinator is IDisposable disposable)disposable.Dispose();
            ownWindow.Close();
            try{Directory.Delete(isolated,recursive:true);}catch{}
        }
    }
}
