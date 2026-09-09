using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using Ellipse = System.Windows.Shapes.Ellipse;
using System.Windows.Threading;

internal sealed class AgentDesktopBindingDocument
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; }
    [JsonPropertyName("desktopId")]
    public string DesktopId { get; set; }
    [JsonPropertyName("desktopNumber")]
    public int? DesktopNumber { get; set; }
    [JsonPropertyName("boundAtUtc")]
    public string BoundAtUtc { get; set; }
}

internal sealed class AgentDesktopControlDocument
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; }
    [JsonPropertyName("generation")]
    public int Generation { get; set; }
    [JsonPropertyName("active")]
    public bool Active { get; set; }
    [JsonPropertyName("leaseId")]
    public string LeaseId { get; set; }
    [JsonPropertyName("taskLabel")]
    public string TaskLabel { get; set; }
    [JsonPropertyName("startedAtUtc")]
    public string StartedAtUtc { get; set; }
    [JsonPropertyName("revokedAtUtc")]
    public string RevokedAtUtc { get; set; }
}

internal sealed class AgentDesktopCurrentDesktopDocument
{
    [JsonPropertyName("desktopId")]
    public string DesktopId { get; set; }
    [JsonPropertyName("desktopNumber")]
    public int DesktopNumber { get; set; }
    [JsonPropertyName("desktopCount")]
    public int DesktopCount { get; set; }
}

internal static class AgentDesktopWindowMover
{
    private static readonly Guid ClsidVirtualDesktopManager = new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A");

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
    private interface IVirtualDesktopManager
    {
        [return: MarshalAs(UnmanagedType.Bool)]
        bool IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow);
        Guid GetWindowDesktopId(IntPtr topLevelWindow);
        void MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
    }

    public static void MoveOwnWindow(Window window, Guid desktopId)
    {
        if (window == null) throw new ArgumentNullException(nameof(window));
        if (desktopId == Guid.Empty) throw new ArgumentException("Agent Desktop id cannot be empty.", nameof(desktopId));
        IntPtr hwnd = new WindowInteropHelper(window).EnsureHandle();
        IVirtualDesktopManager manager = CreateManager();
        try
        {
            manager.MoveWindowToDesktop(hwnd, ref desktopId);
            Guid actual = manager.GetWindowDesktopId(hwnd);
            if (actual != desktopId)
                throw new InvalidOperationException(
                    "Windows did not place Agent Desktop safety window '" + window.Title +
                    "' (HWND " + hwnd.ToInt64().ToString() +
                    ") on the bound virtual desktop. Target=" + desktopId.ToString("D") +
                    ", actual=" + actual.ToString("D") + ".");
        }
        finally
        {
            if (Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager);
        }
    }

    public static bool IsOwnWindowOnDesktop(Window window, Guid desktopId)
    {
        if (window == null || desktopId == Guid.Empty) return false;
        IntPtr hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero) return false;
        IVirtualDesktopManager manager = CreateManager();
        try
        {
            Guid actual = manager.GetWindowDesktopId(hwnd);
            return actual != Guid.Empty && actual == desktopId;
        }
        catch
        {
            return false;
        }
        finally
        {
            if (Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager);
        }
    }

    private static IVirtualDesktopManager CreateManager()
    {
        Type type = Type.GetTypeFromCLSID(ClsidVirtualDesktopManager, true);
        object instance = Activator.CreateInstance(type);
        if (instance == null) throw new InvalidOperationException("Windows VirtualDesktopManager could not be created.");
        return (IVirtualDesktopManager)instance;
    }
}

internal sealed class AgentDesktopVirtualDesktopClient : IDisposable
{
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetCurrentDesktopNumberDelegate();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int RegisterPostMessageHookDelegate(IntPtr listenerHwnd, uint messageId);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void UnregisterPostMessageHookDelegate(IntPtr listenerHwnd);

    private readonly IntPtr libraryHandle;
    private readonly GetCurrentDesktopNumberDelegate getCurrentDesktopNumber;
    private readonly RegisterPostMessageHookDelegate registerPostMessageHook;
    private readonly UnregisterPostMessageHookDelegate unregisterPostMessageHook;
    private bool disposed;

