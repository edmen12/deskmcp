using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Threading;

// Runs the actual Control Panel Coordinator.Tick() and safety HUD checks under
// a strict private data root. It NEVER starts the candidate/production Gateway,
// allocates a production lease, registers a desktop-switch hook, or grants input.
// This is a synthetic isolated lease, not a real DeskMCP Gateway control.
internal static class AgentDesktopCoordinatorIsolatedProbe
{
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetCurrentDesktopNumber();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetDesktopNumberById(Guid id);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void ForegroundProc(IntPtr hook, uint eventType, IntPtr hwnd,
        int objectId,int childId,uint thread,uint time);
    [DllImport("user32.dll", SetLastError=true)]
    private static extern IntPtr SetWinEventHook(uint first,uint last,IntPtr module,
        ForegroundProc callback,uint pid,uint tid,uint flags);
    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hook);
    private static int ownForegroundCount;
    private static readonly ForegroundProc WatchForeground=(_,_,hwnd,_,_,_,_)=>{
        if(hwnd==IntPtr.Zero)return;
        GetWindowThreadProcessId(hwnd,out uint pid);
        if(pid==unchecked((uint)Environment.ProcessId)) Interlocked.Increment(ref ownForegroundCount);
    };

    private sealed class Result
    {
        public string status{get;set;}="not_started";
        public string failure{get;set;}="";
        public long elapsed_ms{get;set;}
        public int hud_heartbeat_checks{get;set;}
        public int hud_generation{get;set;}
        public bool hud_armed{get;set;}
        public bool hud_visible{get;set;}
        public int own_foreground_events{get;set;}
        public bool desktop1_remained_current{get;set;}
        public bool local_control_active_until_exit{get;set;}
        public bool synthetic_exit_event_fired{get;set;}
        public bool local_control_revoked_by_exit{get;set;}
        public bool hud_file_removed_on_exit{get;set;}
        public bool production_lease_requested{get;set;}=false;
        public bool desktop_switch_hook_registered{get;set;}=false;
    }

    private static bool Heartbeat(string path,string lease,int generation, out bool visible)
    {
        visible=false;
        if (!File.Exists(path))return false;
        try
        {
            using JsonDocument data=JsonDocument.Parse(File.ReadAllText(path));
            var entries=data.RootElement.GetProperty("entries");
            if(entries.GetArrayLength()!=1)return false;
            var item=entries[0];
            bool armed=item.GetProperty("armed").GetBoolean();
            visible=item.GetProperty("visible").GetBoolean();
            int currentGeneration=item.GetProperty("generation").GetInt32();
            int ownerPid=item.GetProperty("processId").GetInt32();
            string liveLease=item.GetProperty("leaseId").GetString();
            DateTime stamp=DateTime.Parse(item.GetProperty("heartbeatAtUtc").GetString(),
                null,System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();
            return armed && !visible && currentGeneration==generation &&
                ownerPid==Environment.ProcessId &&
                String.Equals(liveLease,lease,StringComparison.OrdinalIgnoreCase) &&
                DateTime.UtcNow-stamp<TimeSpan.FromSeconds(2);
        }
        catch{return false;}
    }

    [STAThread]
    internal static int Run(string[] args)
    {
        Result result=new();
        string resultPath=null, controlPath=null, hudPath=null;
        AgentDesktopControlCoordinator coordinator=null;
        Window ownerWindow=null;
        AgentDesktopVirtualDesktopClient desktop=null;
        IntPtr foregroundHook=IntPtr.Zero;
        int exitCode=9;
        try
        {
            if(args.Length!=2 || !Int32.TryParse(args[1],out int seconds) ||
                seconds<30 || seconds>300)
                throw new InvalidOperationException("BOUNDED_COORDINATOR_PROBE_ARGS_REQUIRED");
            if(Environment.GetEnvironmentVariable("DESKTOP_MCP_INSTANCE_NAMESPACE")!="ownerless-isolated-smoke-20261024" ||
                Environment.GetEnvironmentVariable("DESKTOP_MCP_DISABLE_TUNNEL")!="1" ||
                Environment.GetEnvironmentVariable("DESKTOP_MCP_AGENT_DESKTOP_OWNERLESS_SAFETY_WINDOWS_EXPERIMENT")!="1")
                throw new InvalidOperationException("ISOLATED_TEST_ENV_REQUIRED");
            string root=Path.GetFullPath(Environment.GetEnvironmentVariable("DESKTOP_MCP_DATA_ROOT")??"")
                .TrimEnd(Path.DirectorySeparatorChar);
            string only=Path.GetFullPath(@"C:\Users\User\Desktop\DeskMCP-ComputerUse-Core-20261023\test-area\ownerless-isolation-smoke\data")
                .TrimEnd(Path.DirectorySeparatorChar);
            if(!String.Equals(root,only,StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("EXACT_PRIVATE_TEST_ROOT_REQUIRED");
            resultPath=Path.Combine(root,"coordinator-probe-result.json");
            string configPath=Path.Combine(root,"agent-desktop","config.json");
            controlPath=Path.Combine(root,"agent-desktop","control.json");
            hudPath=Path.Combine(root,"agent-desktop","hud-state.json");
            var binding=JsonSerializer.Deserialize<AgentDesktopBindingPoolDocument>(File.ReadAllText(configPath));
            if(binding?.SchemaVersion!=2 || binding.Bindings?.Count!=1 ||
                binding.Bindings[0].DesktopNumber!=2 ||
                !Guid.TryParse(binding.Bindings[0].DesktopId,out Guid expected) || expected==Guid.Empty)
                throw new InvalidOperationException("ONE_VALID_ISOLATED_D2_BINDING_REQUIRED");
            string host=Environment.GetEnvironmentVariable("DESKTOP_MCP_AGENT_DESKTOP_HOST_PATH");
            string vda=Environment.GetEnvironmentVariable("DESKTOP_MCP_VDA_PATH");
            if(!File.Exists(host) || !File.Exists(vda))
                throw new InvalidOperationException("PINNED_HOST_AND_VDA_REQUIRED");
            desktop=new AgentDesktopVirtualDesktopClient(vda);
            if(desktop.CurrentDesktopNumber()!=0 || desktop.DesktopNumberById(expected)!=1)
                throw new InvalidOperationException("OWNER_D1_BOUND_D2_PRECHECK_FAILED");
            if(File.Exists(controlPath))
            {
                var existing=JsonSerializer.Deserialize<AgentDesktopControlPoolDocument>(File.ReadAllText(controlPath));
                if(existing?.Controls==null || existing.Controls.Count!=0)
                    throw new InvalidOperationException("ISOLATED_ROOT_HAS_ACTIVE_CONTROL");
            }

            var app=new Application{ShutdownMode=ShutdownMode.OnExplicitShutdown};
            foregroundHook=SetWinEventHook(3,3,IntPtr.Zero,WatchForeground,0,0,0);
            if(foregroundHook==IntPtr.Zero)throw new InvalidOperationException("WIN_EVENT_HOOK_FAILED");
            ownerWindow=new Window {Left=-20000,Top=-20000,Width=1,Height=1,
                ShowInTaskbar=false,ShowActivated=false,Opacity=0};
            string projectRoot=@"C:\Users\User\Desktop\DeskMCP-ComputerUse-Core-20261023";
            coordinator=new AgentDesktopControlCoordinator(root,
                Path.Combine(projectRoot,"control-panel","wpf","bin","Release","net10.0-windows","win-x64"),
                projectRoot,ownerWindow,(_,_)=>{});
            // Do not call Start(): it would register a desktop-switch hook and
            // revoke a preexisting active lease. Instead drive REAL private
            // Tick() with the original 450ms cadence under the WPF dispatcher.
            MethodInfo tick=typeof(AgentDesktopControlCoordinator).GetMethod("Tick",
                BindingFlags.NonPublic|BindingFlags.Instance);
            if(tick==null)throw new InvalidOperationException("REAL_CONTROL_TICK_MISSING");
            string lease=Guid.NewGuid().ToString("D");
            DateTime now=DateTime.UtcNow;
            int generation=1;
            var existingDoc=File.Exists(controlPath)
                ? JsonSerializer.Deserialize<AgentDesktopControlPoolDocument>(File.ReadAllText(controlPath))
                : null;
            if(existingDoc!=null)generation=existingDoc.Generation+1;
            var mutation=new AgentDesktopControlMutationDocument {
                Reason="lease_allocated",Generation=generation,
                AtUtc=now.ToString("O"),BeforeCount=0,AfterCount=1,WriterPid=Environment.ProcessId
            };
            var events=existingDoc?.RecentMutations!=null
                ? new List<AgentDesktopControlMutationDocument>(existingDoc.RecentMutations)
                : new List<AgentDesktopControlMutationDocument>();
            events.Add(mutation);
            if(events.Count>32)events.RemoveRange(0,events.Count-32);
            var doc=new AgentDesktopControlPoolDocument {
                SchemaVersion=2,Generation=generation,
                Controls=new List<AgentDesktopControlDocument>{
                    new AgentDesktopControlDocument{
                        SchemaVersion=1,Generation=generation,Active=true,
                        LeaseId=lease,DesktopId=expected.ToString("D"),DesktopNumber=2,
                        TaskLabel="Isolated synthetic coordinator — no Gateway lease",
                        StartedAtUtc=now.ToString("O")
                    }
                },
                LastMutation=mutation, RecentMutations=events
            };
            RuntimeReliability.WriteAllTextAtomic(controlPath,JsonSerializer.Serialize(doc)+"\n",false);

            DispatcherTimer timer=new(DispatcherPriority.Normal){
                Interval=TimeSpan.FromMilliseconds(90)
            };
            Stopwatch watch=Stopwatch.StartNew();
            int ticks=0;
            bool eventDispatched=false;
            bool finalChecked=false;
            app.Dispatcher.BeginInvoke(new Action(()=>{
                // First real Tick creates the actual overlay on target D2.
                tick.Invoke(coordinator,null);
                timer.Tick+=(_,_)=>{
                    try
                    {
                        result.elapsed_ms=watch.ElapsedMilliseconds;
                        result.own_foreground_events=Volatile.Read(ref ownForegroundCount);
                        result.desktop1_remained_current=desktop.CurrentDesktopNumber()==0;
                        if(!result.desktop1_remained_current || result.own_foreground_events>0)
                            throw new InvalidOperationException("USER_DESKTOP_FOREGROUND_INVARIANT_FAILED");
                        if(eventDispatched)
                        {
                            var after=JsonSerializer.Deserialize<AgentDesktopControlPoolDocument>(
                                File.ReadAllText(controlPath));
                            result.local_control_revoked_by_exit=
                                after?.Controls?.Count==0 &&
                                after.LastMutation?.Reason=="control_panel_manual_exit";
                            result.hud_file_removed_on_exit=!File.Exists(hudPath);
                            if(result.local_control_revoked_by_exit && result.hud_file_removed_on_exit)
                            {
                                result.status="SYNTHETIC_COORDINATOR_EXIT_PASS";
                                finalChecked=true;
                                timer.Stop();
                                app.Shutdown();
                            }
                            else if(result.elapsed_ms>seconds*1000L+2500L)
                                throw new InvalidOperationException("EXIT_CLEANUP_INCOMPLETE");
                            return;
                        }
                        var live=JsonSerializer.Deserialize<AgentDesktopControlPoolDocument>(
                            File.ReadAllText(controlPath));
                        result.local_control_active_until_exit=live?.Controls?.Count==1 &&
                            String.Equals(live.Controls[0].LeaseId,lease,StringComparison.OrdinalIgnoreCase);
                        if(!result.local_control_active_until_exit)
                            throw new InvalidOperationException("SYNTHETIC_LEASE_REVOKED_DURING_HEARTBEAT");
                        if(watch.ElapsedMilliseconds>2500)
                        {
                            bool visible;
                            if(!Heartbeat(hudPath,lease,generation,out visible))
                                throw new InvalidOperationException("REAL_HUD_HEARTBEAT_MISSING_OR_STALE");
                            result.hud_heartbeat_checks++;
                            result.hud_armed=true;
                            result.hud_visible=visible;
                            result.hud_generation=generation;
                        }
                        if(watch.ElapsedMilliseconds/450 > ticks)
                        {
                            ticks++;
                            tick.Invoke(coordinator,null);
                        }
                        if(watch.Elapsed.TotalSeconds>=seconds)
                        {
                            // Synthetic WPF click, not physical mouse/UIA input.
                            var overlaysField=typeof(AgentDesktopControlCoordinator).GetField("overlays",
                                BindingFlags.NonPublic|BindingFlags.Instance);
                            var overlays=overlaysField?.GetValue(coordinator) as Dictionary<string,AgentDesktopOverlay>;
                            if(overlays==null || !overlays.TryGetValue(lease,out var safety))
                                throw new InvalidOperationException("REAL_OVERLAY_MISSING_FOR_EXIT");
                            var hudField=typeof(AgentDesktopOverlay).GetField("hudWindow",
                                BindingFlags.NonPublic|BindingFlags.Instance);
                            var hud=hudField?.GetValue(safety) as Window;
                            Button exit=hud==null?null:AgentDesktopOverlayIsolatedProbe.FindExitButton(hud);
                            if(exit==null)throw new InvalidOperationException("EXIT_BUTTON_MISSING");
                            eventDispatched=true;
                            result.synthetic_exit_event_fired=true;
                            exit.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent,exit));
                        }
                    }
                    catch(Exception error)
                    {
                        result.status="COORDINATOR_ISOLATED_ACCEPTANCE_FAILED";
                        result.failure=error.GetType().Name+":"+error.Message;
                        timer.Stop();
                        app.Shutdown();
                    }
                };
                timer.Start();
            }),DispatcherPriority.Normal);
            app.Run();
            if(result.status=="SYNTHETIC_COORDINATOR_EXIT_PASS" && finalChecked)
                exitCode=0;
            else exitCode=2;
        }
        catch(Exception error)
        {
            result.status="COORDINATOR_ISOLATED_PREFLIGHT_BLOCKED";
            result.failure=error.GetType().Name+":"+error.Message;
            exitCode=9;
        }
        finally
        {
            try{coordinator?.Shutdown(true);}catch{}
            try{ownerWindow?.Close();}catch{}
            try{desktop?.Dispose();}catch{}
            try{if(foregroundHook!=IntPtr.Zero)UnhookWinEvent(foregroundHook);}catch{}
            result.own_foreground_events=Volatile.Read(ref ownForegroundCount);
            if(resultPath!=null)
            {
                try{
                    File.WriteAllText(resultPath,JsonSerializer.Serialize(result,new JsonSerializerOptions{WriteIndented=true}));
                }catch{}
            }
            GC.KeepAlive(WatchForeground);
        }
        return exitCode;
    }
}
