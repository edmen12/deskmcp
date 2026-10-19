using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

// Read-only Windows 11 virtual desktop placement experiment for a TEST edge
// window. No Agent Desktop controls, sessions, broker access or global input.
internal static class Program
{
    private const int GwlExStyle = -20;
    private const long WsExTransparent = 0x00000020L;
    private const long WsExNoActivate = 0x08000000L;

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr handle, int index, IntPtr value);

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
    private interface IVirtualDesktopManager
    {
        [return: MarshalAs(UnmanagedType.Bool)]
        bool IsWindowOnCurrentVirtualDesktop(IntPtr handle);
        Guid GetWindowDesktopId(IntPtr handle);
        void MoveWindowToDesktop(IntPtr handle, ref Guid desktopId);
    }

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length != 1 || (args[0] != "window" && args[0] != "content"))
            throw new ArgumentException("Choose window or content opacity animation.");
        if (!Guid.TryParse(Environment.GetEnvironmentVariable("TARGET_DESKTOP_ID"), out Guid desktopId) ||
            desktopId == Guid.Empty)
            throw new InvalidOperationException("TARGET_DESKTOP_ID is required.");

        string mode = args[0];
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var border = new Border
        {
            Background = Brushes.Transparent,
            BorderBrush = Brushes.SlateGray,
            BorderThickness = new Thickness(3),
            Opacity = mode == "content" ? 0 : 1,
            IsHitTestVisible = false
        };
        var window = new Window
        {
            Title = "DeskMCP TEST edge affinity (no control)",
            Left = SystemParameters.VirtualScreenLeft,
            Top = SystemParameters.VirtualScreenTop,
            Width = Math.Max(1, SystemParameters.VirtualScreenWidth),
            Height = Math.Max(1, SystemParameters.VirtualScreenHeight),
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ShowInTaskbar = false,
            ShowActivated = false,
            Topmost = true,
            Focusable = false,
            IsHitTestVisible = false,
            Content = border,
            Opacity = mode == "window" ? 0 : 1
        };
        int exitCode = 1;
        window.Loaded += async (_, _) =>
        {
            IVirtualDesktopManager? manager = null;
            try
            {
                await Task.Delay(150);
                IntPtr hwnd = new WindowInteropHelper(window).Handle;
                long style = GetWindowLongPtr(hwnd, GwlExStyle).ToInt64();
                SetWindowLongPtr(hwnd, GwlExStyle, new IntPtr(style | WsExTransparent | WsExNoActivate));
                object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(
                    new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A"), true)!)!;
                manager = (IVirtualDesktopManager)instance;
                manager.MoveWindowToDesktop(hwnd, ref desktopId);
                if (manager.GetWindowDesktopId(hwnd) != desktopId)
                {
                    Console.WriteLine("MODE=" + mode + " INITIAL_MOVE_FAILED");
                    app.Shutdown();
                    return;
                }

                var pulse = new DoubleAnimation(0.48, 0.92, TimeSpan.FromMilliseconds(1250))
                {
                    AutoReverse = true,
                    RepeatBehavior = RepeatBehavior.Forever,
                    EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut }
                };
                if (mode == "window")
                {
                    window.Opacity = 0.72;
                    window.BeginAnimation(UIElement.OpacityProperty, pulse);
                }
                else
                {
                    window.Opacity = 1;
                    border.Opacity = 0.72;
                    border.BeginAnimation(UIElement.OpacityProperty, pulse);
                }
                var watch = Stopwatch.StartNew();
                var timer = new DispatcherTimer(DispatcherPriority.Normal)
                {
                    Interval = TimeSpan.FromMilliseconds(90)
                };
                int samples = 0;
                timer.Tick += (_, _) =>
                {
                    samples++;
                    try
                    {
                        Guid actual = manager.GetWindowDesktopId(hwnd);
                        if (actual != desktopId)
                        {
                            timer.Stop();
                            // Fail closed: hide test edge immediately if affinity is lost.
                            window.BeginAnimation(UIElement.OpacityProperty, null);
                            window.Opacity = 0;
                            border.BeginAnimation(UIElement.OpacityProperty, null);
                            border.Opacity = 0;
                            Console.WriteLine("MODE=" + mode + " RESULT=LOST elapsed_ms=" + watch.ElapsedMilliseconds +
                                " samples=" + samples + " state=" + (actual == Guid.Empty ? "EMPTY" : "OTHER"));
                            exitCode = 2;
                            app.Shutdown();
                        }
                        else if (watch.ElapsedMilliseconds >= 30000)
                        {
                            timer.Stop();
                            Console.WriteLine("MODE=" + mode + " RESULT=STABLE elapsed_ms=" + watch.ElapsedMilliseconds +
                                " samples=" + samples);
                            exitCode = 0;
                            app.Shutdown();
                        }
                    }
                    catch (Exception error)
                    {
                        timer.Stop();
                        window.Opacity = 0;
                        Console.WriteLine("MODE=" + mode + " RESULT=QUERY_ERROR " + error.GetType().Name);
                        exitCode = 3;
                        app.Shutdown();
                    }
                };
                timer.Start();
            }
            catch (Exception error)
            {
                window.Opacity = 0;
                Console.WriteLine("MODE=" + mode + " RESULT=START_FAILED " + error.GetType().Name + " " + error.Message);
                exitCode = 4;
                app.Shutdown();
            }
            finally
            {
                // The COM object remains in use by the timer until shutdown;
                // reclaim it only when the WPF process exits.
            }
        };
        window.Show();
        app.Run();
        return exitCode;
    }
}