    public AgentDesktopVirtualDesktopClient(string dllPath)
    {
        if (String.IsNullOrWhiteSpace(dllPath) || !File.Exists(dllPath))
            throw new FileNotFoundException("VirtualDesktopAccessor runtime is missing.", dllPath);
        libraryHandle = NativeLibrary.Load(Path.GetFullPath(dllPath));
        try
        {
            IntPtr export = NativeLibrary.GetExport(libraryHandle, "GetCurrentDesktopNumber");
            getCurrentDesktopNumber = Marshal.GetDelegateForFunctionPointer<GetCurrentDesktopNumberDelegate>(export);
            registerPostMessageHook = Marshal.GetDelegateForFunctionPointer<RegisterPostMessageHookDelegate>(
                NativeLibrary.GetExport(libraryHandle, "RegisterPostMessageHook"));
            unregisterPostMessageHook = Marshal.GetDelegateForFunctionPointer<UnregisterPostMessageHookDelegate>(
                NativeLibrary.GetExport(libraryHandle, "UnregisterPostMessageHook"));
            int current = getCurrentDesktopNumber();
            if (current < 0) throw new InvalidOperationException("VirtualDesktopAccessor could not resolve the current virtual desktop.");
        }
        catch
        {
            NativeLibrary.Free(libraryHandle);
            throw;
        }
    }

    public int CurrentDesktopNumber()
    {
        if (disposed) throw new ObjectDisposedException(nameof(AgentDesktopVirtualDesktopClient));
        int current = getCurrentDesktopNumber();
        if (current < 0) throw new InvalidOperationException("VirtualDesktopAccessor could not resolve the current virtual desktop.");
        return current;
    }

    public void RegisterDesktopSwitchHook(IntPtr listenerHwnd, uint messageId)
    {
        if (disposed) throw new ObjectDisposedException(nameof(AgentDesktopVirtualDesktopClient));
        if (listenerHwnd == IntPtr.Zero) throw new ArgumentException("Desktop switch listener HWND is required.", nameof(listenerHwnd));
        if (registerPostMessageHook(listenerHwnd, messageId) != 1)
            throw new InvalidOperationException("VirtualDesktopAccessor could not register the desktop switch notification hook.");
    }

    public void UnregisterDesktopSwitchHook(IntPtr listenerHwnd)
    {
        if (disposed || listenerHwnd == IntPtr.Zero) return;
        unregisterPostMessageHook(listenerHwnd);
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        NativeLibrary.Free(libraryHandle);
    }
}

