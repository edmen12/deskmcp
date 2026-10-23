using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Text.Json;
using System.Threading;
using System.Windows;
using System.Windows.Threading;
using System.Windows.Interop;

// Candidate-only integration of the REAL AgentDesktopOverlay. No Gateway,
// ControlPanelRuntime, lease allocations, audit writes or production state.
// Must be invoked under a private test root and a named isolated instance.
internal static class AgentDesktopOverlayIsolatedProbe
{
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void ForegroundChanged(IntPtr hook, uint eventType, IntPtr hwnd,
        int objectId, int childId, uint eventThread, uint eventTime);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetCurrentDesktopNumber();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetDesktopNumberById(Guid id);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module,
        ForegroundChanged callback, uint processId, uint threadId, uint flags);
    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr arg);
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr arg);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetWindowTextW")]
    private static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int capacity);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int bytes);

    private static int ownForegroundEvents;
    private static readonly ForegroundChanged ForegroundWatcher = (_, _, hwnd, _, _, _, _) => {
        if (hwnd == IntPtr.Zero) return;
        GetWindowThreadProcessId(hwnd, out uint pid);
        if (pid == unchecked((uint)Environment.ProcessId))
            Interlocked.Increment(ref ownForegroundEvents);
    };

    private static (IntPtr edge, IntPtr hud) GetOwnSafetyWindows()
    {
        IntPtr edge=IntPtr.Zero, hud=IntPtr.Zero;
        EnumWindows((hwnd, _) => {
            GetWindowThreadProcessId(hwnd, out uint pid);
            if (pid != unchecked((uint)Environment.ProcessId)) return true;
            var title = new System.Text.StringBuilder(256);
            GetWindowText(hwnd, title, title.Capacity);
            if (title.ToString() == "DeskMCP Agent Desktop Edge") edge=hwnd;
            if (title.ToString() == "DeskMCP Agent Desktop Control") hud=hwnd;
            return true;
        }, IntPtr.Zero);
        return (edge,hud);
    }

    private sealed class Observation
    {
        public string status {get;set;} = "not_started";
        public string error {get;set;} = "";
        public long elapsed_ms {get;set;}
        public int samples {get;set;}
        public int own_foreground_events {get;set;}
        public bool owner_desktop1 {get;set;}
        public bool edge_correct {get;set;}
        public bool hud_correct {get;set;}
        public bool edge_ownerless {get;set;}
        public bool hud_ownerless {get;set;}
        public int edge_dwm_cloaked {get;set;} = -1;
        public int hud_dwm_cloaked {get;set;} = -1;
        public bool production_control_untouched {get;set;} = true;
        public bool test_lease_created {get;set;} = false;
        public bool overlay_exit_callback_checked {get;set;} = false;
        public bool hud_exit_event_simulated {get;set;} = false;
    }

    internal static Button FindExitButton(DependencyObject current)
    {
        if (current is Button button && String.Equals(button.Content as string,
            "Exit Agent Control", StringComparison.Ordinal)) return button;
        foreach (object item in LogicalTreeHelper.GetChildren(current))
        {
            if (item is DependencyObject child)
            {
                Button nested=FindExitButton(child);
                if(nested!=null) return nested;
            }
        }
        return null;
    }

    // Safety preflight must run BEFORE creating any owned top-level WPF window.
    [STAThread]
    public static int Run(string[] args)
    {
        var result = new Observation();
        IntPtr dll=IntPtr.Zero, eventHook=IntPtr.Zero;
        AgentDesktopOverlay overlay=null;
        AgentDesktopVirtualDesktopClient desktopClient=null;
        string resultPath=null;
        int requestedSeconds=0, exitCode=9;
        try
        {
            bool simulateExit=args.Length == 3 && args[2] == "SYNTHETIC_HUD_BUTTON_EVENT";
            if ((args.Length != 2 && !simulateExit) || !Int32.TryParse(args[1],out requestedSeconds)
                || requestedSeconds < 30 || requestedSeconds > 300)
                throw new InvalidOperationException("EXACT_BOUNDED_OVERLAY_TEST_ARGS_REQUIRED");
            if (Environment.GetEnvironmentVariable("DESKTOP_MCP_AGENT_DESKTOP_OWNERLESS_SAFETY_WINDOWS_EXPERIMENT") != "1"
                || Environment.GetEnvironmentVariable("DESKTOP_MCP_DISABLE_TUNNEL") != "1"
                || Environment.GetEnvironmentVariable("DESKTOP_MCP_INSTANCE_NAMESPACE") != "ownerless-isolated-smoke-20261024")
                throw new InvalidOperationException("ISOLATED_ENVIRONMENT_REQUIRED");
            string rawRoot=Environment.GetEnvironmentVariable("DESKTOP_MCP_DATA_ROOT");
            if (String.IsNullOrWhiteSpace(rawRoot))
                throw new InvalidOperationException("DATA_ROOT_REQUIRED");
            string dataRoot=Path.GetFullPath(rawRoot).TrimEnd(Path.DirectorySeparatorChar);
            string requiredRoot=Path.GetFullPath(@"C:\Users\User\Desktop\DeskMCP-ComputerUse-Core-20261023\test-area\ownerless-isolation-smoke\data")
                .TrimEnd(Path.DirectorySeparatorChar);
            if (!String.Equals(dataRoot,requiredRoot,StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("EXACT_CANDIDATE_DATA_ROOT_REQUIRED");
            resultPath=Path.Combine(dataRoot,"overlay-probe-result.json");
            string bindingFile=Path.Combine(dataRoot,"agent-desktop","config.json");
            AgentDesktopBindingPoolDocument bindings=JsonSerializer.Deserialize<AgentDesktopBindingPoolDocument>(
                File.ReadAllText(bindingFile));
            if (bindings?.SchemaVersion != 2 || bindings.Bindings?.Count != 1
                || bindings.Bindings[0].DesktopNumber != 2
                || !Guid.TryParse(bindings.Bindings[0].DesktopId,out Guid targetId) || targetId == Guid.Empty)
                throw new InvalidOperationException("ONE_ISOLATED_DESKTOP2_BINDING_REQUIRED");
            string vdaPath=Environment.GetEnvironmentVariable("DESKTOP_MCP_VDA_TEST_DLL");
            if(String.IsNullOrWhiteSpace(vdaPath) || !File.Exists(vdaPath))
                throw new InvalidOperationException("VDA_DLL_REQUIRED");
            desktopClient=new AgentDesktopVirtualDesktopClient(vdaPath);
            if (desktopClient.CurrentDesktopNumber()!=0 ||
                desktopClient.DesktopNumberById(targetId)!=1)
                throw new InvalidOperationException("USER_DESKTOP1_AND_BOUND_DESKTOP2_REQUIRED");
            if (GetOwnSafetyWindows() is var existing &&
                (existing.edge != IntPtr.Zero || existing.hud != IntPtr.Zero))
                throw new InvalidOperationException("OWNED_SAFETY_WINDOWS_ALREADY_PRESENT");

            var app=new Application {ShutdownMode=ShutdownMode.OnExplicitShutdown};
            eventHook=SetWinEventHook(3,3,IntPtr.Zero,ForegroundWatcher,0,0,0);
            if(eventHook == IntPtr.Zero)
                throw new InvalidOperationException("FOREGROUND_HOOK_NOT_ARMED");

            var timer=new DispatcherTimer(DispatcherPriority.Normal) {Interval=TimeSpan.FromMilliseconds(90)};
            Stopwatch runtime=Stopwatch.StartNew();
            // The callback can be tested by a local WPF RoutedEvent, not physical input.
            bool running=false;
            Guid expected=targetId;
            overlay=new AgentDesktopOverlay("Isolated Overlay Test — No Lease",()=>{
                // The real HUD Exit button's WPF routed event reaches this callback.
                result.overlay_exit_callback_checked=true;
                result.status="overlay_exit_callback_fired";
                timer.Stop();
                app.Shutdown();
            });
            // Before the event loop, no GUI windows are made visible. The real
            // overlay controls creation+move+verification on the STA dispatcher.
            app.Dispatcher.BeginInvoke(new Action(async ()=>{
                try
                {
                    await overlay.ShowOnDesktopAsync(expected,()=> desktopClient.CurrentDesktopNumber()==0);
                    runtime.Restart();
                    running=true;
                    timer.Tick += (_,_) => {
                        result.samples++;
                        result.elapsed_ms=runtime.ElapsedMilliseconds;
                        result.own_foreground_events=Volatile.Read(ref ownForegroundEvents);
                        result.owner_desktop1=desktopClient.CurrentDesktopNumber()==0;
                        result.edge_correct=overlay.DescribeEdgeDesktop(expected)=="correct_desktop";
                        result.hud_correct=overlay.DescribeHudDesktop(expected)=="correct_desktop";
                        var windows=GetOwnSafetyWindows();
                        result.edge_ownerless=windows.edge != IntPtr.Zero && GetWindow(windows.edge,4)==IntPtr.Zero;
                        result.hud_ownerless=windows.hud != IntPtr.Zero && GetWindow(windows.hud,4)==IntPtr.Zero;
                        int cloakedEdge,cloakedHud;
                        result.edge_dwm_cloaked=windows.edge != IntPtr.Zero
                            && DwmGetWindowAttribute(windows.edge,14,out cloakedEdge,4)==0 ? cloakedEdge:-1;
                        result.hud_dwm_cloaked=windows.hud != IntPtr.Zero
                            && DwmGetWindowAttribute(windows.hud,14,out cloakedHud,4)==0 ? cloakedHud:-1;
                        // Windows Cloak value 2 means DWM_CLOAKED_SHELL; this
                        // is required for safety overlays hidden on owner Desktop1.
                        if (!result.owner_desktop1 || !result.edge_correct || !result.hud_correct
                            || !result.edge_ownerless || !result.hud_ownerless
                            || result.edge_dwm_cloaked != 2 || result.hud_dwm_cloaked != 2
                            || result.own_foreground_events > 0)
                        {
                            result.status="SAFETY_OVERLAY_INVARIANT_FAILED";
                            timer.Stop();
                            app.Shutdown();
                        }
                        else if (runtime.Elapsed.TotalSeconds >= requestedSeconds)
                        {
                            timer.Stop();
                            if (simulateExit)
                            {
                                result.hud_exit_event_simulated=true;
                                var field=typeof(AgentDesktopOverlay).GetField("hudWindow",
                                    BindingFlags.NonPublic|BindingFlags.Instance);
                                Window window=field?.GetValue(overlay) as Window;
                                Button exit=window == null ? null : FindExitButton(window);
                                if(exit == null)
                                {
                                    result.status="HUD_EXIT_CONTROL_NOT_FOUND";
                                    app.Shutdown();
                                }
                                else
                                {
                                    // No mouse, keyboard or UIA dispatch; verify only
                                    // that the real WPF Click wiring reaches the callback.
                                    exit.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent,exit));
                                    if(!result.overlay_exit_callback_checked)
                                    {
                                        result.status="HUD_EXIT_CALLBACK_NOT_CALLED";
                                        app.Shutdown();
                                    }
                                }
                            }
                            else
                            {
                                result.status="OWNERLESS_OVERLAY_LIFECYCLE_PASS";
                                app.Shutdown();
                            }
                        }
                    };
                    timer.Start();
                }
                catch(Exception ex)
                {
                    result.status="OVERLAY_STARTUP_FAILED";
                    result.error=ex.GetType().Name+":"+ex.Message;
                    app.Shutdown();
                }
            }),DispatcherPriority.Normal);
            app.Run();
            result.own_foreground_events=Volatile.Read(ref ownForegroundEvents);
            result.elapsed_ms=runtime.ElapsedMilliseconds;
            if (!running && result.status=="not_started")
                result.status="OVERLAY_NEVER_STARTED";
            if(result.status=="OWNERLESS_OVERLAY_LIFECYCLE_PASS" ||
                (result.status=="overlay_exit_callback_fired" && result.hud_exit_event_simulated))
                exitCode=0;
            else exitCode=2;
        }
        catch(Exception ex)
        {
            result.status="ISOLATED_OVERLAY_PREFLIGHT_BLOCKED";
            result.error=ex.GetType().Name+":"+ex.Message;
            exitCode=9;
        }
        finally
        {
            try {overlay?.Dispose();}catch{}
            try{if(eventHook!=IntPtr.Zero)UnhookWinEvent(eventHook);}catch{}
            try{desktopClient?.Dispose();}catch{}
            if(resultPath!=null)
            {
                try{
                    Directory.CreateDirectory(Path.GetDirectoryName(resultPath));
                    File.WriteAllText(resultPath,JsonSerializer.Serialize(result,new JsonSerializerOptions{WriteIndented=true}));
                }catch{}
            }
            GC.KeepAlive(ForegroundWatcher);
        }
        return exitCode;
    }
}
