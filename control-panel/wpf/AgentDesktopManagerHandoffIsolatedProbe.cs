using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Collections.Generic;
using System.Windows.Controls;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Windows;
using System.Windows.Threading;

internal static class AgentDesktopManagerHandoffIsolatedProbe
{
    // THIS FILE IS AN ISOLATED TEST ONLY. It drives the actual Coordinator
    // Start/Tick/Shutdown, with no production lease, no Gateway HTTP listener,
    // no browser/control capabilities or manual desktop switching.
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void ForegroundCallback(IntPtr hook,uint evt,IntPtr hwnd,int objectId,int childId,uint thread,uint time);
    [DllImport("user32.dll",SetLastError=true)]
    private static extern IntPtr SetWinEventHook(uint first,uint last,IntPtr module,
        ForegroundCallback callback,uint processId,uint threadId,uint flags);
    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hook);
    private static int foregroundCount;
    private static readonly ForegroundCallback OnForeground=(_,_,hwnd,_,_,_,_)=>{
        if(hwnd==IntPtr.Zero)return;
        GetWindowThreadProcessId(hwnd,out uint pid);
        if(pid==unchecked((uint)Environment.ProcessId))Interlocked.Increment(ref foregroundCount);
    };
    private sealed class Check
    {
        public string status {get;set;}="not_started";
        public string error {get;set;}="";
        public long elapsed_ms {get;set;}
        public int samples {get;set;}
        public int hud_heartbeat_valid_samples {get;set;}
        public int active_lease_samples {get;set;}
        public int foreground_events_owned {get;set;}
        public bool owner_remained_desktop1 {get;set;}
        public bool manager_allocator_observed {get;set;}
        public bool exit_reason_explicit_stop {get;set;}
        public bool hud_removed_after_stop {get;set;}
        public bool uia_exit_invoke_dispatched {get;set;}
        public bool uia_exit_mutation_confirmed {get;set;}
        public bool did_register_virtual_desktop_hook {get;set;}
        public bool real_coordinator_start {get;set;}
        public bool called_production_gateway {get;set;}=false;
    }
    [STAThread]
    internal static int Run(string[] args)
    {
        Check result=new();
        string resultPath=null,readyPath=null,controlPath=null,hudPath=null;
        AgentDesktopControlCoordinator coordinator=null;
        Window invisibleOwner=null;
        AgentDesktopVirtualDesktopClient desktop=null;
        IntPtr foregroundHook=IntPtr.Zero;
        int code=9;
        try
        {
            bool ownUiaExit=args.Length==3 && args[2]=="OWN_HUD_UIA_EXIT";
            if((args.Length!=2 && !ownUiaExit) || !int.TryParse(args[1],out int seconds) ||
                seconds<45 || seconds>240)
                throw new InvalidOperationException("EXACT_BOUNDED_HANDOFF_ARGS_REQUIRED");
            if(Environment.GetEnvironmentVariable("DESKTOP_MCP_INSTANCE_NAMESPACE")!="ownerless-handoff-20261024" ||
                Environment.GetEnvironmentVariable("DESKTOP_MCP_DISABLE_TUNNEL")!="1" ||
                Environment.GetEnvironmentVariable("DESKTOP_MCP_AGENT_DESKTOP_OWNERLESS_SAFETY_WINDOWS_EXPERIMENT")!="1")
                throw new InvalidOperationException("TEST_FLAGS_REQUIRED");
            string actual=Path.GetFullPath(Environment.GetEnvironmentVariable("DESKTOP_MCP_DATA_ROOT")??"")
                .TrimEnd(Path.DirectorySeparatorChar);
            string required=Path.GetFullPath(@"C:\Users\User\Desktop\DeskMCP-ComputerUse-Core-20261023\test-area\ownerless-gateway-handoff\data")
                .TrimEnd(Path.DirectorySeparatorChar);
            if(!String.Equals(actual,required,StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("EXACT_TEST_DATA_ROOT_REQUIRED");
            string root=Path.Combine(actual,"agent-desktop");
            controlPath=Path.Combine(root,"control.json");
            hudPath=Path.Combine(root,"hud-state.json");
            readyPath=Path.Combine(actual,"coordinator-ready.json");
            resultPath=Path.Combine(actual,"manager-handoff-result.json");
            if(File.Exists(readyPath))File.Delete(readyPath);
            if(File.Exists(controlPath))
            {
                var previous=JsonSerializer.Deserialize<AgentDesktopControlPoolDocument>(File.ReadAllText(controlPath));
                if(previous?.Controls?.Count!=0)
                    throw new InvalidOperationException("PRIVATE_STATE_BUSY_PRECHECK");
            }
            var bindings=JsonSerializer.Deserialize<AgentDesktopBindingPoolDocument>(
                File.ReadAllText(Path.Combine(root,"config.json")));
            if(bindings?.SchemaVersion!=2 || bindings.Bindings?.Count!=1 ||
                bindings.Bindings[0].DesktopNumber!=2 ||
                !Guid.TryParse(bindings.Bindings[0].DesktopId,out Guid target) || target==Guid.Empty)
                throw new InvalidOperationException("PRIVATE_DESKTOP2_BINDING_REQUIRED");
            string host=Environment.GetEnvironmentVariable("DESKTOP_MCP_AGENT_DESKTOP_HOST_PATH");
            string vda=Environment.GetEnvironmentVariable("DESKTOP_MCP_VDA_PATH");
            if(!File.Exists(host) || !File.Exists(vda))
                throw new InvalidOperationException("PINNED_NATIVE_ASSETS_REQUIRED");
            desktop=new AgentDesktopVirtualDesktopClient(vda);
            if(desktop.CurrentDesktopNumber()!=0 || desktop.DesktopNumberById(target)!=1)
                throw new InvalidOperationException("CURRENT_D1_AND_TARGET_D2_REQUIRED");
            var app=new Application { ShutdownMode=ShutdownMode.OnExplicitShutdown };
            foregroundHook=SetWinEventHook(3,3,IntPtr.Zero,OnForeground,0,0,0);
            if(foregroundHook==IntPtr.Zero)throw new InvalidOperationException("FOREGROUND_MONITOR_REQUIRED");
            invisibleOwner=new Window {
                Left=-20000,Top=-20000,Width=1,Height=1,Opacity=0,
                ShowActivated=false,ShowInTaskbar=false
            };
            string project=@"C:\Users\User\Desktop\DeskMCP-ComputerUse-Core-20261023";
            coordinator=new AgentDesktopControlCoordinator(actual,
                Path.Combine(project,"control-panel","wpf","bin","Release","net10.0-windows","win-x64"),
                project,invisibleOwner,(_,_)=>{});
            var timer=new DispatcherTimer(DispatcherPriority.Normal) {
                Interval=TimeSpan.FromMilliseconds(100)
            };
            Stopwatch watch=Stopwatch.StartNew();
            string activeLeaseId=null;
            int generation=0;
            long activeAtMs=-1;
            bool stoppedSeen=false;
            bool uiaRequested=false;
            app.Dispatcher.BeginInvoke(new Action(()=>{
                try
                {
                    coordinator.Start();
                    result.real_coordinator_start=true;
                    var hookField=typeof(AgentDesktopControlCoordinator).GetField(
                        "desktopHookRegistered",BindingFlags.NonPublic|BindingFlags.Instance);
                    result.did_register_virtual_desktop_hook=hookField?.GetValue(coordinator) is bool registered && registered;
                    if(!result.did_register_virtual_desktop_hook)
                        throw new InvalidOperationException("NATIVE_DESKTOP_SWITCH_HOOK_NOT_REGISTERED");
                    File.WriteAllText(readyPath,JsonSerializer.Serialize(new {
                        ready=true,privateRoot=true,desktopNumber=2,
                        owner=Environment.ProcessId,requestedSeconds=seconds,
                        exitMode=ownUiaExit?"own-uia-exit":"manager-explicit-stop"
                    }));
                    timer.Tick+=(_,_)=>{
                        try
                        {
                            result.samples++;
                            result.elapsed_ms=watch.ElapsedMilliseconds;
                            result.owner_remained_desktop1=desktop.CurrentDesktopNumber()==0;
                            result.foreground_events_owned=Volatile.Read(ref foregroundCount);
                            if(!result.owner_remained_desktop1 || result.foreground_events_owned>0)
                                throw new InvalidOperationException("D1_OR_FOREGROUND_INVARIANT_FAILED");
                            AgentDesktopControlPoolDocument state=File.Exists(controlPath)
                                ? JsonSerializer.Deserialize<AgentDesktopControlPoolDocument>(File.ReadAllText(controlPath))
                                : null;
                            if(state==null) return;
                            if(state.Controls.Count==1)
                            {
                                var control=state.Controls[0];
                                if(control.LeaseId==null || control.DesktopId!=target.ToString("D"))
                                    throw new InvalidOperationException("UNKNOWN_TEST_LEASE");
                                if(activeLeaseId==null)
                                {
                                    activeLeaseId=control.LeaseId;
                                    generation=control.Generation;
                                    activeAtMs=watch.ElapsedMilliseconds;
                                    result.manager_allocator_observed=true;
                                    if(state.LastMutation?.Reason!="lease_allocated")
                                        throw new InvalidOperationException("NOT_MANAGER_LEASE_ALLOCATION");
                                }
                                if(control.LeaseId!=activeLeaseId || control.Generation!=generation)
                                    throw new InvalidOperationException("UNEXPECTED_LEASE_REPLACEMENT");
                                result.active_lease_samples++;
                                if(watch.ElapsedMilliseconds-activeAtMs>2500)
                                {
                                    if(!File.Exists(hudPath))
                                        throw new InvalidOperationException("NATIVE_HUD_HEARTBEAT_ABSENT");
                                    using var doc=JsonDocument.Parse(File.ReadAllText(hudPath));
                                    var entries=doc.RootElement.GetProperty("entries");
                                    if(entries.GetArrayLength()!=1)throw new InvalidOperationException("HUD_COUNT_MISMATCH");
                                    var e=entries[0];
                                    DateTime at=DateTime.Parse(e.GetProperty("heartbeatAtUtc").GetString(),
                                        null,System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();
                                    double age=(DateTime.UtcNow-at).TotalMilliseconds;
                                    if(e.GetProperty("leaseId").GetString()!=activeLeaseId ||
                                        e.GetProperty("generation").GetInt32()!=generation ||
                                        e.GetProperty("armed").GetBoolean()!=true ||
                                        e.GetProperty("visible").GetBoolean()!=false ||
                                        age<0 || age>2500)
                                        throw new InvalidOperationException("HUD_HEARTBEAT_INVARIANT_FAILED");
                                    result.hud_heartbeat_valid_samples++;
                                }
                                if(ownUiaExit && !uiaRequested && watch.ElapsedMilliseconds-activeAtMs>25000)
                                {
                                    var overlaysField=typeof(AgentDesktopControlCoordinator).GetField(
                                        "overlays",BindingFlags.NonPublic|BindingFlags.Instance);
                                    var overlays=overlaysField?.GetValue(coordinator) as Dictionary<string,AgentDesktopOverlay>;
                                    if(overlays==null || !overlays.TryGetValue(activeLeaseId,out AgentDesktopOverlay safety))
                                        throw new InvalidOperationException("OWNED_ACTIVE_OVERLAY_NOT_FOUND");
                                    if(safety.DescribeHudDesktop(target)!="correct_desktop" ||
                                        safety.DescribeEdgeDesktop(target)!="correct_desktop" ||
                                        desktop.CurrentDesktopNumber()!=0)
                                        throw new InvalidOperationException("UIA_EXIT_DESKTOP2_PRECONDITION_FAILED");
                                    var hudField=typeof(AgentDesktopOverlay).GetField(
                                        "hudWindow",BindingFlags.NonPublic|BindingFlags.Instance);
                                    var hud=hudField?.GetValue(safety) as Window;
                                    Button exit=hud==null?null:AgentDesktopOverlayIsolatedProbe.FindExitButton(hud);
                                    if(exit==null)throw new InvalidOperationException("OWNED_HUD_EXIT_BUTTON_MISSING");
                                    var peer=new ButtonAutomationPeer(exit);
                                    var invoke=peer.GetPattern(PatternInterface.Invoke) as IInvokeProvider;
                                    if(invoke==null)throw new InvalidOperationException("OWNED_HUD_UIA_INVOKE_MISSING");
                                    uiaRequested=true;
                                    result.uia_exit_invoke_dispatched=true;
                                    invoke.Invoke(); // provider-only; no global mouse/keyboard input
                                }
                            }
                            else if(state.Controls.Count==0 && activeLeaseId!=null)
                            {
                                string requiredReason=ownUiaExit?"control_panel_manual_exit":"explicit_stop";
                                if(state.LastMutation?.Reason!=requiredReason || (ownUiaExit && !uiaRequested))
                                    throw new InvalidOperationException("UNEXPECTED_REVOCATION:"+state.LastMutation?.Reason);
                                stoppedSeen=true;
                                result.exit_reason_explicit_stop=!ownUiaExit;
                                result.uia_exit_mutation_confirmed=ownUiaExit;
                                if(!File.Exists(hudPath))
                                {
                                    result.hud_removed_after_stop=true;
                                    result.status=ownUiaExit?"REAL_MANAGER_UIA_EXIT_PASS":"REAL_MANAGER_HANDOFF_PASS";
                                    timer.Stop(); app.Shutdown();
                                }
                            }
                            else if(state.Controls.Count>1)
                                throw new InvalidOperationException("EXCESS_LEASES");
                            if(watch.Elapsed.TotalSeconds>=seconds+10)
                                throw new TimeoutException("HANDOFF_END_TO_END_TIMEOUT");
                        }
                        catch(Exception ex)
                        {
                            result.status="MANAGER_HANDOFF_FAILED";
                            result.error=ex.GetType().Name+":"+ex.Message;
                            timer.Stop();app.Shutdown();
                        }
                    };
                    timer.Start();
                }
                catch(Exception ex)
                {
                    result.status="COORDINATOR_START_FAILED";
                    result.error=ex.GetType().Name+":"+ex.Message;
                    app.Shutdown();
                }
            }),DispatcherPriority.Normal);
            app.Run();
            code=((result.status=="REAL_MANAGER_HANDOFF_PASS" || result.status=="REAL_MANAGER_UIA_EXIT_PASS")
                && stoppedSeen) ? 0:2;
        }
        catch(Exception ex)
        {
            result.status="HANDOFF_PREFLIGHT_BLOCKED";
            result.error=ex.GetType().Name+":"+ex.Message;
            code=9;
        }
        finally
        {
            try{coordinator?.Shutdown(true);}catch{}
            try{invisibleOwner?.Close();}catch{}
            try{desktop?.Dispose();}catch{}
            try{if(foregroundHook!=IntPtr.Zero)UnhookWinEvent(foregroundHook);}catch{}
            if(readyPath!=null)try{File.Delete(readyPath);}catch{}
            if(resultPath!=null)try{
                File.WriteAllText(resultPath,JsonSerializer.Serialize(result,new JsonSerializerOptions{WriteIndented=true}));
            }catch{}
            GC.KeepAlive(OnForeground);
        }
        return code;
    }
}