internal sealed class AgentDesktopOverlay : IDisposable
{
    private const int GwlExStyle = -20;
    private const long WsExTransparent = 0x00000020L;
    private const long WsExNoActivate = 0x08000000L;
    private const double EdgeThickness = 7.0;

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);

    private readonly Window edgeWindow;
    private readonly Window hudWindow;
    private readonly Action exitAction;
    private bool shown;
    private bool disposed;

    public AgentDesktopOverlay(string taskLabel, Action onExit)
    {
        exitAction = onExit ?? throw new ArgumentNullException(nameof(onExit));
        double left = SystemParameters.VirtualScreenLeft;
        double top = SystemParameters.VirtualScreenTop;
        double width = Math.Max(1, SystemParameters.VirtualScreenWidth);
        double height = Math.Max(1, SystemParameters.VirtualScreenHeight);

        edgeWindow = CreateEdge(left, top, width, height);
        hudWindow = CreateHud(taskLabel);
    }

    public bool IsShown => shown && !disposed;

    public async Task ShowOnDesktopAsync(Guid desktopId, Func<bool> stillAuthorized)
    {
        if (disposed) throw new ObjectDisposedException(nameof(AgentDesktopOverlay));
        if (stillAuthorized == null) throw new ArgumentNullException(nameof(stillAuthorized));
        if (shown) return;

        IntPtr edgeHwnd = new WindowInteropHelper(edgeWindow).EnsureHandle();
        edgeWindow.BeginAnimation(UIElement.OpacityProperty, null);
        edgeWindow.Opacity = 0;
        IntPtr hudHwnd = new WindowInteropHelper(hudWindow).EnsureHandle();
        hudWindow.Opacity = 0;
        hudWindow.IsHitTestVisible = false;

        edgeWindow.Show();
        hudWindow.Show();

        // Windows 11 only assigns a newly shown WPF HWND to the Virtual Desktop
        // shell after it has lived through a UI turn. Do not mutate the extended
        // window style until after registration or the shell can report Guid.Empty.
        await Task.Delay(150);
        if (disposed) throw new ObjectDisposedException(nameof(AgentDesktopOverlay));

        ApplyEdgeExtendedStyle(edgeHwnd);
        ApplyHudExtendedStyle(hudHwnd);
        AgentDesktopWindowMover.MoveOwnWindow(edgeWindow, desktopId);
        AgentDesktopWindowMover.MoveOwnWindow(hudWindow, desktopId);
        if (!stillAuthorized()) throw new InvalidOperationException("Agent Desktop control changed before the safety HUD became visible.");

        StartEdgePulse(edgeWindow);
        hudWindow.IsHitTestVisible = true;
        hudWindow.Opacity = 1;
        shown = true;
    }

    private Window CreateEdge(double left, double top, double width, double height)
    {
        Color blue = Color.FromRgb(10, 132, 255);
        Border line = new Border
        {
            Background = Brushes.Transparent,
            BorderBrush = new SolidColorBrush(Color.FromArgb(225, blue.R, blue.G, blue.B)),
            BorderThickness = new Thickness(EdgeThickness),
            IsHitTestVisible = false,
            Effect = new DropShadowEffect
            {
                Color = blue,
                BlurRadius = 22,
                ShadowDepth = 0,
                Opacity = 0.92
            }
        };
        Window edge = new Window
        {
            Title = "DeskMCP Agent Desktop Edge",
            Left = left,
            Top = top,
            Width = Math.Max(1, width),
            Height = Math.Max(1, height),
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ShowInTaskbar = false,
            ShowActivated = false,
            Topmost = true,
            Focusable = false,
            IsHitTestVisible = false,
            Content = line,
            Opacity = 0.72
        };
        return edge;
    }

    private static void StartEdgePulse(Window edge)
    {
        edge.Opacity = 0.72;
        DoubleAnimation pulse = new DoubleAnimation(0.48, 0.92, TimeSpan.FromMilliseconds(1250))
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut }
        };
        edge.BeginAnimation(UIElement.OpacityProperty, pulse);
    }

    private Window CreateHud(string taskLabel)
    {
        Color blue = Color.FromRgb(10, 132, 255);
        Grid grid = new Grid { Margin = new Thickness(14, 9, 10, 9) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        Ellipse dot = new Ellipse
        {
            Width = 9,
            Height = 9,
            Fill = new SolidColorBrush(blue),
            Margin = new Thickness(0, 0, 11, 0),
            VerticalAlignment = VerticalAlignment.Center,
            Effect = new DropShadowEffect { Color = blue, BlurRadius = 13, ShadowDepth = 0, Opacity = 1 }
        };
        Grid.SetColumn(dot, 0);
        grid.Children.Add(dot);

        StackPanel labels = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        labels.Children.Add(new TextBlock
        {
            Text = "Agent is controlling this desktop",
            Foreground = Brushes.White,
            FontSize = 12.5,
            FontWeight = FontWeights.SemiBold
        });
        labels.Children.Add(new TextBlock
        {
            Text = String.IsNullOrWhiteSpace(taskLabel) ? "DeskMCP Agent Desktop" : taskLabel.Trim(),
            Foreground = new SolidColorBrush(Color.FromRgb(174, 174, 182)),
            FontSize = 10,
            Margin = new Thickness(0, 2, 10, 0),
            MaxWidth = 260,
            TextTrimming = TextTrimming.CharacterEllipsis
        });
        Grid.SetColumn(labels, 1);
        grid.Children.Add(labels);

        Button exit = new Button
        {
            Content = "Exit Agent Control",
            Padding = new Thickness(13, 7, 13, 7),
            Margin = new Thickness(12, 0, 0, 0),
            Foreground = Brushes.White,
            Background = new SolidColorBrush(Color.FromRgb(46, 46, 50)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(70, 255, 255, 255)),
            BorderThickness = new Thickness(1),
            FontSize = 10.5,
            FontWeight = FontWeights.SemiBold,
            Cursor = System.Windows.Input.Cursors.Hand
        };
        exit.Click += delegate { exitAction(); };
        Grid.SetColumn(exit, 2);
        grid.Children.Add(exit);

        Border shell = new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(244, 22, 22, 25)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(180, blue.R, blue.G, blue.B)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(18),
            Child = grid,
            Effect = new DropShadowEffect { Color = blue, BlurRadius = 24, ShadowDepth = 0, Opacity = 0.34 }
        };

        double hudWidth = 515;
        double hudHeight = 62;
        double workLeft = SystemParameters.WorkArea.Left;
        double workTop = SystemParameters.WorkArea.Top;
        double workWidth = SystemParameters.WorkArea.Width;
        return new Window
        {
            Title = "DeskMCP Agent Desktop Control",
            Width = hudWidth,
            Height = hudHeight,
            Left = workLeft + Math.Max(0, (workWidth - hudWidth) / 2.0),
            Top = workTop + 14,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ShowInTaskbar = false,
            ShowActivated = false,
            Topmost = true,
            Content = shell
        };
    }

    private static void ApplyEdgeExtendedStyle(IntPtr hwnd)
    {
        long style = GetWindowLongPtr(hwnd, GwlExStyle).ToInt64();
        style |= WsExTransparent | WsExNoActivate;
        SetWindowLongPtr(hwnd, GwlExStyle, new IntPtr(style));
    }

    private static void ApplyHudExtendedStyle(IntPtr hwnd)
    {
        // Keep the HUD as a normal Virtual Desktop window. WS_EX_TOOLWINDOW can
        // detach a topmost WPF window from Virtual Desktop ownership after a
        // desktop switch, making it appear on Desktop 1 as well.
        long style = GetWindowLongPtr(hwnd, GwlExStyle).ToInt64();
        SetWindowLongPtr(hwnd, GwlExStyle, new IntPtr(style));
    }

    public bool IsOnDesktop(Guid desktopId)
    {
        if (!IsShown || desktopId == Guid.Empty) return false;
        return AgentDesktopWindowMover.IsOwnWindowOnDesktop(edgeWindow, desktopId) &&
            AgentDesktopWindowMover.IsOwnWindowOnDesktop(hudWindow, desktopId);
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        shown = false;
        try { edgeWindow.BeginAnimation(UIElement.OpacityProperty, null); edgeWindow.Close(); } catch { }
        try { hudWindow.Close(); } catch { }
    }
}

