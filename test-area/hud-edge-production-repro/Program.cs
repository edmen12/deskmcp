using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Threading;

// Isolated, self-owned WPF reproduction of the installed Edge+HUD pair.
// Never requests a lease, mutates control.json, switches desktops or sends input.
// "effect" enables the production DropShadowEffect; "plain" removes it only.
internal static class Program
{
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
    private interface IVirtualDesktopManager
    {
        [return: MarshalAs(UnmanagedType.Bool)]
        bool IsWindowOnCurrentVirtualDesktop(IntPtr hwnd);
        Guid GetWindowDesktopId(IntPtr hwnd);
        void MoveWindowToDesktop(IntPtr hwnd, ref Guid desktopId);
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetCurrentDesktopNumber();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetDesktopNumberById(Guid id);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr style);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void ForegroundEventProc(IntPtr hook, uint eventType, IntPtr hwnd,
        int objectId, int childId, uint eventThread, uint eventTime);
    [DllImport("user32.dll", SetLastError=true)]
    private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module,
        ForegroundEventProc callback, uint processId, uint threadId, uint flags);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    private static int ownForegroundEvents;
    private static readonly ForegroundEventProc ForegroundWatch = (_, _, hwnd, _, _, _, _) =>
    {
        if (hwnd == IntPtr.Zero) return;
        GetWindowThreadProcessId(hwnd, out uint processId);
        if (processId == unchecked((uint)Environment.ProcessId))
            System.Threading.Interlocked.Increment(ref ownForegroundEvents);
    };

    private const long WsExTransparent = 0x20, WsExNoActivate = 0x08000000L;
    private static Window? edge;
    private static Window? hud;
    private static IVirtualDesktopManager? manager;
    private static IntPtr loadedDll = IntPtr.Zero;
    private static GetCurrentDesktopNumber? current;
    private static int exitCode = 9;

    private static Guid ReadDesktop2Binding(string config)
    {
        using var json = JsonDocument.Parse(File.ReadAllText(config));
        var bindings = json.RootElement.GetProperty("bindings");
        if (bindings.GetArrayLength() != 1 || bindings[0].GetProperty("desktopNumber").GetInt32() != 2)
            throw new InvalidOperationException("EXACT_D2_BINDING_REQUIRED");
        var desktop = Guid.Parse(bindings[0].GetProperty("desktopId").GetString()!);
        if (desktop == Guid.Empty) throw new InvalidOperationException("D2_GUID_REQUIRED");
        return desktop;
    }

    private static void SetGuardStyle(Window window, bool transparent)
    {
        IntPtr hwnd = new WindowInteropHelper(window).EnsureHandle();
        long style = GetWindowLongPtr(hwnd, -20).ToInt64() | WsExNoActivate;
        if (transparent) style |= WsExTransparent;
        SetWindowLongPtr(hwnd, -20, new IntPtr(style));
    }

    private static Window MakeEdge(bool effect, bool nonlayered, bool showTaskbar = false)
    {
        var blue = Color.FromRgb(10,132,255);
        var line = new Border {
            Background = Brushes.Transparent,
            BorderBrush = new SolidColorBrush(Color.FromArgb(225, blue.R, blue.G, blue.B)),
            BorderThickness = new Thickness(7),
            IsHitTestVisible = false
        };
        if (effect) line.Effect = new DropShadowEffect {
            Color = blue, BlurRadius = 22, ShadowDepth = 0, Opacity = 0.92
        };
        return new Window {
            Title = "DeskMCP SELF-OWNED EDGE REPRO",
            Left = nonlayered ? -20000 : SystemParameters.VirtualScreenLeft,
            Top = nonlayered ? -20000 : SystemParameters.VirtualScreenTop,
            Width = Math.Max(1, SystemParameters.VirtualScreenWidth),
            Height = nonlayered ? 7 : Math.Max(1, SystemParameters.VirtualScreenHeight),
            WindowStyle = WindowStyle.None, ResizeMode = ResizeMode.NoResize,
            AllowsTransparency = !nonlayered,
            Background = nonlayered ? new SolidColorBrush(blue) : Brushes.Transparent,
            ShowInTaskbar = showTaskbar, ShowActivated = false, Topmost = true,
            Focusable = false, IsHitTestVisible = false, Content = line,
            Opacity = 1
        };
    }

    private static Window MakeHud(bool opaque = false, bool showTaskbar = false)
    {
        var shell = new Border {
            Background = new SolidColorBrush(Color.FromArgb(244,22,22,25)),
            BorderBrush = Brushes.DodgerBlue,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(18),
            Child = new TextBlock { Text = "Self-owned HUD identity test (no control)",
                Foreground = Brushes.White, Margin = new Thickness(18,12,18,12) }
        };
        return new Window {
            Title = "DeskMCP SELF-OWNED HUD REPRO", Width = 515, Height = 62,
            Left = SystemParameters.WorkArea.Left + 100,
            Top = SystemParameters.WorkArea.Top + 14,
            WindowStyle=WindowStyle.None, ResizeMode=ResizeMode.NoResize,
            AllowsTransparency=!opaque, Background=opaque ? Brushes.Black : Brushes.Transparent,
            ShowInTaskbar=showTaskbar, ShowActivated=false, Topmost=true,
            Content=shell
        };
    }

    private static string Classify(IntPtr hwnd, Guid desired)
    {
        try {
            Guid observed = manager!.GetWindowDesktopId(hwnd);
            if (observed == Guid.Empty) return "desktop_id_unresolved";
            if (observed != desired) return "wrong_desktop";
            return manager.IsWindowOnCurrentVirtualDesktop(hwnd) ? "visible_on_owner_desktop" : "correct_desktop";
        }
        catch (COMException ex) { return "com_hresult_0x" + unchecked((uint)ex.ErrorCode).ToString("X8"); }
        catch { return "query_failed"; }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 5 || args[4] != "PASSIVE_FIXTURE_ONLY" ||
            (args[0] != "effect" && args[0] != "plain" && args[0] != "nonlayered" && args[0] != "hudonly" && args[0] != "hudopaque" && args[0] != "hudtaskbar" && args[0] != "ownedpair" && args[0] != "both_taskbar")
            || !int.TryParse(args[1],out int seconds) || seconds < 15 || seconds > 75)
            return 9;
        string mode = args[0];
        Window? edgeWindow = null, hudWindow = null, ownerRoot = null;
        IntPtr foregroundHook = IntPtr.Zero;
        try
        {
            Guid desired = ReadDesktop2Binding(args[2]);
            loadedDll = NativeLibrary.Load(Path.GetFullPath(args[3]));
            current = Marshal.GetDelegateForFunctionPointer<GetCurrentDesktopNumber>(
                NativeLibrary.GetExport(loadedDll, "GetCurrentDesktopNumber"));
            var desktopIndex = Marshal.GetDelegateForFunctionPointer<GetDesktopNumberById>(
                NativeLibrary.GetExport(loadedDll, "GetDesktopNumberById"));
            if (current() != 0 || desktopIndex(desired) != 1)
                throw new InvalidOperationException("REAL_D1_D2_AFFINITY_PRECHECK_FAILED");
            manager = (IVirtualDesktopManager)Activator.CreateInstance(
                Type.GetTypeFromCLSID(new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A"), true)!)!;

            var app = new Application {ShutdownMode=ShutdownMode.OnExplicitShutdown};
            foregroundHook = SetWinEventHook(3, 3, IntPtr.Zero, ForegroundWatch, 0, 0, 0);
            if(foregroundHook == IntPtr.Zero)
                throw new InvalidOperationException("FOREGROUND_EVENT_HOOK_REQUIRED");
            if(mode == "ownedpair")
            {
                ownerRoot = new Window {
                    Title="DeskMCP TEST owned D2 root",
                    Left=-20000, Top=-20000, Width=16, Height=16,
                    ShowInTaskbar=true, ShowActivated=false, Topmost=false,
                    WindowStyle=WindowStyle.None, ResizeMode=ResizeMode.NoResize,
                    AllowsTransparency=false, Background=Brushes.Black, Opacity=1
                };
            }
            edgeWindow = mode.StartsWith("hud", StringComparison.Ordinal) ? null : MakeEdge(mode == "effect" || mode == "both_taskbar", mode == "nonlayered", mode == "both_taskbar");
            hudWindow = MakeHud(mode == "hudopaque" || mode == "hudtaskbar", mode == "hudtaskbar" || mode == "both_taskbar");
            if(ownerRoot != null)
            {
                ownerRoot.Show(); // WPF requires owner to be shown before assigning Owner
                edgeWindow!.Owner=ownerRoot;
                hudWindow.Owner=ownerRoot;
            }
            edge = edgeWindow;
            hud = hudWindow;
            if (edge != null) ((UIElement)edge.Content).Opacity = 0;
            hud.Opacity = 0;
            hud.IsHitTestVisible = false;
            IntPtr edgeHwnd = edge != null ? new WindowInteropHelper(edge).EnsureHandle() : IntPtr.Zero;
            IntPtr hudHwnd = new WindowInteropHelper(hud).EnsureHandle();
            IntPtr rootHwnd=ownerRoot != null ? new WindowInteropHelper(ownerRoot).EnsureHandle():IntPtr.Zero;
            Stopwatch watch = new();
            bool started = false;
            (edge ?? hud).Loaded += async (_, _) =>
            {
                if(started) return;
                started = true;
                try
                {
                    await Task.Delay(150);
                    if (current() != 0) throw new InvalidOperationException("OWNER_NOT_D1");
                    if(rootHwnd != IntPtr.Zero)
                    {
                        manager.MoveWindowToDesktop(rootHwnd, ref desired);
                        if(Classify(rootHwnd, desired)!="correct_desktop")
                            throw new InvalidOperationException("OWNED_ROOT_NOT_D2");
                    }
                    if (edge != null) SetGuardStyle(edge, true);
                    SetGuardStyle(hud, false);
                    if (edge != null) manager.MoveWindowToDesktop(edgeHwnd, ref desired);
                    manager.MoveWindowToDesktop(hudHwnd, ref desired);
                    string initialEdge = edge == null ? "not_created" : Classify(edgeHwnd,desired);
                    string initialHud = Classify(hudHwnd,desired);
                    if ((edge != null && initialEdge != "correct_desktop") || initialHud != "correct_desktop")
                        throw new InvalidOperationException("INITIAL_VDA_MOVE_FAILED edge="+initialEdge+
                            " hud="+initialHud+" root="+(rootHwnd == IntPtr.Zero ? "not_created" : Classify(rootHwnd,desired)));
                    IntPtr ownerEdge = edge == null ? IntPtr.Zero : GetWindow(edgeHwnd, 4);
                    IntPtr ownerHud = GetWindow(hudHwnd, 4);
                    Console.WriteLine(JsonSerializer.Serialize(new {
                        status="WPF_OWNER_INSPECTION",mode,
                        edge_owner_exists=ownerEdge != IntPtr.Zero,
                        edge_owner_affinity=ownerEdge == IntPtr.Zero ? "none" : Classify(ownerEdge,desired),
                        hud_owner_exists=ownerHud != IntPtr.Zero,
                        hud_owner_affinity=ownerHud == IntPtr.Zero ? "none" : Classify(ownerHud,desired)
                    }));
                    if (mode == "nonlayered" && edge != null)
                    {
                        // The initial WPF HWND is created offscreen so the owner D1
                        // receives neither focus nor a transient visible border.
                        edge.Left = SystemParameters.VirtualScreenLeft;
                        edge.Top = SystemParameters.VirtualScreenTop;
                        if (Classify(edgeHwnd,desired) != "correct_desktop")
                            throw new InvalidOperationException("NONLAYERED_REPOSITION_LOST_D2");
                    }
                    var line = edge?.Content as UIElement;
                    if(line != null)
                    {
                        line.Opacity = 0.72;
                        line.BeginAnimation(UIElement.OpacityProperty,
                            new DoubleAnimation(0.48,0.92,TimeSpan.FromMilliseconds(1250)) {
                                AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever,
                                EasingFunction = new SineEase {EasingMode=EasingMode.EaseInOut}
                            });
                    }
                    hud.IsHitTestVisible=true;
                    hud.Opacity=1;
                    watch.Start();
                    int samples=0;
                    var timer=new DispatcherTimer(DispatcherPriority.Normal) {
                        Interval=TimeSpan.FromMilliseconds(90)
                    };
                    timer.Tick += (_,_) =>
                    {
                        samples++;
                        string e=edge == null ? "not_created" : Classify(edgeHwnd,desired);
                        string h=Classify(hudHwnd,desired);
                        string rootState=rootHwnd != IntPtr.Zero ? Classify(rootHwnd,desired):"none";
                        if (current() != 0 || (edge != null && e != "correct_desktop") || h != "correct_desktop"
                            || (rootHwnd != IntPtr.Zero && rootState != "correct_desktop")
                            || System.Threading.Volatile.Read(ref ownForegroundEvents) > 0)
                        {
                            timer.Stop();
                            if(line != null)
                            {
                                line.BeginAnimation(UIElement.OpacityProperty,null);
                                line.Opacity=0;
                            }
                            hud.Opacity=0;
                            Console.WriteLine(JsonSerializer.Serialize(new {
                                status="VDA_AFFINITY_FAILED",mode,elapsed_ms=watch.ElapsedMilliseconds,
                                samples,edge=e,hud=h,root=rootState,owner_desktop1=current()==0,
                                own_foreground_events=System.Threading.Volatile.Read(ref ownForegroundEvents)
                            }));
                            exitCode=2;
                            app.Shutdown();
                        }
                        else if (watch.Elapsed.TotalSeconds >= seconds)
                        {
                            timer.Stop();
                            Console.WriteLine(JsonSerializer.Serialize(new {
                                status="VDA_AFFINITY_STABLE",mode,elapsed_ms=watch.ElapsedMilliseconds,
                                samples,edge=e,hud=h,owner_desktop1=true,
                                own_foreground_events=System.Threading.Volatile.Read(ref ownForegroundEvents),
                                foreground_hook_armed=foregroundHook!=IntPtr.Zero
                            }));
                            exitCode=0;
                            app.Shutdown();
                        }
                    };
                    timer.Start();
                }
                catch (Exception error)
                {
                    if(edge != null) ((UIElement)edge.Content).Opacity=0;
                    hud.Opacity=0;
                    Console.Error.WriteLine("PROBE_START_FAILED " + error.GetType().Name + " " + error.Message);
                    exitCode=5;
                    app.Shutdown();
                }
            };
            edge?.Show();
            hud.Show();
            app.Run();
            return exitCode;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("SAFE_PREFLIGHT_FAILED " + error.GetType().Name + " " + error.Message);
            return 9;
        }
        finally
        {
            try{ edge?.Close(); } catch {}
            try{ hud?.Close(); } catch {}
            try{ ownerRoot?.Close(); } catch {}
            if(foregroundHook != IntPtr.Zero) UnhookWinEvent(foregroundHook);
            if(manager != null && Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager);
            if(loadedDll != IntPtr.Zero) NativeLibrary.Free(loadedDll);
        }
    }
}
