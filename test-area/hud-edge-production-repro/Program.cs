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

    private static Window MakeEdge(bool effect, bool nonlayered)
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
            ShowInTaskbar = false, ShowActivated = false, Topmost = true,
            Focusable = false, IsHitTestVisible = false, Content = line,
            Opacity = 1
        };
    }

    private static Window MakeHud()
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
            AllowsTransparency=true, Background=Brushes.Transparent,
            ShowInTaskbar=false, ShowActivated=false, Topmost=true,
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
            (args[0] != "effect" && args[0] != "plain" && args[0] != "nonlayered")
            || !int.TryParse(args[1],out int seconds) || seconds < 15 || seconds > 75)
            return 9;
        string mode = args[0];
        Window? edgeWindow = null, hudWindow = null;
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
            edgeWindow = MakeEdge(mode == "effect", mode == "nonlayered");
            hudWindow = MakeHud();
            edge = edgeWindow;
            hud = hudWindow;
            ((UIElement)edge.Content).Opacity = 0;
            hud.Opacity = 0;
            hud.IsHitTestVisible = false;
            IntPtr edgeHwnd = new WindowInteropHelper(edge).EnsureHandle();
            IntPtr hudHwnd = new WindowInteropHelper(hud).EnsureHandle();
            Stopwatch watch = new();
            bool started = false;
            edge.Loaded += async (_, _) =>
            {
                if(started) return;
                started = true;
                try
                {
                    await Task.Delay(150);
                    if (current() != 0) throw new InvalidOperationException("OWNER_NOT_D1");
                    SetGuardStyle(edge, true);
                    SetGuardStyle(hud, false);
                    manager.MoveWindowToDesktop(edgeHwnd, ref desired);
                    manager.MoveWindowToDesktop(hudHwnd, ref desired);
                    if (Classify(edgeHwnd, desired) != "correct_desktop"
                        || Classify(hudHwnd, desired) != "correct_desktop")
                        throw new InvalidOperationException("INITIAL_VDA_MOVE_FAILED");
                    if (mode == "nonlayered")
                    {
                        // The initial WPF HWND is created offscreen so the owner D1
                        // receives neither focus nor a transient visible border.
                        edge.Left = SystemParameters.VirtualScreenLeft;
                        edge.Top = SystemParameters.VirtualScreenTop;
                        if (Classify(edgeHwnd,desired) != "correct_desktop")
                            throw new InvalidOperationException("NONLAYERED_REPOSITION_LOST_D2");
                    }
                    var line = (UIElement)edge.Content;
                    line.Opacity = 0.72;
                    line.BeginAnimation(UIElement.OpacityProperty,
                        new DoubleAnimation(0.48,0.92,TimeSpan.FromMilliseconds(1250)) {
                            AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever,
                            EasingFunction = new SineEase {EasingMode=EasingMode.EaseInOut}
                        });
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
                        string e=Classify(edgeHwnd,desired);
                        string h=Classify(hudHwnd,desired);
                        if (current() != 0 || e != "correct_desktop" || h != "correct_desktop")
                        {
                            timer.Stop();
                            line.BeginAnimation(UIElement.OpacityProperty,null);
                            line.Opacity=0;
                            hud.Opacity=0;
                            Console.WriteLine(JsonSerializer.Serialize(new {
                                status="VDA_AFFINITY_FAILED",mode,elapsed_ms=watch.ElapsedMilliseconds,
                                samples,edge=e,hud=h,owner_desktop1=current()==0
                            }));
                            exitCode=2;
                            app.Shutdown();
                        }
                        else if (watch.Elapsed.TotalSeconds >= seconds)
                        {
                            timer.Stop();
                            Console.WriteLine(JsonSerializer.Serialize(new {
                                status="VDA_AFFINITY_STABLE",mode,elapsed_ms=watch.ElapsedMilliseconds,
                                samples,edge=e,hud=h,owner_desktop1=true
                            }));
                            exitCode=0;
                            app.Shutdown();
                        }
                    };
                    timer.Start();
                }
                catch (Exception error)
                {
                    ((UIElement)edge.Content).Opacity=0;
                    hud.Opacity=0;
                    Console.Error.WriteLine("PROBE_START_FAILED " + error.GetType().Name + " " + error.Message);
                    exitCode=5;
                    app.Shutdown();
                }
            };
            edge.Show();
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
            if(manager != null && Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager);
            if(loadedDll != IntPtr.Zero) NativeLibrary.Free(loadedDll);
        }
    }
}