internal sealed class AgentDesktopControlCoordinator : IDisposable
{
    private const int LockTimeoutMs = 2500;
    private const int DesktopSwitchMessage = 0x844D;
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromMilliseconds(450);

    private readonly string root;
    private readonly string configPath;
    private readonly string controlPath;
    private readonly string hudPath;
    private readonly string lockPath;
    private readonly string hostPath;
    private readonly Window eventWindow;
    private readonly AgentDesktopVirtualDesktopClient desktopClient;
    private readonly DispatcherTimer timer;
    private readonly Action<string, bool> notify;
    private HwndSource desktopEventSource;
    private IntPtr desktopEventHwnd;
    private bool desktopHookRegistered;
    private AgentDesktopOverlay overlay;
    private string overlayLeaseId;
    private int overlayGeneration = -1;
    private DateTime lastHeartbeatUtc = DateTime.MinValue;
    private bool started;
    private bool disposed;
    private bool tickInFlight;

    public AgentDesktopControlCoordinator(string dataRoot, string baseDir, string projectRoot, Window ownerWindow, Action<string, bool> notifyAction)
    {
        if (String.IsNullOrWhiteSpace(dataRoot)) throw new ArgumentException("Agent Desktop data root is required.", nameof(dataRoot));
        eventWindow = ownerWindow ?? throw new ArgumentNullException(nameof(ownerWindow));
        root = Path.Combine(Path.GetFullPath(dataRoot), "agent-desktop");
        configPath = Path.Combine(root, "config.json");
        controlPath = Path.Combine(root, "control.json");
        hudPath = Path.Combine(root, "hud-state.json");
        lockPath = Path.Combine(root, "control.lock");
        Directory.CreateDirectory(root);
        hostPath = ResolveHostPath(baseDir, projectRoot);
        desktopClient = new AgentDesktopVirtualDesktopClient(ResolveVirtualDesktopAccessorPath(baseDir, projectRoot, hostPath));
        notify = notifyAction;
        timer = new DispatcherTimer(DispatcherPriority.Send, eventWindow.Dispatcher)
        {
            Interval = HeartbeatInterval
        };
        timer.Tick += delegate { Tick(); };
    }

    public event Action StateChanged;

    public void Start()
    {
        if (disposed) throw new ObjectDisposedException(nameof(AgentDesktopControlCoordinator));
        if (started) return;
        started = true;
        try
        {
            AgentDesktopControlDocument stale = ReadControlFile(controlPath);
            if (stale != null && stale.Active)
            {
                RevokeActiveControl();
                try { if (File.Exists(hudPath)) File.Delete(hudPath); } catch { }
                if (notify != null) notify("Previous Agent Desktop control was revoked after Control Panel restart.", false);
            }
        }
        catch (Exception error)
        {
            if (notify != null) notify("Could not revoke stale Agent Desktop control: " + error.Message, true);
        }
        try { RegisterDesktopSwitchNotifications(); }
        catch (Exception error)
        {
            try { File.AppendAllText(Path.Combine(root, "desktop-switch-hook-error.log"), DateTime.UtcNow.ToString("O") + " " + error.Message + Environment.NewLine); } catch { }
        }
        timer.Start();
        Tick();
    }

    private void RegisterDesktopSwitchNotifications()
    {
        if (desktopHookRegistered) return;
        desktopEventHwnd = new WindowInteropHelper(eventWindow).EnsureHandle();
        desktopEventSource = HwndSource.FromHwnd(desktopEventHwnd);
        if (desktopEventSource == null) throw new InvalidOperationException("DeskMCP Control Panel HWND is unavailable for Virtual Desktop events.");
        desktopEventSource.AddHook(DesktopEventWindowProc);
        try
        {
            desktopClient.RegisterDesktopSwitchHook(desktopEventHwnd, DesktopSwitchMessage);
            desktopHookRegistered = true;
        }
        catch
        {
            desktopEventSource.RemoveHook(DesktopEventWindowProc);
            desktopEventSource = null;
            desktopEventHwnd = IntPtr.Zero;
            throw;
        }
    }

    private IntPtr DesktopEventWindowProc(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message != DesktopSwitchMessage) return IntPtr.Zero;
        handled = true;
        eventWindow.Dispatcher.BeginInvoke(new Action(Tick), DispatcherPriority.Send);
        return IntPtr.Zero;
    }

    private void UnregisterDesktopSwitchNotifications()
    {
        if (desktopHookRegistered)
        {
            try { desktopClient.UnregisterDesktopSwitchHook(desktopEventHwnd); } catch { }
            desktopHookRegistered = false;
        }
        if (desktopEventSource != null)
        {
            try { desktopEventSource.RemoveHook(DesktopEventWindowProc); } catch { }
            desktopEventSource = null;
        }
        desktopEventHwnd = IntPtr.Zero;
    }

    public AgentDesktopBindingDocument ReadBinding()
    {
        return ReadBindingFile(configPath);
    }

    public bool IsControlActive
    {
        get
        {
            AgentDesktopControlDocument control = ReadControlFile(controlPath);
            return control != null && control.Active;
        }
    }

    public string BindingDisplay
    {
        get
        {
            AgentDesktopBindingDocument binding = ReadBinding();
            if (binding == null) return "Not bound";
            return binding.DesktopNumber.HasValue
                ? "Desktop " + (binding.DesktopNumber.Value + 1) + " · ready"
                : "Bound · " + binding.DesktopId.Substring(0, 8);
        }
    }

    public Task<AgentDesktopBindingDocument> BindCurrentDesktopAsync()
    {
        if (disposed) throw new ObjectDisposedException(nameof(AgentDesktopControlCoordinator));
        return Task.Run(delegate
        {
            AgentDesktopControlDocument control = ReadControlFile(controlPath);
            if (control != null && control.Active)
                throw new InvalidOperationException("Exit Agent Control before rebinding the Agent Desktop.");

            AgentDesktopCurrentDesktopDocument current = RunCurrentDesktopHost();
            if (current.DesktopCount < 2)
                throw new InvalidOperationException("Create Desktop 2 first (Win + Ctrl + D), switch to it, then bind Agent Desktop.");
            if (current.DesktopNumber <= 0)
                throw new InvalidOperationException("Desktop 1 is reserved for you. Switch to Desktop 2 (or later) before binding Agent Desktop.");
            Guid desktopId;
            if (!Guid.TryParse(current.DesktopId, out desktopId) || desktopId == Guid.Empty)
                throw new InvalidDataException("Windows returned an invalid Agent Desktop id.");

            AgentDesktopBindingDocument binding = new AgentDesktopBindingDocument
            {
                SchemaVersion = 1,
                DesktopId = desktopId.ToString("D"),
                DesktopNumber = current.DesktopNumber,
                BoundAtUtc = DateTime.UtcNow.ToString("O")
            };
            RuntimeReliability.WriteAllTextAtomic(configPath, JsonSerializer.Serialize(binding) + Environment.NewLine, false);
            return binding;
        });
    }

    public void ExitControl()
    {
        if (disposed) return;
        try
        {
            RevokeActiveControl();
            HideOverlayAndHud();
            RaiseStateChanged();
            if (notify != null) notify("Agent control exited. This desktop is back under manual control.", false);
        }
        catch (Exception error)
        {
            if (notify != null) notify("Could not exit Agent Control: " + error.Message, true);
        }
    }

    private async void Tick()
    {
        if (disposed || tickInFlight) return;
        tickInFlight = true;
        try
        {
            AgentDesktopControlDocument control = ReadControlFile(controlPath);
            if (control == null || !control.Active || !ValidActiveControl(control))
            {
                if (overlay != null || File.Exists(hudPath)) HideOverlayAndHud();
                return;
            }

            AgentDesktopBindingDocument binding = ReadBindingFile(configPath);
            if (binding == null)
            {
                HideOverlayAndHud();
                TryRevokeAfterSafetyFailure("Agent Desktop binding disappeared while control was active.");
                return;
            }
            Guid boundDesktopId;
            if (!Guid.TryParse(binding.DesktopId, out boundDesktopId) || boundDesktopId == Guid.Empty)
                throw new InvalidDataException("Agent Desktop binding contains an invalid desktop id.");
            if (!binding.DesktopNumber.HasValue)
                throw new InvalidDataException("Agent Desktop binding is missing its desktop number. Re-bind Desktop 2 from DeskMCP Settings.");

            int currentDesktopNumber = desktopClient.CurrentDesktopNumber();
            bool viewingAgentDesktop = currentDesktopNumber == binding.DesktopNumber.Value;

            if (!viewingAgentDesktop)
            {
                if (overlay != null) HideOverlayOnly();
                if (DateTime.UtcNow - lastHeartbeatUtc >= HeartbeatInterval)
                {
                    WriteHudHeartbeat(control, false);
                    lastHeartbeatUtc = DateTime.UtcNow;
                }
                return;
            }

            bool replaceOverlay = overlay == null ||
                !String.Equals(overlayLeaseId, control.LeaseId, StringComparison.OrdinalIgnoreCase) ||
                overlayGeneration != control.Generation ||
                !overlay.IsOnDesktop(boundDesktopId);
            if (replaceOverlay)
            {
                HideOverlayOnly();
                AgentDesktopOverlay next = new AgentDesktopOverlay(control.TaskLabel, ExitControl);
                try
                {
                    await next.ShowOnDesktopAsync(boundDesktopId, delegate
                    {
                        AgentDesktopControlDocument live = ReadControlFile(controlPath);
                        return live != null && live.Active &&
                            live.Generation == control.Generation &&
                            String.Equals(live.LeaseId, control.LeaseId, StringComparison.OrdinalIgnoreCase) &&
                            desktopClient.CurrentDesktopNumber() == binding.DesktopNumber.Value;
                    });
                    overlay = next;
                    overlayLeaseId = control.LeaseId;
                    overlayGeneration = control.Generation;
                    lastHeartbeatUtc = DateTime.MinValue;
                }
                catch
                {
                    next.Dispose();
                    throw;
                }
            }

            if (DateTime.UtcNow - lastHeartbeatUtc >= HeartbeatInterval)
            {
                WriteHudHeartbeat(control, true);
                lastHeartbeatUtc = DateTime.UtcNow;
            }
        }
        catch (Exception error)
        {
            HideOverlayAndHud();
            TryRevokeAfterSafetyFailure(error.Message);
        }
        finally
        {
            tickInFlight = false;
        }
    }

    private void WriteHudHeartbeat(AgentDesktopControlDocument control, bool visible)
    {
        if (!ValidActiveControl(control)) throw new InvalidDataException("Agent Desktop active control state is invalid.");
        string json = JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            generation = control.Generation,
            leaseId = control.LeaseId,
            armed = true,
            visible = visible,
            processId = Environment.ProcessId,
            heartbeatAtUtc = DateTime.UtcNow.ToString("O")
        });
        RuntimeReliability.WriteAllTextAtomic(hudPath, json + Environment.NewLine, false);
    }

    private void TryRevokeAfterSafetyFailure(string detail)
    {
        try
        {
            if (!String.IsNullOrWhiteSpace(detail))
                File.AppendAllText(Path.Combine(root, "control-error.log"), DateTime.UtcNow.ToString("O") + " " + detail + Environment.NewLine);
        }
        catch { }
        try { RevokeActiveControl(); } catch { }
        if (notify != null && !String.IsNullOrWhiteSpace(detail))
            notify("Agent Desktop control was revoked for safety: " + detail, true);
        RaiseStateChanged();
    }

    private void RevokeActiveControl()
    {
        FileStream controlLock = AcquireControlLock();
        try
        {
            AgentDesktopControlDocument live = ReadControlFile(controlPath);
            if (live == null || !live.Active) return;
            string json = JsonSerializer.Serialize(new
            {
                schemaVersion = 1,
                generation = checked(live.Generation + 1),
                active = false,
                revokedAtUtc = DateTime.UtcNow.ToString("O")
            });
            RuntimeReliability.WriteAllTextAtomic(controlPath, json + Environment.NewLine, false);
        }
        finally
        {
            try { controlLock.Dispose(); } catch { }
            try { if (File.Exists(lockPath)) File.Delete(lockPath); } catch { }
        }
    }

    private FileStream AcquireControlLock()
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(LockTimeoutMs);
        while (true)
        {
            try
            {
                return new FileStream(lockPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128, FileOptions.WriteThrough);
            }
            catch (IOException)
            {
                if (DateTime.UtcNow >= deadline) throw new IOException("Agent Desktop control lock is busy.");
                Thread.Sleep(25);
            }
        }
    }

    private void HideOverlayOnly()
    {
        AgentDesktopOverlay current = overlay;
        overlay = null;
        overlayLeaseId = null;
        overlayGeneration = -1;
        lastHeartbeatUtc = DateTime.MinValue;
        if (current != null) current.Dispose();
    }

    private void HideOverlayAndHud()
    {
        HideOverlayOnly();
        try { if (File.Exists(hudPath)) File.Delete(hudPath); } catch { }
    }

    private AgentDesktopCurrentDesktopDocument RunCurrentDesktopHost()
    {
        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = hostPath,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(hostPath)
        };
        start.ArgumentList.Add("current-desktop");
        using (Process process = Process.Start(start))
        {
            if (process == null) throw new InvalidOperationException("Windows did not start the Agent Desktop native host.");
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            if (!process.WaitForExit(10000))
            {
                try { process.Kill(true); } catch { }
                throw new TimeoutException("Agent Desktop native host timed out.");
            }
            if (process.ExitCode != 0)
                throw new InvalidOperationException(String.IsNullOrWhiteSpace(error) ? "Agent Desktop native host failed." : error.Trim());
            AgentDesktopCurrentDesktopDocument current = JsonSerializer.Deserialize<AgentDesktopCurrentDesktopDocument>(output);
            if (current == null) throw new InvalidDataException("Agent Desktop native host returned invalid state.");
            return current;
        }
    }

    private static AgentDesktopBindingDocument ReadBindingFile(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            AgentDesktopBindingDocument binding = JsonSerializer.Deserialize<AgentDesktopBindingDocument>(File.ReadAllText(path));
            Guid id;
            DateTime stamp;
            if (binding == null || binding.SchemaVersion != 1 ||
                !Guid.TryParse(binding.DesktopId, out id) || id == Guid.Empty ||
                (binding.DesktopNumber.HasValue && binding.DesktopNumber.Value < 0) ||
                !DateTime.TryParse(binding.BoundAtUtc, null, System.Globalization.DateTimeStyles.RoundtripKind, out stamp))
                return null;
            return binding;
        }
        catch { return null; }
    }

    private static AgentDesktopControlDocument ReadControlFile(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            AgentDesktopControlDocument control = JsonSerializer.Deserialize<AgentDesktopControlDocument>(File.ReadAllText(path));
            if (control == null || control.SchemaVersion != 1 || control.Generation < 0) return null;
            if (control.Active && !ValidActiveControl(control)) return null;
            return control;
        }
        catch { return null; }
    }

    private static bool ValidActiveControl(AgentDesktopControlDocument control)
    {
        if (control == null || !control.Active || control.Generation < 0) return false;
        Guid lease;
        DateTime started;
        return Guid.TryParse(control.LeaseId, out lease) && lease != Guid.Empty &&
            DateTime.TryParse(control.StartedAtUtc, null, System.Globalization.DateTimeStyles.RoundtripKind, out started);
    }

    private static string ResolveHostPath(string baseDir, string projectRoot)
    {
        string configured = Environment.GetEnvironmentVariable("DESKTOP_MCP_AGENT_DESKTOP_HOST_PATH");
        List<string> candidates = new List<string>();
        if (!String.IsNullOrWhiteSpace(configured)) candidates.Add(Path.GetFullPath(configured));
        candidates.Add(Path.Combine(Path.GetFullPath(baseDir), "DeskMCP.AgentDesktopHost.exe"));
        string rid = RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? "win-arm64" : "win-x64";
        if (!String.IsNullOrWhiteSpace(projectRoot))
            candidates.Add(Path.Combine(Path.GetFullPath(projectRoot), "agent-desktop-host", "bin", "Release", "net10.0-windows", rid, "DeskMCP.AgentDesktopHost.exe"));
        foreach (string candidate in candidates)
            if (File.Exists(candidate)) return candidate;
        throw new FileNotFoundException("DeskMCP Agent Desktop native host is missing. Reinstall DeskMCP or set DESKTOP_MCP_AGENT_DESKTOP_HOST_PATH.");
    }

    private static string ResolveVirtualDesktopAccessorPath(string baseDir, string projectRoot, string resolvedHostPath)
    {
        string configured = Environment.GetEnvironmentVariable("DESKTOP_MCP_VDA_PATH");
        List<string> candidates = new List<string>();
        if (!String.IsNullOrWhiteSpace(configured)) candidates.Add(Path.GetFullPath(configured));
        string fullBaseDir = Path.GetFullPath(baseDir);
        candidates.Add(Path.Combine(fullBaseDir, "virtual-desktop-accessor", "VirtualDesktopAccessor.dll"));
        candidates.Add(Path.Combine(fullBaseDir, "VirtualDesktopAccessor.dll"));
        string hostDir = Path.GetDirectoryName(resolvedHostPath);
        if (!String.IsNullOrWhiteSpace(hostDir))
        {
            candidates.Add(Path.Combine(hostDir, "virtual-desktop-accessor", "VirtualDesktopAccessor.dll"));
            candidates.Add(Path.Combine(hostDir, "VirtualDesktopAccessor.dll"));
        }
        if (!String.IsNullOrWhiteSpace(projectRoot))
        {
            string target = RuntimeInformation.ProcessArchitecture == Architecture.Arm64
                ? "aarch64-pc-windows-msvc"
                : "x86_64-pc-windows-msvc";
            candidates.Add(Path.Combine(Path.GetFullPath(projectRoot), "runtime", "third-party-build", "virtual-desktop-accessor", "target", target, "release", "VirtualDesktopAccessor.dll"));
        }
        foreach (string candidate in candidates)
            if (File.Exists(candidate)) return candidate;
        throw new FileNotFoundException("VirtualDesktopAccessor runtime is missing. Reinstall DeskMCP or set DESKTOP_MCP_VDA_PATH.");
    }

    private void RaiseStateChanged()
    {
        try { StateChanged?.Invoke(); } catch { }
    }

    public void Shutdown(bool revokeActive)
    {
        if (disposed) return;
        disposed = true;
        timer.Stop();
        if (revokeActive)
        {
            try { RevokeActiveControl(); } catch { }
        }
        HideOverlayAndHud();
        try { UnregisterDesktopSwitchNotifications(); } catch { }
        try { desktopClient.Dispose(); } catch { }
    }

    public void Dispose()
    {
        Shutdown(false);
    }
}
