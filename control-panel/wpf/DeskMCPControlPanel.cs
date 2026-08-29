using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using Ellipse = System.Windows.Shapes.Ellipse;
using System.Windows.Threading;
using Drawing = System.Drawing;
using Drawing2D = System.Drawing.Drawing2D;
using Forms = System.Windows.Forms;

internal sealed class HealthInfo
{
    public string version { get; set; }
    public PolicyInfo policy { get; set; }
}

internal sealed class PolicyInfo
{
    public string profile { get; set; }
}

internal sealed class PanelSettings
{
    public string theme { get; set; }
    public uint modifiers { get; set; }
    public uint virtualKey { get; set; }
    public string shortcut { get; set; }
    public string workspace { get; set; }
    public string[] recentWorkspaces { get; set; }
    public bool autoStartTunnel { get; set; }
    public string profile { get; set; }
    public string tunnelId { get; set; }
    public bool? onboardingCompleted { get; set; }
}

internal sealed class ControlPanelRuntime
{
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool DestroyIcon(IntPtr handle);

    private readonly string baseDir;
    private readonly string projectRoot;
    private readonly string dataRoot;
    private readonly string logsDir;
    private readonly string settingsDir;
    private readonly string nodePath;
    private static readonly HttpClient StatusHttpClient = new HttpClient { Timeout = TimeSpan.FromMilliseconds(500) };
    private readonly Window window;
    private readonly Border rootCard;
    private readonly ScaleTransform panelScale;
    private readonly TranslateTransform panelTranslate;
    private readonly Grid profileSegmentsGrid;
    private readonly Border profileIndicator;
    private readonly TranslateTransform profileIndicatorTransform;
    private readonly Forms.NotifyIcon notify;
    private readonly DispatcherTimer timer;
    private readonly Application app;
    private readonly string settingsPath;
    private readonly string startupLinkPath;
    private readonly string tunnelSecretPath;
    private readonly string tunnelClientPath;
    private readonly string tunnelProfilePath;
    private readonly Grid themeSegmentsGrid;
    private readonly Border themeIndicator;
    private readonly TranslateTransform themeIndicatorTransform;
    private Forms.ToolStripItem openMenuItem;
    private HwndSource hotkeySource;
    private IntPtr hotkeyHwnd = IntPtr.Zero;
    private bool hotkeyRegistered;
    private uint hotkeyModifiers = ModControl | ModAlt;
    private uint hotkeyVk = 0x44;
    private string hotkeyText = "Ctrl + Alt + D";
    private string themeMode = "system";
    private bool isDarkTheme;
    private bool themeInitialized;
    private string currentWorkspace;
    private string[] recentWorkspaces = new string[0];
    private bool settingsExpanded;
    private bool onboardingCompleted;
    private int onboardingStep;
    private bool pageTransitioning;
    private bool autoStartTunnel;
    private string tunnelId;
    private Process tunnelProcess;
    private int tunnelRetryIndex;
    private DateTime nextTunnelRetry = DateTime.MinValue;
    private bool gatewayStartInFlight;
    private Process gatewayProcess;
    private bool quitting;
    private bool statusRefreshInFlight;
    private bool statusInitialized;
    private bool gatewayIsRunning;
    private bool tunnelStartInFlight;
    private DateTime nextGatewayRetry = DateTime.MinValue;
    private DispatcherTimer toastTimer;

    private const int HotkeyId = 0x4D43;
    private const uint ModAlt = 0x0001;
    private const uint ModControl = 0x0002;
    private const uint ModShift = 0x0004;
    private const uint ModWin = 0x0008;
    private const int WmHotkey = 0x0312;

    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);


    private string selectedProfile = "read-only";
    private string persistentProfile = "read-only";
    private bool profileChangeInFlight;
    private string requestedProfile;
    private RegisteredWaitHandle activationWaitRegistration;
    private bool allowClose;
    private bool isHiding;
    private bool suppressAutoHide;
    private bool livePulseActive;
    private DateTime autoHideAfter;

    public ControlPanelRuntime()
    {
        baseDir = AppDomain.CurrentDomain.BaseDirectory;
        projectRoot = ResolveGatewayRoot(baseDir);
        dataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DesktopMCP");
        logsDir = Path.Combine(dataRoot, "logs");
        settingsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DesktopMCP");
        currentWorkspace = Path.Combine(dataRoot, "workspace");
        Directory.CreateDirectory(logsDir);
        Directory.CreateDirectory(settingsDir);
        Directory.CreateDirectory(currentWorkspace);
        string xamlPath = Path.Combine(baseDir, "Panel.xaml");
        settingsPath = Path.Combine(settingsDir, "settings.json");
        startupLinkPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "DeskMCP Control Panel.lnk");
        tunnelSecretPath = Path.Combine(dataRoot, "secrets", "tunnel-runtime-key.dpapi");
        nodePath = ResolveNodePath(baseDir);
        tunnelClientPath = ResolveTunnelClientPath();
        tunnelProfilePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "tunnel-client", "desktop-mcp.yaml");
        MigrateLegacyData();
        onboardingCompleted = File.Exists(settingsPath);
        window = LoadWindow(xamlPath);
        rootCard = Find<Border>("RootCard");
        try
        {
            string brandMarkPath = Path.Combine(baseDir, "brand", "deskmcp-mark-64.png");
            if (File.Exists(brandMarkPath)) Find<Image>("BrandMark").Source = new BitmapImage(new Uri(brandMarkPath, UriKind.Absolute));
        }
        catch { }
        TransformGroup group = (TransformGroup)rootCard.RenderTransform;
        panelScale = (ScaleTransform)group.Children[0];
        panelTranslate = (TranslateTransform)group.Children[1];
        profileSegmentsGrid = Find<Grid>("ProfileSegmentsGrid");
        profileIndicator = Find<Border>("ProfileIndicator");
        profileIndicatorTransform = (TranslateTransform)profileIndicator.RenderTransform;
        themeSegmentsGrid = Find<Grid>("ThemeSegmentsGrid");
        themeIndicator = Find<Border>("ThemeIndicator");
        themeIndicatorTransform = (TranslateTransform)themeIndicator.RenderTransform;
        LoadSettings();
        if (!IsValidTunnelId(tunnelId))
        {
            string migratedTunnelId = TryLoadTunnelIdFromProfile();
            if (IsValidTunnelId(migratedTunnelId)) { tunnelId = migratedTunnelId; SaveSettings(); }
        }

        app = Application.Current ?? new Application();
        app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
        autoHideAfter = DateTime.UtcNow.AddMilliseconds(1200);

        notify = new Forms.NotifyIcon();
        notify.Icon = CreateTrayIcon();
        notify.Text = "DeskMCP";
        notify.Visible = true;

        timer = new DispatcherTimer();
        timer.Interval = TimeSpan.FromSeconds(12);
        timer.Tick += delegate { UpdateStatus(); };

        WireWindowEvents();
        WireButtons();
        WireMicroMotion();
        WireTray();
        ApplyTheme(true);
        UpdateShortcutUi();
        if (IsStartWithWindowsEnabled()) { try { CreateStartupShortcut(); } catch { } }
    }

    private static Window LoadWindow(string path)
    {
        using (FileStream stream = File.OpenRead(path))
            return (Window)XamlReader.Load(stream);
    }
    private T Find<T>(string name) where T : class
    {
        return window.FindName(name) as T;
    }

    private static Brush BrushFrom(string value)
    {
        return (Brush)new BrushConverter().ConvertFromString(value);
    }

    private static void ApplySemanticResources(Window target, bool dark)
    {
        target.Resources["UiTextPrimary"] = BrushFrom(dark ? "#FFF5F5F7" : "#FF18181B");
        target.Resources["UiTextSecondary"] = BrushFrom(dark ? "#FFA8A8AE" : "#FF71717A");
        target.Resources["UiTextMuted"] = BrushFrom(dark ? "#FF8E8E95" : "#FF8E8E93");
        target.Resources["UiSurface"] = BrushFrom(dark ? "#FF1C1C1E" : "#FFFFFFFF");
        target.Resources["UiSurfaceMuted"] = BrushFrom(dark ? "#FF2A2A2D" : "#FFF5F5F7");
        target.Resources["UiInputSurface"] = BrushFrom(dark ? "#FF2C2C2F" : "#FFF3F3F5");
        target.Resources["UiInputBorder"] = BrushFrom(dark ? "#26FFFFFF" : "#12000000");
        target.Resources["UiBorder"] = BrushFrom(dark ? "#24FFFFFF" : "#18000000");
        target.Resources["UiAccentSoft"] = BrushFrom(dark ? "#FF0E2B31" : "#FFE9F8FA");
        target.Resources["UiAccentText"] = BrushFrom(dark ? "#FF2DE0D8" : "#FF087E8A");
        target.Resources["UiDangerSoft"] = BrushFrom(dark ? "#FF341C1C" : "#FFFFF0F0");
        target.Resources["UiDangerText"] = BrushFrom(dark ? "#FFFF5A52" : "#FFD92D20");
    }

    private static bool IsGatewayRoot(string root)
    {
        return !String.IsNullOrWhiteSpace(root) && File.Exists(Path.Combine(root, "dist", "src", "index.js"));
    }

    private static string ResolveGatewayRoot(string appBaseDir)
    {
        string configured = Environment.GetEnvironmentVariable("DESKTOP_MCP_GATEWAY_ROOT");
        string[] candidates = new string[]
        {
            configured,
            appBaseDir,
            Path.Combine(appBaseDir, "gateway"),
            Path.GetFullPath(Path.Combine(appBaseDir, "..", ".."))
        };
        foreach (string candidate in candidates)
            if (IsGatewayRoot(candidate)) return Path.GetFullPath(candidate);
        throw new DirectoryNotFoundException("DeskMCP Gateway runtime was not found. Set DESKTOP_MCP_GATEWAY_ROOT or install the bundled gateway next to the Control Panel.");
    }

    private static string ResolveNodePath(string appBaseDir)
    {
        string configured = Environment.GetEnvironmentVariable("DESKTOP_MCP_NODE_PATH");
        if (!String.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return configured;
        foreach (string candidate in new string[] { Path.Combine(appBaseDir, "node", "node.exe"), Path.Combine(appBaseDir, "runtime", "node.exe") })
            if (File.Exists(candidate)) return candidate;
        return "node.exe";
    }

    private void MigrateLegacyData()
    {
        try
        {
            string legacySettings = Path.Combine(baseDir, "settings.json");
            if (!File.Exists(settingsPath) && File.Exists(legacySettings)) File.Copy(legacySettings, settingsPath, false);
            string legacySecret = Path.Combine(projectRoot, "runtime", "secrets", "tunnel-runtime-key.dpapi");
            if (!File.Exists(tunnelSecretPath) && File.Exists(legacySecret))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(tunnelSecretPath));
                File.Copy(legacySecret, tunnelSecretPath, false);
            }
        }
        catch { }
    }

    private string ResolveTunnelClientPath()
    {
        string[] roots = new string[] { Path.Combine(baseDir, "tunnel-client"), Path.Combine(baseDir, "tools", "tunnel-client"), Path.Combine(projectRoot, "tools", "tunnel-client") };
        Version bestVersion = null; string bestPath = null;
        foreach (string root in roots)
        {
            string direct = Path.Combine(root, "bin", "tunnel-client.exe");
            if (File.Exists(direct) && bestPath == null) bestPath = direct;
            if (!Directory.Exists(root)) continue;
            foreach (string dir in Directory.GetDirectories(root))
        {
            string candidate = Path.Combine(dir, "bin", "tunnel-client.exe");
            if (!File.Exists(candidate)) continue;
            string name = Path.GetFileName(dir); Version parsed;
            if (name.StartsWith("v", StringComparison.OrdinalIgnoreCase)) name = name.Substring(1);
            if (!Version.TryParse(name, out parsed)) { if (bestPath == null) bestPath = candidate; continue; }
            if (bestVersion == null || parsed > bestVersion) { bestVersion = parsed; bestPath = candidate; }
            }
        }
        return bestPath ?? Path.Combine(baseDir, "tunnel-client", "bin", "tunnel-client.exe");
    }

    private static bool IsValidTunnelId(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || !value.StartsWith("tunnel_", StringComparison.Ordinal) || value.Length != 39) return false;
        for (int i = 7; i < value.Length; i++) { char c = value[i]; if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false; }
        return true;
    }

    private string TryLoadTunnelIdFromProfile()
    {
        try
        {
            if (!File.Exists(tunnelProfilePath)) return null;
            foreach (string raw in File.ReadAllLines(tunnelProfilePath))
            {
                string line = raw.Trim();
                if (!line.StartsWith("tunnel_id:", StringComparison.Ordinal)) continue;
                string value = line.Substring("tunnel_id:".Length).Trim().Trim('"');
                return IsValidTunnelId(value) ? value : null;
            }
        }
        catch { }
        return null;
    }

    private void ConfigureTunnelProfile(string id)
    {
        if (!IsValidTunnelId(id)) throw new InvalidOperationException("Tunnel ID is invalid.");
        if (!File.Exists(tunnelClientPath)) throw new FileNotFoundException("tunnel-client.exe is not installed.", tunnelClientPath);
        ProcessStartInfo psi = NewHiddenProcess(tunnelClientPath, "init --sample sample_mcp_remote_no_auth --profile desktop-mcp --tunnel-id " + id + " --mcp-server-url http://127.0.0.1:8765/mcp --force");
        Process p = Process.Start(psi);
        if (p == null) throw new InvalidOperationException("Could not initialize the Tunnel profile.");
        try
        {
            if (!p.WaitForExit(10000)) { try { p.Kill(); } catch { } throw new TimeoutException("Tunnel profile setup timed out."); }
            if (p.ExitCode != 0) throw new InvalidOperationException("Tunnel profile setup failed (exit " + p.ExitCode + ").");
        }
        finally { p.Dispose(); }
    }

    private void LoadSettings()
    {
        try
        {
            if (!File.Exists(settingsPath)) return;
            PanelSettings settings = JsonSerializer.Deserialize<PanelSettings>(File.ReadAllText(settingsPath));
            if (settings == null) return;
            if (settings.onboardingCompleted.HasValue) onboardingCompleted = settings.onboardingCompleted.Value;
            if (settings.theme == "system" || settings.theme == "light" || settings.theme == "dark")
                themeMode = settings.theme;
            if (settings.modifiers != 0 && settings.virtualKey != 0)
            {
                hotkeyModifiers = settings.modifiers;
                hotkeyVk = settings.virtualKey;
                if (!String.IsNullOrWhiteSpace(settings.shortcut)) hotkeyText = settings.shortcut;
            }
            if (!String.IsNullOrWhiteSpace(settings.workspace) && Directory.Exists(settings.workspace)) currentWorkspace = settings.workspace;
            if (settings.recentWorkspaces != null) recentWorkspaces = settings.recentWorkspaces;
            autoStartTunnel = settings.autoStartTunnel;
            bool downgradePersistedFull = settings.profile == "full-control";
            persistentProfile = settings.profile == "workspace-write" ? "workspace-write" : "read-only";
            selectedProfile = persistentProfile;
            if (IsValidTunnelId(settings.tunnelId)) tunnelId = settings.tunnelId;
            if (downgradePersistedFull) SaveSettings();
        }
        catch { }
    }

    private void SaveSettings()
    {
        try
        {
            PanelSettings settings = new PanelSettings();
            settings.theme = themeMode;
            settings.modifiers = hotkeyModifiers;
            settings.virtualKey = hotkeyVk;
            settings.shortcut = hotkeyText;
            settings.workspace = currentWorkspace;
            settings.recentWorkspaces = recentWorkspaces;
            settings.autoStartTunnel = autoStartTunnel;
            settings.profile = persistentProfile;
            settings.tunnelId = tunnelId;
            settings.onboardingCompleted = onboardingCompleted;
            File.WriteAllText(settingsPath, JsonSerializer.Serialize(settings));
        }
        catch { }
    }

    private bool GetSystemDarkMode()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
            {
                if (key == null) return false;
                object value = key.GetValue("AppsUseLightTheme");
                if (value is int) return ((int)value) == 0;
            }
        }
        catch { }
        return false;
    }

    private LinearGradientBrush Gradient(string a, string b)
    {
        Color ca = (Color)ColorConverter.ConvertFromString(a);
        Color cb = (Color)ColorConverter.ConvertFromString(b);
        return new LinearGradientBrush(ca, cb, new Point(0, 0), new Point(1, 1));
    }

    private int ThemeIndex()
    {
        if (themeMode == "light") return 1;
        if (themeMode == "dark") return 2;
        return 0;
    }

    private void AnimateThemeIndicator(bool animate)
    {
        if (themeSegmentsGrid.ActualWidth <= 0) return;
        double segmentWidth = themeSegmentsGrid.ActualWidth / 3.0;
        themeIndicator.Width = segmentWidth;
        double target = ThemeIndex() * segmentWidth;
        if (!animate)
        {
            themeIndicatorTransform.BeginAnimation(TranslateTransform.XProperty, null);
            themeIndicatorTransform.X = target;
            return;
        }
        BackEase ease = new BackEase();
        ease.EasingMode = EasingMode.EaseOut;
        ease.Amplitude = 0.11;
        DoubleAnimation slide = new DoubleAnimation(themeIndicatorTransform.X, target, TimeSpan.FromMilliseconds(265));
        slide.EasingFunction = ease;
        themeIndicatorTransform.BeginAnimation(TranslateTransform.XProperty, slide);
    }

    private void SetThemeVisual(bool animate)
    {
        string inactive = isDarkTheme ? "#A8A8AE" : "#71717A";
        string active = isDarkTheme ? "#F5F5F7" : "#18181B";
        Button systemButton = Find<Button>("ThemeSystemButton");
        Button lightButton = Find<Button>("ThemeLightButton");
        Button darkButton = Find<Button>("ThemeDarkButton");
        foreach (Button button in new Button[] { systemButton, lightButton, darkButton })
            button.Foreground = BrushFrom(inactive);
        Button selected = themeMode == "light" ? lightButton : themeMode == "dark" ? darkButton : systemButton;
        selected.Foreground = BrushFrom(active);
        AnimateThemeIndicator(animate);
    }

    private void ApplyTheme(bool force)
    {
        ApplyTheme(force, false);
    }

    private void ApplyTheme(bool force, bool animateSelector)
    {
        bool dark = themeMode == "dark" || (themeMode == "system" && GetSystemDarkMode());
        bool changed = !themeInitialized || dark != isDarkTheme;
        isDarkTheme = dark;
        themeInitialized = true;
        if (changed || force)
        {
            ApplySemanticResources(window, dark);
            rootCard.Background = BrushFrom(dark ? "#FF0B0B0D" : "#FFFFFFFF");
            rootCard.BorderBrush = BrushFrom(dark ? "#18FFFFFF" : "#10000000");
            Find<Border>("HeroCard").Background = Gradient("#FF111113", "#FF202024");
            Find<TextBlock>("ProfileSectionTitle").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<TextBlock>("ProfileHint").Foreground = BrushFrom(dark ? "#98989F" : "#8E8E93");
            Find<Border>("ProfileShell").Background = BrushFrom(dark ? "#FF2A2A2E" : "#FFE7E7EC");
            profileIndicator.Background = BrushFrom(dark ? "#FF424248" : "#FFFFFFFF");
            Find<Border>("ScopeCard").Background = BrushFrom(dark ? "#FF161618" : "#FFFFFFFF");
            Find<Border>("ScopeCard").BorderBrush = BrushFrom(dark ? "#24FFFFFF" : "#12000000");
            Find<TextBlock>("ScopeLabel").Foreground = BrushFrom(dark ? "#98989F" : "#8E8E93");
            Find<TextBlock>("ScopeText").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<TextBlock>("VersionText").Foreground = BrushFrom(dark ? "#8E8E95" : "#A1A1AA");
            Find<Border>("SettingsCard").Background = Brushes.Transparent;
            Find<Border>("SettingsCard").BorderBrush = Brushes.Transparent;
            Find<TextBlock>("SettingsTitle").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<Button>("SettingsBackButton").Background = BrushFrom(dark ? "#FF2C2C2E" : "#FFF2F2F4");
            Find<Button>("SettingsBackButton").Foreground = BrushFrom(dark ? "#FFF5F5F7" : "#FF27272A");
            foreach (string cardName in new string[] { "WorkspaceCard", "RecentCard", "AppearanceCard", "ShortcutCard", "StartupCard", "TunnelSettingsCard" })
                Find<Border>(cardName).Background = BrushFrom(dark ? "#FF1C1C1E" : "#FFF5F5F7");
            Find<TextBlock>("WorkspaceLabel").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<TextBlock>("WorkspacePathText").Foreground = BrushFrom(dark ? "#98989F" : "#8E8E93");
            Find<TextBlock>("RecentLabel").Foreground = BrushFrom(dark ? "#98989F" : "#8E8E93");
            Find<TextBlock>("AppearanceLabel").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<TextBlock>("ShortcutLabel").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<TextBlock>("ShortcutHint").Foreground = BrushFrom(dark ? "#98989F" : "#8E8E93");
            Find<TextBlock>("StartupLabel").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<TextBlock>("StartupHint").Foreground = BrushFrom(dark ? "#98989F" : "#8E8E93");
            Find<TextBlock>("TunnelSettingsLabel").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<TextBlock>("TunnelConfigStatus").Foreground = BrushFrom(dark ? "#98989F" : "#8E8E93");
            Find<TextBlock>("TunnelIdValue").Foreground = BrushFrom(dark ? "#F0F0F3" : "#18181B");
            Find<TextBlock>("TunnelIdFieldLabel").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<TextBlock>("TunnelKeyFieldLabel").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<TextBox>("TunnelIdInput").Background = BrushFrom(dark ? "#FF343439" : "#FFF3F3F6");
            Find<TextBox>("TunnelIdInput").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<TextBlock>("TunnelRuntimeKeyHint").Foreground = BrushFrom(dark ? "#98989F" : "#8E8E93");
            Find<Border>("TunnelSetupModal").Background = BrushFrom(dark ? "#FF232327" : "#FFFFFFFF");
            Find<Border>("TunnelSetupModal").BorderBrush = BrushFrom(dark ? "#24FFFFFF" : "#18000000");
            Find<TextBlock>("TunnelSetupTitle").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<TextBlock>("TunnelSetupHint").Foreground = BrushFrom(dark ? "#98989F" : "#71717A");
            Find<PasswordBox>("TunnelRuntimeKeyInput").Background = BrushFrom(dark ? "#FF343439" : "#FFF3F3F6");
            Find<PasswordBox>("TunnelRuntimeKeyInput").Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
            Find<Border>("ThemeShell").Background = BrushFrom(dark ? "#FF2C2C2E" : "#FFE7E7EC");
            themeIndicator.Background = BrushFrom(dark ? "#FF3A3A3C" : "#FFFFFFFF");
            foreach (string name in new string[] { "RefreshButton", "SettingsButton", "FolderButton", "LogsButton", "ShortcutButton", "WorkspaceChangeButton", "RecentWorkspace1", "RecentWorkspace2", "RecentWorkspace3", "TunnelConfigureButton", "TunnelReconnectButton", "FirstRunChooseWorkspaceButton", "FirstRunTunnelSkipButton", "TunnelSetupCancelButton", "FullControlCancelButton" })
            {
                Button button = Find<Button>(name);
                button.Background = BrushFrom(dark ? "#FF2C2C2E" : "#FFF2F2F4");
                button.Foreground = BrushFrom(dark ? "#FFF5F5F7" : "#FF27272A");
            }
            Button power = Find<Button>("PowerButton");
            power.Background = (Brush)window.FindResource("BrandGradient");
            power.Foreground = Brushes.White;
            UpdateStartupUi();
            UpdateTunnelSettingsUi();
            SetProfileVisual(selectedProfile, false);
        }
        SetThemeVisual(animateSelector);
    }

    private void SetThemeMode(string mode)
    {
        if (mode != "system" && mode != "light" && mode != "dark") return;
        themeMode = mode;
        SaveSettings();
        ApplyTheme(true, true);
    }


    private static Drawing.Icon CreateTrayIcon()
    {
        string brandIcon = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "brand", "DeskMCP.ico");
        if (File.Exists(brandIcon))
        {
            using (Drawing.Icon icon = new Drawing.Icon(brandIcon, 32, 32))
                return (Drawing.Icon)icon.Clone();
        }
        using (Drawing.Bitmap bitmap = new Drawing.Bitmap(32, 32))
        using (Drawing.Graphics g = Drawing.Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Drawing.Color.Transparent);
            using (Drawing.Brush shell = new Drawing.SolidBrush(Drawing.Color.FromArgb(255, 28, 31, 38)))
            using (Drawing.Brush core = new Drawing.SolidBrush(Drawing.Color.White))
            using (Drawing.Brush live = new Drawing.SolidBrush(Drawing.Color.FromArgb(255, 52, 199, 89)))
            {
                g.FillEllipse(shell, 2, 2, 28, 28);
                g.FillEllipse(core, 8, 8, 16, 16);
                g.FillEllipse(live, 21, 21, 7, 7);
            }
            IntPtr handle = bitmap.GetHicon();
            try
            {
                using (Drawing.Icon temp = Drawing.Icon.FromHandle(handle))
                    return (Drawing.Icon)temp.Clone();
            }
            finally { DestroyIcon(handle); }
        }
    }

    private static void AnimateScale(ScaleTransform scale, double target, int milliseconds)
    {
        CubicEase ease = new CubicEase { EasingMode = EasingMode.EaseOut };
        DoubleAnimation x = new DoubleAnimation(scale.ScaleX, target, TimeSpan.FromMilliseconds(milliseconds));
        DoubleAnimation y = new DoubleAnimation(scale.ScaleY, target, TimeSpan.FromMilliseconds(milliseconds));
        x.EasingFunction = ease; y.EasingFunction = ease;
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, x);
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, y);
    }

    private HealthInfo GetGatewayHealth()
    {
        try
        {
            using (HttpResponseMessage response = StatusHttpClient.GetAsync("http://127.0.0.1:8765/health").GetAwaiter().GetResult())
            {
                if (!response.IsSuccessStatusCode) return null;
                string body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                return JsonSerializer.Deserialize<HealthInfo>(body);
            }
        }
        catch { return null; }
    }

    private bool IsTunnelReady()
    {
        try
        {
            using (HttpResponseMessage response = StatusHttpClient.GetAsync("http://127.0.0.1:8080/readyz").GetAwaiter().GetResult())
            {
                if (!response.IsSuccessStatusCode) return false;
                return response.Content.ReadAsStringAsync().GetAwaiter().GetResult().Trim() == "ready";
            }
        }
        catch { return false; }
    }

    private ProcessStartInfo NewHiddenProcess(string fileName, string args)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = fileName;
        psi.Arguments = args;
        psi.WorkingDirectory = projectRoot;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        return psi;
    }

    private void StopGateway()
    {
        try
        {
            Process p = Process.Start(NewHiddenProcess(nodePath, "dist\\src\\stop.js"));
            if (p != null) p.WaitForExit(5000);
            Process owned = gatewayProcess;
            if (owned != null && !owned.HasExited) owned.WaitForExit(5000);
        }
        catch { }
        finally
        {
            Process owned = gatewayProcess;
            if (owned != null) { try { owned.Dispose(); } catch { } }
            gatewayProcess = null;
        }
    }

    private bool OwnedGatewayRunning()
    {
        try { return gatewayProcess != null && !gatewayProcess.HasExited; } catch { return false; }
    }

    private void StartGateway(string profile)
    {
        if (quitting || OwnedGatewayRunning()) return;
        string scope = currentWorkspace;
        ProcessStartInfo psi = NewHiddenProcess(nodePath, "dist\\src\\index.js");
        psi.EnvironmentVariables["DESKTOP_MCP_PROFILE"] = profile;
        psi.EnvironmentVariables["DESKTOP_MCP_ALLOWED_ROOTS"] = scope;
        psi.EnvironmentVariables["DESKTOP_MCP_AUDIT_LOG"] = Path.Combine(logsDir, "audit.jsonl");
        Process p = Process.Start(psi);
        if (p == null) throw new InvalidOperationException("Could not start DeskMCP Gateway.");
        gatewayProcess = p;
        p.EnableRaisingEvents = true;
        p.Exited += delegate { if (Object.ReferenceEquals(gatewayProcess, p)) gatewayProcess = null; try { p.Dispose(); } catch { } };
    }

    private void RestartGateway(string profile)
    {
        StopGateway();
        System.Threading.Thread.Sleep(450);
        StartGateway(profile);
    }

    private void RestartGatewayAsync(string profile)
    {
        gatewayStartInFlight = true;
        Task.Run(delegate { RestartGateway(profile); })
            .ContinueWith(delegate(Task task) { window.Dispatcher.BeginInvoke(new Action(delegate
            {
                gatewayStartInFlight = false;
                if (task.IsFaulted && profileChangeInFlight && requestedProfile == profile) { profileChangeInFlight = false; requestedProfile = null; }
                UpdateStatus();
            })); });
    }

    private void StartGatewayAsync(string profile)
    {
        Task.Run(delegate { StartGateway(profile); })
            .ContinueWith(delegate { window.Dispatcher.BeginInvoke(new Action(UpdateStatus)); });
    }

    private void StopGatewayAsync()
    {
        Task.Run(delegate { StopGateway(); })
            .ContinueWith(delegate { window.Dispatcher.BeginInvoke(new Action(UpdateStatus)); });
    }

    private void PositionPanel()
    {
        const double gap = 14.0;
        Forms.Screen screen = Forms.Screen.FromPoint(Forms.Cursor.Position);
        Drawing.Rectangle workPx = screen.WorkingArea;

        double scaleX = 1.0;
        double scaleY = 1.0;
        try
        {
            DpiScale dpi = VisualTreeHelper.GetDpi(window);
            scaleX = Math.Max(0.5, dpi.DpiScaleX);
            scaleY = Math.Max(0.5, dpi.DpiScaleY);
        }
        catch { }

        double workLeft = workPx.Left / scaleX;
        double workTop = workPx.Top / scaleY;
        double workRight = workPx.Right / scaleX;
        double workBottom = workPx.Bottom / scaleY;

        double availableWidth = Math.Max(1.0, workRight - workLeft - gap * 2.0);
        double availableHeight = Math.Max(1.0, workBottom - workTop - gap * 2.0);
        window.Width = Math.Min(420.0, availableWidth);
        double desiredHeight = settingsExpanded ? 650.0 : 560.0;
        window.Height = Math.Min(desiredHeight, availableHeight);

        double left = workRight - window.Width - gap;
        double top = workBottom - window.Height - gap;

        window.Left = Math.Max(workLeft + gap, left);
        window.Top = Math.Max(workTop + gap, top);
    }

    private void AnimateShow()
    {
        timer.Interval = TimeSpan.FromSeconds(2);
        UpdateStatus();
        PositionPanel();
        isHiding = false;
        window.BeginAnimation(Window.OpacityProperty, null);
        panelTranslate.BeginAnimation(TranslateTransform.YProperty, null);
        panelScale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
        panelScale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
        window.Opacity = 0;
        panelTranslate.Y = 26;
        panelScale.ScaleX = 0.95;
        panelScale.ScaleY = 0.95;
        window.Show();
        window.Activate();
        window.UpdateLayout();
        AnimateProfileIndicator(selectedProfile, false);
        AnimateThemeIndicator(false);

        CubicEase fadeEase = new CubicEase { EasingMode = EasingMode.EaseOut };
        BackEase spring = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.22 };
        DoubleAnimation opacity = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(175));
        DoubleAnimation move = new DoubleAnimation(26, 0, TimeSpan.FromMilliseconds(335));
        DoubleAnimation scale = new DoubleAnimation(0.95, 1, TimeSpan.FromMilliseconds(335));
        opacity.EasingFunction = fadeEase;
        move.EasingFunction = spring;
        scale.EasingFunction = spring;
        window.BeginAnimation(Window.OpacityProperty, opacity);
        panelTranslate.BeginAnimation(TranslateTransform.YProperty, move);
        panelScale.BeginAnimation(ScaleTransform.ScaleXProperty, scale);
        panelScale.BeginAnimation(ScaleTransform.ScaleYProperty, scale);
    }

    private void AnimateHide()
    {
        if (isHiding || !window.IsVisible) return;
        isHiding = true;
        CubicEase ease = new CubicEase { EasingMode = EasingMode.EaseIn };
        DoubleAnimation opacity = new DoubleAnimation(window.Opacity, 0, TimeSpan.FromMilliseconds(150));
        DoubleAnimation move = new DoubleAnimation(panelTranslate.Y, 14, TimeSpan.FromMilliseconds(165));
        DoubleAnimation scale = new DoubleAnimation(panelScale.ScaleX, 0.965, TimeSpan.FromMilliseconds(165));
        opacity.EasingFunction = ease;
        move.EasingFunction = ease;
        scale.EasingFunction = ease;
        opacity.Completed += delegate
        {
            window.BeginAnimation(Window.OpacityProperty, null);
            panelTranslate.BeginAnimation(TranslateTransform.YProperty, null);
            panelScale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
            panelScale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
            window.Hide();
            window.Opacity = 1;
            panelTranslate.Y = 0;
            panelScale.ScaleX = 1;
            panelScale.ScaleY = 1;
            SetLivePulse(false);
            timer.Interval = TimeSpan.FromSeconds(12);
            isHiding = false;
        };
        window.BeginAnimation(Window.OpacityProperty, opacity);
        panelTranslate.BeginAnimation(TranslateTransform.YProperty, move);
        panelScale.BeginAnimation(ScaleTransform.ScaleXProperty, scale);
        panelScale.BeginAnimation(ScaleTransform.ScaleYProperty, scale);
    }

    private int ProfileIndex(string profile)
    {
        if (profile == "read-only") return 0;
        if (profile == "full-control") return 2;
        return 1;
    }

    private void AnimateProfileIndicator(string profile, bool animate)
    {
        if (profileSegmentsGrid.ActualWidth <= 0) return;
        double segmentWidth = profileSegmentsGrid.ActualWidth / 3.0;
        profileIndicator.Width = segmentWidth;
        double target = ProfileIndex(profile) * segmentWidth;
        if (!animate)
        {
            profileIndicatorTransform.BeginAnimation(TranslateTransform.XProperty, null);
            profileIndicatorTransform.X = target;
            return;
        }
        BackEase ease = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.08 };
        DoubleAnimation slide = new DoubleAnimation(
            profileIndicatorTransform.X,
            target,
            TimeSpan.FromMilliseconds(235));
        slide.EasingFunction = ease;
        profileIndicatorTransform.BeginAnimation(TranslateTransform.XProperty, slide);
    }

    private void SetProfileVisual(string profile, bool animate)
    {
        Button read = Find<Button>("ReadButton");
        Button write = Find<Button>("WriteButton");
        Button full = Find<Button>("FullButton");
        foreach (Button button in new Button[] { read, write, full })
        {
            button.Background = Brushes.Transparent;
            button.Foreground = BrushFrom(isDarkTheme ? "#A8A8AE" : "#71717A");
        }
        Button selected = profile == "read-only" ? read :
            profile == "full-control" ? full : write;
        selected.Foreground = BrushFrom(isDarkTheme ? "#F5F5F7" : "#18181B");
        AnimateProfileIndicator(profile, animate);

        TextBlock badge = Find<TextBlock>("ProfileBadge");
        if (profile == "read-only")
        {
            badge.Text = "READ";
            badge.Foreground = BrushFrom("#71717A");
        }
        else if (profile == "full-control")
        {
            badge.Text = "FULL";
            badge.Foreground = BrushFrom("#FF3B30");
        }
        else
        {
            badge.Text = "WRITE";
            badge.Foreground = BrushFrom("#22B8FF");
        }
    }

    private void SetLivePulse(bool enabled)
    {
        Ellipse dot = Find<Ellipse>("LiveDot");
        if (enabled && !livePulseActive)
        {
            DoubleAnimation pulse = new DoubleAnimation(0.72, 1.0, TimeSpan.FromMilliseconds(1200));
            pulse.AutoReverse = true;
            pulse.RepeatBehavior = RepeatBehavior.Forever;
            CubicEase ease = new CubicEase { EasingMode = EasingMode.EaseInOut };
            pulse.EasingFunction = ease;
            dot.BeginAnimation(UIElement.OpacityProperty, pulse);
            livePulseActive = true;
        }
        else if (!enabled && livePulseActive)
        {
            dot.BeginAnimation(UIElement.OpacityProperty, null);
            dot.Opacity = 1;
            livePulseActive = false;
        }
    }

    private void UpdateStatus()
    {
        ApplyTheme(false);
        if (statusRefreshInFlight) return;
        statusRefreshInFlight = true;
        Task.Run(delegate { return Tuple.Create(GetGatewayHealth(), IsTunnelReady()); })
            .ContinueWith(delegate(Task<Tuple<HealthInfo, bool>> task)
            {
                try
                {
                    window.Dispatcher.BeginInvoke(new Action(delegate
                    {
                        statusRefreshInFlight = false;
                        if (task.Status != TaskStatus.RanToCompletion) return;
                        ApplyStatus(task.Result.Item1, task.Result.Item2);
                    }));
                }
                catch { statusRefreshInFlight = false; }
            });
    }

    private void ApplyStatus(HealthInfo health, bool tunnelReady)
    {
        statusInitialized = true;
        gatewayIsRunning = health != null;
        bool gatewayStarting = health == null && (gatewayStartInFlight || OwnedGatewayRunning());
        Ellipse gatewayDot = Find<Ellipse>("GatewayDot");
        TextBlock gatewayText = Find<TextBlock>("GatewayStatus");
        Ellipse tunnelDot = Find<Ellipse>("TunnelDot");
        TextBlock tunnelText = Find<TextBlock>("TunnelStatus");
        Button power = Find<Button>("PowerButton");
        power.IsEnabled = true;

        if (health != null)
        {
            gatewayDot.Fill = BrushFrom("#34C759");
            gatewayText.Text = "Running";
            power.Content = "Restart Gateway";
            if (health.policy != null && !String.IsNullOrEmpty(health.policy.profile))
            {
                string runningProfile = health.policy.profile;
                if (profileChangeInFlight)
                {
                    if (String.Equals(runningProfile, requestedProfile, StringComparison.Ordinal)) { profileChangeInFlight = false; requestedProfile = null; }
                }
                else if (runningProfile == "full-control" && selectedProfile != "full-control")
                {
                    profileChangeInFlight = true; requestedProfile = persistentProfile; RestartGatewayAsync(persistentProfile);
                }
                else if (selectedProfile != runningProfile)
                {
                    selectedProfile = runningProfile;
                    if (runningProfile == "read-only" || runningProfile == "workspace-write") persistentProfile = runningProfile;
                    SaveSettings();
                }
            }
            SetProfileVisual(selectedProfile, true);
            Find<TextBlock>("VersionText").Text = "Gateway " + health.version;
        }
        else if (gatewayStarting)
        {
            gatewayDot.Fill = BrushFrom("#FF9F0A");
            gatewayText.Text = "Starting…";
            power.Content = "Starting Gateway…";
            power.IsEnabled = false;
            SetProfileVisual(selectedProfile, true);
        }
        else
        {
            gatewayDot.Fill = BrushFrom("#FF453A");
            gatewayText.Text = "Offline";
            power.Content = "Start Gateway";
            SetProfileVisual(selectedProfile, true);
        }

        if (tunnelReady)
        {
            tunnelDot.Fill = BrushFrom("#34C759");
            tunnelText.Text = "Ready";
        }
        else
        {
            bool idConfigured = IsValidTunnelId(tunnelId);
            bool keyConfigured = HasTunnelKey();
            tunnelDot.Fill = BrushFrom(idConfigured && keyConfigured ? "#FF9F0A" : "#8E8E93");
            if (!idConfigured) tunnelText.Text = "Set Tunnel ID";
            else if (!keyConfigured) tunnelText.Text = "Add API key";
            else if (!autoStartTunnel) tunnelText.Text = "Stopped";
            else if (OwnedTunnelRunning()) tunnelText.Text = "Connecting…";
            else tunnelText.Text = "Offline";
        }
        TextBlock scope = Find<TextBlock>("ScopeText");
        TextBlock hint = Find<TextBlock>("ProfileHint");
        Find<TextBlock>("ScopeLabel").Text = "Workspace";
        scope.Text = currentWorkspace;
        if (selectedProfile == "read-only") hint.Text = "Read-only in selected workspace";
        else if (selectedProfile == "full-control") hint.Text = "Workspace files + owned terminal sessions";
        else hint.Text = "Guarded filesystem writes in workspace";
        UpdateWorkspaceUi();

        Ellipse liveDot = Find<Ellipse>("LiveDot");
        TextBlock liveText = Find<TextBlock>("LiveText");
        Border livePill = Find<Border>("LivePill");
        if (health != null && tunnelReady)
        {
            liveDot.Fill = BrushFrom("#34C759");
            liveText.Text = "Live";
            livePill.Background = BrushFrom("#FF214A30");
            SetLivePulse(window.IsVisible);
        }
        else if (health != null)
        {
            liveDot.Fill = BrushFrom("#FF9F0A");
            liveText.Text = "Local";
            livePill.Background = BrushFrom("#FF4A3518");
            SetLivePulse(false);
        }
        else if (gatewayStarting)
        {
            liveDot.Fill = BrushFrom("#FF9F0A");
            liveText.Text = "Starting";
            livePill.Background = BrushFrom("#FF4A3518");
            SetLivePulse(false);
        }
        else
        {
            liveDot.Fill = BrushFrom("#8E8E93");
            liveText.Text = "Offline";
            livePill.Background = BrushFrom("#FF3A3A3C");
            SetLivePulse(false);
        }

        EnsureManagedServices(health, tunnelReady);
        UpdateTunnelSettingsUi();

        string profileLabel = selectedProfile == "read-only" ? "Read" :
            selectedProfile == "full-control" ? "Full" : "Write";
        notify.Text = "DeskMCP · " + liveText.Text + " · " + profileLabel;
    }


    private void ShowFullControlOverlay()
    {
        if (selectedProfile == "full-control") return;
        suppressAutoHide = true;
        Grid overlay = Find<Grid>("FullControlOverlay");
        ScaleTransform scale = (ScaleTransform)Find<Border>("FullControlModal").RenderTransform;
        overlay.BeginAnimation(UIElement.OpacityProperty, null);
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
        overlay.Visibility = Visibility.Visible; overlay.Opacity = 0; scale.ScaleX = 0.94; scale.ScaleY = 0.94;
        CubicEase fadeEase = new CubicEase { EasingMode = EasingMode.EaseOut };
        BackEase spring = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.14 };
        DoubleAnimation fade = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(150)) { EasingFunction = fadeEase };
        DoubleAnimation pop = new DoubleAnimation(0.94, 1, TimeSpan.FromMilliseconds(285)) { EasingFunction = spring };
        overlay.BeginAnimation(UIElement.OpacityProperty, fade);
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, pop); scale.BeginAnimation(ScaleTransform.ScaleYProperty, pop);
    }

    private void HideFullControlOverlay(Action after)
    {
        Grid overlay = Find<Grid>("FullControlOverlay");
        if (overlay.Visibility != Visibility.Visible) { suppressAutoHide = false; if (after != null) after(); return; }
        ScaleTransform scale = (ScaleTransform)Find<Border>("FullControlModal").RenderTransform;
        CubicEase ease = new CubicEase { EasingMode = EasingMode.EaseIn };
        DoubleAnimation fade = new DoubleAnimation(overlay.Opacity, 0, TimeSpan.FromMilliseconds(120)) { EasingFunction = ease };
        DoubleAnimation shrink = new DoubleAnimation(scale.ScaleX, 0.97, TimeSpan.FromMilliseconds(135)) { EasingFunction = ease };
        fade.Completed += delegate { overlay.BeginAnimation(UIElement.OpacityProperty, null); overlay.Opacity = 0; overlay.Visibility = Visibility.Collapsed; scale.BeginAnimation(ScaleTransform.ScaleXProperty, null); scale.BeginAnimation(ScaleTransform.ScaleYProperty, null); scale.ScaleX = 0.94; scale.ScaleY = 0.94; suppressAutoHide = false; window.Activate(); if (after != null) after(); };
        overlay.BeginAnimation(UIElement.OpacityProperty, fade); scale.BeginAnimation(ScaleTransform.ScaleXProperty, shrink); scale.BeginAnimation(ScaleTransform.ScaleYProperty, shrink);
    }

    private void ApplyProfile(string profile)
    {
        selectedProfile = profile;
        if (profile != "full-control") persistentProfile = profile;
        SaveSettings(); SetProfileVisual(profile, true);
        profileChangeInFlight = true; requestedProfile = profile;
        Find<TextBlock>("GatewayStatus").Text = "Restarting…"; Find<Ellipse>("GatewayDot").Fill = BrushFrom("#FF9F0A"); RestartGatewayAsync(profile);
    }

    private void SelectProfile(string profile)
    {
        if (profile == "full-control") { ShowFullControlOverlay(); return; }
        ApplyProfile(profile);
    }
    private void ShowToast(string message, bool isError)
    {
        Border toast = Find<Border>("ToastCard");
        TextBlock text = Find<TextBlock>("ToastText");
        TranslateTransform tx = (TranslateTransform)toast.RenderTransform;
        if (toastTimer != null) { toastTimer.Stop(); toastTimer = null; }
        toast.BeginAnimation(UIElement.OpacityProperty, null); tx.BeginAnimation(TranslateTransform.YProperty, null);
        toast.Background = BrushFrom(isError ? "#FF4A2525" : "#FF2A2A2E"); text.Text = message;
        toast.Visibility = Visibility.Visible; toast.Opacity = 0; tx.Y = 8;
        CubicEase ease = new CubicEase { EasingMode = EasingMode.EaseOut };
        toast.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(150)) { EasingFunction = ease });
        tx.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(8, 0, TimeSpan.FromMilliseconds(220)) { EasingFunction = ease });
        toastTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(2200) };
        toastTimer.Tick += delegate { toastTimer.Stop(); toastTimer = null; DoubleAnimation hide = new DoubleAnimation(toast.Opacity, 0, TimeSpan.FromMilliseconds(140)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn } }; hide.Completed += delegate { toast.Visibility = Visibility.Collapsed; toast.Opacity = 0; }; toast.BeginAnimation(UIElement.OpacityProperty, hide); };
        toastTimer.Start();
    }

    private bool IsStartWithWindowsEnabled()
    {
        return File.Exists(startupLinkPath);
    }

    private void CreateStartupShortcut()
    {
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) throw new InvalidOperationException("Windows Script Host is unavailable.");
        object shell = Activator.CreateInstance(shellType);
        object shortcut = shellType.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { startupLinkPath });
        Type shortcutType = shortcut.GetType();
        string currentExe = Process.GetCurrentProcess().MainModule.FileName;
        shortcutType.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { currentExe });
        shortcutType.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\') });
        shortcutType.InvokeMember("Arguments", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { "--startup" });
        shortcutType.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { "DeskMCP Control Panel" });
        shortcutType.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, shortcut, null);
        if (Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
        if (Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
    }

    private void UpdateStartupUi()
    {
        bool enabled = IsStartWithWindowsEnabled();
        Button button = Find<Button>("StartupButton");
        if (button == null) return;
        button.Content = enabled ? "On" : "Off";
        button.Background = BrushFrom(enabled ? (isDarkTheme ? "#FF214A30" : "#FFEAF7ED") : (isDarkTheme ? "#FF343439" : "#FFEFEFF2"));
        button.Foreground = BrushFrom(enabled ? (isDarkTheme ? "#FFD9FFE3" : "#FF2E7D32") : (isDarkTheme ? "#FFA8A8AE" : "#FF71717A"));
    }

    private void ToggleStartWithWindows()
    {
        try
        {
            if (IsStartWithWindowsEnabled()) File.Delete(startupLinkPath);
            else CreateStartupShortcut();
            UpdateStartupUi();
            ShowToast(IsStartWithWindowsEnabled() ? "Start with Windows enabled" : "Start with Windows disabled", false);
        }
        catch (Exception ex)
        {
            ShowToast("Could not update Start with Windows: " + ex.Message, true);
        }
    }

    private static readonly byte[] TunnelEntropy = Encoding.UTF8.GetBytes("DesktopMcpTunnelRuntimeKey:v1");

    private bool HasTunnelKey()
    {
        return File.Exists(tunnelSecretPath);
    }

    private void SaveTunnelKey(string key)
    {
        byte[] plain = Encoding.UTF8.GetBytes(key);
        byte[] encrypted = null;
        try
        {
            encrypted = ProtectedData.Protect(plain, TunnelEntropy, DataProtectionScope.CurrentUser);
            Directory.CreateDirectory(Path.GetDirectoryName(tunnelSecretPath));
            File.WriteAllBytes(tunnelSecretPath, encrypted);
            try { File.SetAttributes(tunnelSecretPath, FileAttributes.Hidden); } catch { }
        }
        finally
        {
            if (plain != null) Array.Clear(plain, 0, plain.Length);
            if (encrypted != null) Array.Clear(encrypted, 0, encrypted.Length);
        }
    }

    private string LoadTunnelKey()
    {        byte[] encrypted = File.ReadAllBytes(tunnelSecretPath);
        byte[] plain = null;
        try
        {
            plain = ProtectedData.Unprotect(encrypted, TunnelEntropy, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plain);
        }
        finally
        {
            if (plain != null) Array.Clear(plain, 0, plain.Length);
            if (encrypted != null) Array.Clear(encrypted, 0, encrypted.Length);
        }
    }

    private void UpdateTunnelSettingsUi()
    {
        bool idConfigured = IsValidTunnelId(tunnelId);
        bool keyConfigured = HasTunnelKey();
        Button autoButton = Find<Button>("TunnelAutoButton");
        Button configureButton = Find<Button>("TunnelConfigureButton");
        Button reconnectButton = Find<Button>("TunnelReconnectButton");
        TextBlock status = Find<TextBlock>("TunnelConfigStatus");
        TextBlock idValue = Find<TextBlock>("TunnelIdValue");
        string runtimeState = Find<TextBlock>("TunnelStatus") != null ? Find<TextBlock>("TunnelStatus").Text : "Offline";
        if (status != null)
        {
            if (runtimeState == "Ready") status.Text = "Ready";
            else if (!idConfigured) status.Text = "Tunnel ID required";
            else if (!keyConfigured) status.Text = "Runtime key required";
            else if (!autoStartTunnel) status.Text = "Configured · auto start off";
            else if (OwnedTunnelRunning()) status.Text = "Connecting…";
            else status.Text = "Configured";
        }
        if (idValue != null) idValue.Text = idConfigured ? tunnelId : "Not configured";
        if (autoButton != null)
        {
            autoButton.Content = autoStartTunnel ? "Auto On" : "Auto Off";
            autoButton.Background = BrushFrom(autoStartTunnel ? (isDarkTheme ? "#FF214A30" : "#FFEAF7ED") : (isDarkTheme ? "#FF343439" : "#FFEFEFF2"));
            autoButton.Foreground = BrushFrom(autoStartTunnel ? (isDarkTheme ? "#FFD9FFE3" : "#FF2E7D32") : (isDarkTheme ? "#FFA8A8AE" : "#FF71717A"));
        }
        if (configureButton != null) configureButton.Content = (idConfigured || keyConfigured) ? "Update" : "Configure";
        if (reconnectButton != null) reconnectButton.IsEnabled = idConfigured && keyConfigured;
    }

    private void ToggleTunnelAutoStart()
    {
        if (!IsValidTunnelId(tunnelId) || !HasTunnelKey())
        {
            ConfigureTunnel();
            return;
        }
        autoStartTunnel = !autoStartTunnel;
        SaveSettings();
        if (autoStartTunnel) { tunnelRetryIndex = 0; nextTunnelRetry = DateTime.MinValue; }
        UpdateTunnelSettingsUi();
        ShowToast(autoStartTunnel ? "Tunnel auto start enabled" : "Tunnel auto start disabled", false);
    }

    private void ConfigureTunnel()
    {
        suppressAutoHide = true;
        Grid overlay = Find<Grid>("TunnelSetupOverlay");
        Border modal = Find<Border>("TunnelSetupModal");
        ScaleTransform scale = (ScaleTransform)modal.RenderTransform;
        TextBox idInput = Find<TextBox>("TunnelIdInput");
        PasswordBox keyInput = Find<PasswordBox>("TunnelRuntimeKeyInput");
        Find<TextBlock>("TunnelSetupTitle").Text = IsValidTunnelId(tunnelId) || HasTunnelKey() ? "Update Secure MCP Tunnel" : "Configure Secure MCP Tunnel";
        TextBlock hint = Find<TextBlock>("TunnelSetupHint");
        hint.Text = "Paste the Tunnel ID and Runtime API Key from OpenAI Platform.";
        hint.Foreground = BrushFrom(isDarkTheme ? "#98989F" : "#71717A");
        Find<TextBlock>("TunnelRuntimeKeyHint").Text = HasTunnelKey() ? "Leave blank to keep the existing protected key." : "Required once. Protected with Windows DPAPI for this Windows user.";
        idInput.Text = IsValidTunnelId(tunnelId) ? tunnelId : "";
        keyInput.Clear();
        overlay.BeginAnimation(UIElement.OpacityProperty, null);
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
        overlay.Visibility = Visibility.Visible; overlay.Opacity = 0; scale.ScaleX = 0.94; scale.ScaleY = 0.94;
        DoubleAnimation fade = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(150)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } };
        DoubleAnimation pop = new DoubleAnimation(0.94, 1, TimeSpan.FromMilliseconds(275)) { EasingFunction = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.12 } };
        overlay.BeginAnimation(UIElement.OpacityProperty, fade); scale.BeginAnimation(ScaleTransform.ScaleXProperty, pop); scale.BeginAnimation(ScaleTransform.ScaleYProperty, pop);
        window.Dispatcher.BeginInvoke(new Action(delegate { if (!IsValidTunnelId(tunnelId)) idInput.Focus(); else keyInput.Focus(); }));
    }

    private void HideTunnelSetupOverlay()
    {
        Grid overlay = Find<Grid>("TunnelSetupOverlay");
        if (overlay.Visibility != Visibility.Visible) { suppressAutoHide = false; return; }
        ScaleTransform scale = (ScaleTransform)Find<Border>("TunnelSetupModal").RenderTransform;
        DoubleAnimation fade = new DoubleAnimation(overlay.Opacity, 0, TimeSpan.FromMilliseconds(120)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn } };
        DoubleAnimation shrink = new DoubleAnimation(scale.ScaleX, 0.97, TimeSpan.FromMilliseconds(135)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn } };
        fade.Completed += delegate { overlay.BeginAnimation(UIElement.OpacityProperty, null); overlay.Visibility = Visibility.Collapsed; overlay.Opacity = 0; scale.BeginAnimation(ScaleTransform.ScaleXProperty, null); scale.BeginAnimation(ScaleTransform.ScaleYProperty, null); scale.ScaleX = 0.94; scale.ScaleY = 0.94; Find<PasswordBox>("TunnelRuntimeKeyInput").Clear(); suppressAutoHide = false; window.Activate(); };
        overlay.BeginAnimation(UIElement.OpacityProperty, fade); scale.BeginAnimation(ScaleTransform.ScaleXProperty, shrink); scale.BeginAnimation(ScaleTransform.ScaleYProperty, shrink);
    }

    private async void SaveTunnelSetup()
    {
        TextBox idInput = Find<TextBox>("TunnelIdInput");
        PasswordBox keyInput = Find<PasswordBox>("TunnelRuntimeKeyInput");
        TextBlock hint = Find<TextBlock>("TunnelSetupHint");
        Button saveButton = Find<Button>("TunnelSetupSaveButton");
        Button cancelButton = Find<Button>("TunnelSetupCancelButton");
        string id = idInput.Text.Trim();
        bool hasNewKey = keyInput.SecurePassword != null && keyInput.SecurePassword.Length > 0;
        if (!IsValidTunnelId(id)) { hint.Text = "Tunnel ID must look like tunnel_ followed by 32 lowercase hexadecimal characters."; hint.Foreground = BrushFrom("#FF453A"); return; }
        if (!HasTunnelKey() && !hasNewKey) { hint.Text = "Paste a Runtime API Key before connecting."; hint.Foreground = BrushFrom("#FF453A"); return; }
        saveButton.IsEnabled = false; cancelButton.IsEnabled = false;
        hint.Text = "Configuring…"; hint.Foreground = BrushFrom(isDarkTheme ? "#98989F" : "#71717A");
        try
        {
            bool idChanged = !String.Equals(tunnelId, id, StringComparison.Ordinal);
            if (idChanged)
            {
                bool externalReady = await Task.Run(delegate { return IsTunnelReady(); });
                if (externalReady && !OwnedTunnelRunning()) { hint.Text = "A Tunnel is already running outside this Panel. Stop it before changing the Tunnel ID."; hint.Foreground = BrushFrom("#FF453A"); return; }
            }
            string profileId = await Task.Run(delegate { return TryLoadTunnelIdFromProfile(); });
            if (!String.Equals(profileId, id, StringComparison.Ordinal))
            {
                if (OwnedTunnelRunning()) await Task.Run(delegate { StopOwnedTunnel(); });
                await Task.Run(delegate { ConfigureTunnelProfile(id); });
            }
            tunnelId = id;
            if (hasNewKey)
            {
                string key = keyInput.Password;
                try { SaveTunnelKey(key.Trim()); }
                finally { key = null; keyInput.Clear(); }
                if (OwnedTunnelRunning()) await Task.Run(delegate { StopOwnedTunnel(); });
            }
            autoStartTunnel = true; tunnelRetryIndex = 0; nextTunnelRetry = DateTime.MinValue;
            SaveSettings(); UpdateTunnelSettingsUi(); HideTunnelSetupOverlay(); ShowToast("Tunnel saved · connecting…", false); UpdateStatus();
        }
        catch (Exception ex)
        {
            keyInput.Clear(); hint.Text = "Could not configure Tunnel: " + ex.Message; hint.Foreground = BrushFrom("#FF453A");
        }
        finally { saveButton.IsEnabled = true; cancelButton.IsEnabled = true; }
    }

    private bool OwnedTunnelRunning()
    {
        try { return tunnelProcess != null && !tunnelProcess.HasExited; }
        catch { return false; }
    }    private void ScheduleTunnelRetry()
    {
        int[] delays = new int[] { 2, 5, 10, 30 };
        int index = Math.Min(tunnelRetryIndex, delays.Length - 1);
        nextTunnelRetry = DateTime.UtcNow.AddSeconds(delays[index]);
        if (tunnelRetryIndex < delays.Length - 1) tunnelRetryIndex++;
    }

    private void StartManagedTunnel()
    {
        if (!IsValidTunnelId(tunnelId) || !HasTunnelKey() || IsTunnelReady() || OwnedTunnelRunning()) return;
        if (!File.Exists(tunnelClientPath)) throw new FileNotFoundException("tunnel-client.exe not found.", tunnelClientPath);
        string profileId = TryLoadTunnelIdFromProfile();
        if (!String.Equals(profileId, tunnelId, StringComparison.Ordinal)) ConfigureTunnelProfile(tunnelId);
        string key = LoadTunnelKey();
        if (String.IsNullOrWhiteSpace(key)) throw new InvalidOperationException("Tunnel Runtime Key is empty.");
        ProcessStartInfo psi = NewHiddenProcess(tunnelClientPath, "run --profile desktop-mcp");
        psi.EnvironmentVariables["CONTROL_PLANE_API_KEY"] = key;
        try
        {
            Process p = Process.Start(psi);
            if (p == null) throw new InvalidOperationException("Could not start tunnel-client.");
            tunnelProcess = p;
            p.EnableRaisingEvents = true;
            p.Exited += delegate
            {
                try { window.Dispatcher.BeginInvoke(new Action(delegate { tunnelProcess = null; ScheduleTunnelRetry(); UpdateStatus(); })); }
                catch { tunnelProcess = null; }
            };
        }
        finally
        {
            psi.EnvironmentVariables.Remove("CONTROL_PLANE_API_KEY");
            key = null;
        }
    }    private void StopOwnedTunnel()
    {
        Process p = tunnelProcess;
        if (p == null) return;
        try
        {
            if (!p.HasExited)
            {
                ProcessStartInfo kill = NewHiddenProcess("taskkill.exe", "/PID " + p.Id + " /T /F");
                Process kp = Process.Start(kill);
                if (kp != null) kp.WaitForExit(3000);
            }
        }
        catch { }
        try { p.Dispose(); } catch { }
        tunnelProcess = null;
    }

    private async void ReconnectTunnel()
    {
        if (!IsValidTunnelId(tunnelId) || !HasTunnelKey()) { ConfigureTunnel(); return; }
        Button reconnectButton = Find<Button>("TunnelReconnectButton");
        reconnectButton.IsEnabled = false;
        Find<TextBlock>("TunnelStatus").Text = "Reconnecting…";
        try
        {
            bool ready = await Task.Run(delegate { return IsTunnelReady(); });
            if (ready && !OwnedTunnelRunning())
            {
                ShowToast("Tunnel is already Ready and is managed outside this Panel", false);
                return;
            }
            if (OwnedTunnelRunning()) await Task.Run(delegate { StopOwnedTunnel(); });
            autoStartTunnel = true;
            tunnelRetryIndex = 0;
            nextTunnelRetry = DateTime.MinValue;
            SaveSettings();
            ShowToast("Reconnecting Tunnel…", false);
        }
        catch (Exception ex) { ShowToast("Could not reconnect Tunnel: " + ex.Message, true); }
        finally { UpdateTunnelSettingsUi(); UpdateStatus(); }
    }

    private void EnsureManagedServices(HealthInfo health, bool tunnelReady)
    {
        if (quitting || !onboardingCompleted) return;
        if (health == null)
        {
            if (OwnedGatewayRunning()) { gatewayStartInFlight = true; return; }
            gatewayStartInFlight = false;
            if (DateTime.UtcNow >= nextGatewayRetry)
            {
                gatewayStartInFlight = true;
                nextGatewayRetry = DateTime.UtcNow.AddSeconds(10);
                Task.Run(delegate { StartGateway(selectedProfile); })
                    .ContinueWith(delegate(Task task)
                    {
                        window.Dispatcher.BeginInvoke(new Action(delegate
                        {
                            gatewayStartInFlight = OwnedGatewayRunning();
                            if (task.IsFaulted) nextGatewayRetry = DateTime.UtcNow.AddSeconds(10);
                            UpdateStatus();
                        }));
                    });
            }
            return;
        }

        gatewayStartInFlight = false;
        if (tunnelReady)
        {
            tunnelRetryIndex = 0;
            nextTunnelRetry = DateTime.MinValue;
            return;
        }
        if (!autoStartTunnel || !IsValidTunnelId(tunnelId) || !HasTunnelKey() || DateTime.UtcNow < nextTunnelRetry || OwnedTunnelRunning() || tunnelStartInFlight) return;
        tunnelStartInFlight = true;
        Task.Run(delegate { StartManagedTunnel(); })
            .ContinueWith(delegate(Task task)
            {
                try
                {
                    window.Dispatcher.BeginInvoke(new Action(delegate
                    {
                        tunnelStartInFlight = false;
                        if (task.IsFaulted) ScheduleTunnelRetry();
                        UpdateStatus();
                    }));
                }
                catch { tunnelStartInFlight = false; }
            });
    }

    private void WireMicroMotion()
    {
        WireButtonMotion(Find<Button>("PowerButton"), 1.008);
        WireButtonMotion(Find<Button>("RefreshButton"), 1.018);
        WireButtonMotion(Find<Button>("FolderButton"), 1.018);
        WireButtonMotion(Find<Button>("LogsButton"), 1.018);
        WireButtonMotion(Find<Button>("ReadButton"), 1.008);
        WireButtonMotion(Find<Button>("WriteButton"), 1.008);
        WireButtonMotion(Find<Button>("FullButton"), 1.008);
        WireButtonMotion(Find<Button>("FullControlCancelButton"), 1.012);
        WireButtonMotion(Find<Button>("FullControlEnableButton"), 1.008);
        WireButtonMotion(Find<Button>("SettingsButton"), 1.018);
        WireButtonMotion(Find<Button>("SettingsBackButton"), 1.012);
        WireButtonMotion(Find<Button>("WorkspaceChangeButton"), 1.018);
        WireButtonMotion(Find<Button>("FirstRunChooseWorkspaceButton"), 1.012);
        WireButtonMotion(Find<Button>("FirstRunWorkspaceNextButton"), 1.008);
        WireButtonMotion(Find<Button>("FirstRunTunnelSkipButton"), 1.012);
        WireButtonMotion(Find<Button>("FirstRunTunnelSaveButton"), 1.008);
        WireButtonMotion(Find<Button>("FirstRunFinishButton"), 1.008);
        WireButtonMotion(Find<Button>("ThemeSystemButton"), 1.006);
        WireButtonMotion(Find<Button>("ThemeLightButton"), 1.006);
        WireButtonMotion(Find<Button>("ThemeDarkButton"), 1.006);
        WireButtonMotion(Find<Button>("ShortcutButton"), 1.012);
        WireButtonMotion(Find<Button>("StartupButton"), 1.012);
        WireButtonMotion(Find<Button>("TunnelAutoButton"), 1.012);
        WireButtonMotion(Find<Button>("TunnelConfigureButton"), 1.012);
        WireButtonMotion(Find<Button>("TunnelReconnectButton"), 1.012);
        WireButtonMotion(Find<Button>("TunnelSetupCancelButton"), 1.012);
        WireButtonMotion(Find<Button>("TunnelSetupSaveButton"), 1.008);
    }

    private void WireButtonMotion(Button button, double hoverScale)
    {
        ScaleTransform scale = new ScaleTransform(1, 1);
        button.RenderTransformOrigin = new Point(0.5, 0.5);
        button.RenderTransform = scale;
        button.MouseEnter += delegate { AnimateScale(scale, hoverScale, 130); };
        button.MouseLeave += delegate { AnimateScale(scale, 1.0, 160); };
        button.PreviewMouseLeftButtonDown += delegate { AnimateScale(scale, 0.985, 70); };
        button.PreviewMouseLeftButtonUp += delegate { AnimateScale(scale, hoverScale, 100); };
    }

    private void UpdateShortcutUi()
    {
        Button button = Find<Button>("ShortcutButton");
        if (button != null) button.Content = hotkeyText;
        if (openMenuItem != null) openMenuItem.Text = "Open Control Panel    " + hotkeyText;
    }

    private string FormatHotkey(uint modifiers, Key key)
    {
        string text = "";
        if ((modifiers & ModControl) != 0) text += "Ctrl + ";
        if ((modifiers & ModAlt) != 0) text += "Alt + ";
        if ((modifiers & ModShift) != 0) text += "Shift + ";
        if ((modifiers & ModWin) != 0) text += "Win + ";
        return text + key.ToString();
    }

    private bool TryApplyHotkey(uint modifiers, uint vk, string text)
    {
        uint oldModifiers = hotkeyModifiers;
        uint oldVk = hotkeyVk;
        string oldText = hotkeyText;
        UnregisterGlobalHotkey();
        hotkeyModifiers = modifiers;
        hotkeyVk = vk;
        hotkeyText = text;
        RegisterGlobalHotkey();
        if (!hotkeyRegistered)
        {
            hotkeyModifiers = oldModifiers;
            hotkeyVk = oldVk;
            hotkeyText = oldText;
            RegisterGlobalHotkey();
            UpdateShortcutUi();
            return false;
        }
        SaveSettings();
        UpdateShortcutUi();
        return true;
    }

    private void EditShortcut()
    {
        suppressAutoHide = true;
        Window dialog = new Window();
        dialog.Owner = window;
        dialog.Width = 330;
        dialog.Height = 190;
        dialog.WindowStyle = WindowStyle.None;
        dialog.ResizeMode = ResizeMode.NoResize;
        dialog.AllowsTransparency = true;
        dialog.Background = Brushes.Transparent;
        dialog.ShowInTaskbar = false;
        dialog.Topmost = true;
        dialog.WindowStartupLocation = WindowStartupLocation.CenterOwner;

        Border shell = new Border();
        shell.CornerRadius = new CornerRadius(24);
        shell.Padding = new Thickness(20);
        shell.Background = BrushFrom(isDarkTheme ? "#F02A2A2E" : "#F8FFFFFF");
        shell.BorderBrush = BrushFrom(isDarkTheme ? "#2FFFFFFF" : "#18000000");
        shell.BorderThickness = new Thickness(1);
        shell.Effect = new DropShadowEffect { BlurRadius = 28, ShadowDepth = 8, Opacity = 0.25, Color = Colors.Black };

        StackPanel stack = new StackPanel();
        TextBlock title = new TextBlock();
        title.Text = "Press a new shortcut";
        title.FontSize = 17;
        title.FontWeight = FontWeights.SemiBold;
        title.Foreground = BrushFrom(isDarkTheme ? "#F5F5F7" : "#18181B");
        TextBlock current = new TextBlock();
        current.Text = hotkeyText;
        current.FontSize = 15;
        current.FontWeight = FontWeights.SemiBold;
        current.Margin = new Thickness(0, 18, 0, 0);
        current.Foreground = BrushFrom("#007AFF");
        TextBlock hint = new TextBlock();
        hint.Text = "Use Ctrl, Alt, Shift or Win with another key · Esc to cancel";
        hint.FontSize = 10;
        hint.TextWrapping = TextWrapping.Wrap;
        hint.Margin = new Thickness(0, 10, 0, 0);
        hint.Foreground = BrushFrom(isDarkTheme ? "#98989F" : "#8E8E93");
        stack.Children.Add(title);
        stack.Children.Add(current);
        stack.Children.Add(hint);
        shell.Child = stack;
        dialog.Content = shell;

        dialog.PreviewKeyDown += delegate(object sender, KeyEventArgs e)
        {
            Key key = e.Key == Key.System ? e.SystemKey : e.Key;
            if (key == Key.Escape) { dialog.Close(); e.Handled = true; return; }
            if (key == Key.LeftCtrl || key == Key.RightCtrl || key == Key.LeftAlt || key == Key.RightAlt ||
                key == Key.LeftShift || key == Key.RightShift || key == Key.LWin || key == Key.RWin) return;
            uint modifiers = 0;
            ModifierKeys active = Keyboard.Modifiers;
            if ((active & ModifierKeys.Control) != 0) modifiers |= ModControl;
            if ((active & ModifierKeys.Alt) != 0) modifiers |= ModAlt;
            if ((active & ModifierKeys.Shift) != 0) modifiers |= ModShift;
            if ((active & ModifierKeys.Windows) != 0) modifiers |= ModWin;
            if (modifiers == 0)
            {
                hint.Text = "Add at least one modifier: Ctrl, Alt, Shift or Win.";
                hint.Foreground = BrushFrom("#FF453A");
                e.Handled = true;
                return;
            }
            uint vk = (uint)KeyInterop.VirtualKeyFromKey(key);
            string text = FormatHotkey(modifiers, key);
            if (TryApplyHotkey(modifiers, vk, text)) dialog.Close();
            else
            {
                current.Text = "Shortcut already in use";
                hint.Text = "Try another combination. Your previous shortcut is still active.";
                hint.Foreground = BrushFrom("#FF453A");
            }
            e.Handled = true;
        };

        dialog.Closed += delegate { suppressAutoHide = false; window.Activate(); };
        dialog.ShowDialog();
    }

    private void WireWindowEvents()
    {
        window.Deactivated += delegate
        {
            if (DateTime.UtcNow >= autoHideAfter && !suppressAutoHide)
                AnimateHide();
        };
        window.KeyDown += delegate(object sender, KeyEventArgs e)
        {
            if (e.Key != Key.Escape) return;
            Grid tunnelOverlay = Find<Grid>("TunnelSetupOverlay");
            Grid fullOverlay = Find<Grid>("FullControlOverlay");
            if (tunnelOverlay != null && tunnelOverlay.Visibility == Visibility.Visible) HideTunnelSetupOverlay();
            else if (fullOverlay != null && fullOverlay.Visibility == Visibility.Visible) HideFullControlOverlay(null);
            else if (settingsExpanded) ToggleSettings();
            else AnimateHide();
            e.Handled = true;
        };
        window.Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e)
        {
            if (!allowClose)
            {
                e.Cancel = true;
                AnimateHide();
            }
        };
        window.SourceInitialized += delegate
        {
            RegisterGlobalHotkey();
            notify.Text = hotkeyRegistered ? "DeskMCP · " + hotkeyText : "DeskMCP · Hotkey unavailable";
        };
        window.Loaded += delegate
        {
            AnimateProfileIndicator(selectedProfile, false);
            AnimateThemeIndicator(false);
        };
    }

    private void UpdateWorkspaceUi()
    {
        TextBlock pathText = Find<TextBlock>("WorkspacePathText");
        if (pathText != null) pathText.Text = currentWorkspace;
        string[] names = { "RecentWorkspace1", "RecentWorkspace2", "RecentWorkspace3" };
        int visible = 0;
        for (int i = 0; i < recentWorkspaces.Length && visible < names.Length; i++)
        {
            string recent = recentWorkspaces[i];
            if (String.IsNullOrWhiteSpace(recent) || !Directory.Exists(recent) || String.Equals(recent, currentWorkspace, StringComparison.OrdinalIgnoreCase)) continue;
            Button button = Find<Button>(names[visible++]);
            button.Content = Path.GetFileName(recent); button.Tag = recent; button.IsEnabled = true; button.Visibility = Visibility.Visible;
        }
        for (int i = visible; i < names.Length; i++) { Button button = Find<Button>(names[i]); button.Tag = null; button.IsEnabled = false; button.Visibility = Visibility.Collapsed; }
        Find<Border>("RecentCard").Visibility = visible > 0 ? Visibility.Visible : Visibility.Collapsed;
    }
    private void AddRecentWorkspace(string path)
    {
        string[] next = new string[Math.Min(3, recentWorkspaces.Length + 1)];
        next[0] = path; int n = 1;
        for (int i = 0; i < recentWorkspaces.Length && n < next.Length; i++) if (!String.Equals(recentWorkspaces[i], path, StringComparison.OrdinalIgnoreCase)) next[n++] = recentWorkspaces[i];
        recentWorkspaces = next;
    }

    private void ShowFirstRunWizard()
    {
        onboardingStep = 0;
        suppressAutoHide = true;
        Find<TextBlock>("FirstRunWorkspacePath").Text = currentWorkspace;
        TextBox idInput = Find<TextBox>("FirstRunTunnelIdInput");
        if (IsValidTunnelId(tunnelId)) idInput.Text = tunnelId;
        Find<PasswordBox>("FirstRunTunnelKeyInput").Clear();
        Grid overlay = Find<Grid>("FirstRunOverlay");
        overlay.Visibility = Visibility.Visible;
        overlay.Opacity = 1;
        UpdateFirstRunStep();
    }

    private void UpdateFirstRunStep()
    {
        Find<Grid>("FirstRunWorkspaceStep").Visibility = onboardingStep == 0 ? Visibility.Visible : Visibility.Collapsed;
        Find<Grid>("FirstRunTunnelStep").Visibility = onboardingStep == 1 ? Visibility.Visible : Visibility.Collapsed;
        Find<Grid>("FirstRunPluginStep").Visibility = onboardingStep == 2 ? Visibility.Visible : Visibility.Collapsed;
        Find<TextBlock>("FirstRunStepLabel").Text = (onboardingStep + 1).ToString() + " / 3";
        string[] titles = new string[] { "Choose your workspace", "Connect a secure Tunnel", "Connect ChatGPT" };
        Find<TextBlock>("FirstRunTitle").Text = titles[Math.Max(0, Math.Min(2, onboardingStep))];
        Find<TextBlock>("FirstRunWorkspacePath").Text = currentWorkspace;
    }

    private void FirstRunChooseWorkspace()
    {
        ChooseWorkspace();
        Find<TextBlock>("FirstRunWorkspacePath").Text = currentWorkspace;
    }
    private async void FirstRunSaveTunnelAndContinue()
    {
        TextBox idInput = Find<TextBox>("FirstRunTunnelIdInput");
        PasswordBox keyInput = Find<PasswordBox>("FirstRunTunnelKeyInput");
        TextBlock hint = Find<TextBlock>("FirstRunTunnelHint");
        Button save = Find<Button>("FirstRunTunnelSaveButton");
        Button skip = Find<Button>("FirstRunTunnelSkipButton");
        string id = idInput.Text.Trim();
        string key = keyInput.Password.Trim();
        if (!IsValidTunnelId(id)) { hint.Text = "Tunnel ID must look like tunnel_ followed by 32 lowercase hexadecimal characters."; hint.Foreground = BrushFrom("#FF453A"); return; }
        if (String.IsNullOrWhiteSpace(key) && !HasTunnelKey()) { hint.Text = "Paste a Runtime API Key, or choose Skip for now."; hint.Foreground = BrushFrom("#FF453A"); return; }
        save.IsEnabled = false; skip.IsEnabled = false;
        hint.Text = "Saving secure Tunnel…"; hint.Foreground = BrushFrom("#71717A");
        try
        {
            await Task.Run(delegate { ConfigureTunnelProfile(id); });
            tunnelId = id;
            if (!String.IsNullOrWhiteSpace(key)) SaveTunnelKey(key);
            autoStartTunnel = true;
            tunnelRetryIndex = 0;
            nextTunnelRetry = DateTime.MinValue;
            keyInput.Clear();
            SaveSettings();
            onboardingStep = 2;
            UpdateFirstRunStep();
        }
        catch (Exception ex)
        {
            keyInput.Clear(); hint.Text = "Could not configure Tunnel: " + ex.Message; hint.Foreground = BrushFrom("#FF453A");
        }
        finally { key = null; save.IsEnabled = true; skip.IsEnabled = true; }
    }
    private void FirstRunSkipTunnel()
    {
        onboardingStep = 2;
        UpdateFirstRunStep();
    }

    private void FinishFirstRun()
    {
        onboardingCompleted = true;
        SaveSettings();
        Grid overlay = Find<Grid>("FirstRunOverlay");
        overlay.Visibility = Visibility.Collapsed;
        overlay.Opacity = 0;
        suppressAutoHide = false;
        autoHideAfter = DateTime.UtcNow.AddSeconds(8);
        UpdateWorkspaceUi();
        UpdateTunnelSettingsUi();
        UpdateStatus();
        ShowToast("DeskMCP setup complete", false);
    }

    private void ChooseWorkspace()
    {
        using (Forms.FolderBrowserDialog dialog = new Forms.FolderBrowserDialog())
        {
            dialog.Description = "Choose DeskMCP workspace"; dialog.SelectedPath = currentWorkspace; dialog.ShowNewFolderButton = false;
            if (dialog.ShowDialog() != Forms.DialogResult.OK || !Directory.Exists(dialog.SelectedPath)) return;
            string previous = currentWorkspace; currentWorkspace = dialog.SelectedPath; AddRecentWorkspace(previous); SaveSettings(); UpdateWorkspaceUi();
            Find<TextBlock>("ScopeText").Text = currentWorkspace;
            if (!onboardingCompleted) { TextBlock firstRunPath = Find<TextBlock>("FirstRunWorkspacePath"); if (firstRunPath != null) firstRunPath.Text = currentWorkspace; }
            else RestartGatewayAsync(selectedProfile);
        }
    }

    private void UseRecentWorkspace(Button button)
    {
        string path = button.Tag as string; if (String.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return;
        string previous = currentWorkspace; currentWorkspace = path; AddRecentWorkspace(previous); SaveSettings(); UpdateWorkspaceUi(); Find<TextBlock>("ScopeText").Text = currentWorkspace; RestartGatewayAsync(selectedProfile);
    }
    private void ToggleSettings()
    {
        if (pageTransitioning) return;
        bool showSettings = !settingsExpanded;
        pageTransitioning = true;
        settingsExpanded = showSettings;
        PositionPanel();
        Grid mainPage = Find<Grid>("MainPage");
        Border settingsPage = Find<Border>("SettingsCard");
        FrameworkElement outgoing = showSettings ? (FrameworkElement)mainPage : settingsPage;
        FrameworkElement incoming = showSettings ? (FrameworkElement)settingsPage : mainPage;
        TranslateTransform outTx = (TranslateTransform)outgoing.RenderTransform;
        TranslateTransform inTx = (TranslateTransform)incoming.RenderTransform;
        double outTarget = showSettings ? -18.0 : 18.0;
        double inStart = showSettings ? 24.0 : -24.0;
        incoming.Visibility = Visibility.Visible;
        incoming.Opacity = 0;
        inTx.X = inStart;
        CubicEase outEase = new CubicEase();
        outEase.EasingMode = EasingMode.EaseIn;
        DoubleAnimation fadeOut = new DoubleAnimation(outgoing.Opacity, 0, TimeSpan.FromMilliseconds(125));
        fadeOut.EasingFunction = outEase;
        DoubleAnimation slideOut = new DoubleAnimation(outTx.X, outTarget, TimeSpan.FromMilliseconds(155));
        slideOut.EasingFunction = outEase;
        fadeOut.Completed += delegate
        {
            outgoing.Visibility = Visibility.Collapsed;
            outgoing.BeginAnimation(UIElement.OpacityProperty, null);
            outTx.BeginAnimation(TranslateTransform.XProperty, null);
            outgoing.Opacity = 1;
            outTx.X = 0;
            if (showSettings)
            {
                UpdateWorkspaceUi();
                AnimateThemeIndicator(false);
                Find<ScrollViewer>("SettingsScroll").ScrollToTop();
            }
            else
            {
                UpdateStatus();
                AnimateProfileIndicator(selectedProfile, false);
            }
            BackEase inEase = new BackEase();
            inEase.EasingMode = EasingMode.EaseOut;
            inEase.Amplitude = 0.08;
            DoubleAnimation fadeIn = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(220));
            CubicEase fadeEase = new CubicEase();
            fadeEase.EasingMode = EasingMode.EaseOut;
            fadeIn.EasingFunction = fadeEase;
            DoubleAnimation slideIn = new DoubleAnimation(inStart, 0, TimeSpan.FromMilliseconds(285));
            slideIn.EasingFunction = inEase;
            slideIn.Completed += delegate
            {
                incoming.BeginAnimation(UIElement.OpacityProperty, null);
                inTx.BeginAnimation(TranslateTransform.XProperty, null);
                incoming.Opacity = 1;
                inTx.X = 0;
                pageTransitioning = false;
            };
            incoming.BeginAnimation(UIElement.OpacityProperty, fadeIn);
            inTx.BeginAnimation(TranslateTransform.XProperty, slideIn);
        };
        outgoing.BeginAnimation(UIElement.OpacityProperty, fadeOut);
        outTx.BeginAnimation(TranslateTransform.XProperty, slideOut);
    }

    private void WireButtons()
    {
        Find<Button>("ReadButton").Click += delegate { SelectProfile("read-only"); };
        Find<Button>("WriteButton").Click += delegate { SelectProfile("workspace-write"); };
        Find<Button>("FullButton").Click += delegate { SelectProfile("full-control"); };
        Find<Button>("FullControlCancelButton").Click += delegate { HideFullControlOverlay(null); };
        Find<Button>("FullControlEnableButton").Click += delegate { HideFullControlOverlay(delegate { ApplyProfile("full-control"); }); };
        Find<Button>("ThemeSystemButton").Click += delegate { SetThemeMode("system"); };
        Find<Button>("ThemeLightButton").Click += delegate { SetThemeMode("light"); };
        Find<Button>("ThemeDarkButton").Click += delegate { SetThemeMode("dark"); };
        Find<Button>("ShortcutButton").Click += delegate { EditShortcut(); };
        Find<Button>("StartupButton").Click += delegate { ToggleStartWithWindows(); };
        Find<Button>("TunnelAutoButton").Click += delegate { ToggleTunnelAutoStart(); };
        Find<Button>("TunnelConfigureButton").Click += delegate { ConfigureTunnel(); };
        Find<Button>("TunnelSetupCancelButton").Click += delegate { HideTunnelSetupOverlay(); };
        Find<Button>("TunnelSetupSaveButton").Click += delegate { SaveTunnelSetup(); };
        Find<Button>("TunnelReconnectButton").Click += delegate { ReconnectTunnel(); };
        Find<Button>("SettingsButton").Click += delegate { ToggleSettings(); };
        Find<Button>("SettingsBackButton").Click += delegate { if (settingsExpanded) ToggleSettings(); };
        Find<Button>("WorkspaceChangeButton").Click += delegate { ChooseWorkspace(); };
        Find<Button>("FirstRunChooseWorkspaceButton").Click += delegate { FirstRunChooseWorkspace(); };
        Find<Button>("FirstRunWorkspaceNextButton").Click += delegate { onboardingStep = 1; UpdateFirstRunStep(); };
        Find<Button>("FirstRunTunnelSkipButton").Click += delegate { FirstRunSkipTunnel(); };
        Find<Button>("FirstRunTunnelSaveButton").Click += delegate { FirstRunSaveTunnelAndContinue(); };
        Find<Button>("FirstRunFinishButton").Click += delegate { FinishFirstRun(); };
        Find<Button>("RecentWorkspace1").Click += delegate(object sender, RoutedEventArgs e) { UseRecentWorkspace((Button)sender); };
        Find<Button>("RecentWorkspace2").Click += delegate(object sender, RoutedEventArgs e) { UseRecentWorkspace((Button)sender); };
        Find<Button>("RecentWorkspace3").Click += delegate(object sender, RoutedEventArgs e) { UseRecentWorkspace((Button)sender); };
        Find<Button>("PowerButton").Click += delegate
        {
            if (!statusInitialized) { ShowToast("Checking Gateway status…", false); UpdateStatus(); return; }
            if (!gatewayIsRunning)
                StartGatewayAsync(selectedProfile);
            else
                RestartGatewayAsync(selectedProfile);
            Find<TextBlock>("GatewayStatus").Text = "Starting…";
            Find<Ellipse>("GatewayDot").Fill = BrushFrom("#FF9F0A");
        };
        Find<Button>("RefreshButton").Click += delegate { UpdateStatus(); };
        Find<Button>("FolderButton").Click += delegate { OpenPath(currentWorkspace); };
        Find<Button>("LogsButton").Click += delegate
        {
            Directory.CreateDirectory(logsDir);
            OpenPath(logsDir);
        };
    }

    private static void OpenPath(string path)
    {
        ProcessStartInfo psi = new ProcessStartInfo(path);
        psi.UseShellExecute = true;
        Process.Start(psi);
    }

    private void TogglePanel()
    {
        if (window.IsVisible && !isHiding) AnimateHide();
        else { UpdateStatus(); AnimateShow(); }
    }

    private void RegisterGlobalHotkey()
    {
        if (hotkeyRegistered) return;
        hotkeyHwnd = new WindowInteropHelper(window).Handle;
        hotkeySource = HwndSource.FromHwnd(hotkeyHwnd);
        if (hotkeySource != null) hotkeySource.AddHook(HotkeyHook);
        hotkeyRegistered = RegisterHotKey(hotkeyHwnd, HotkeyId, hotkeyModifiers, hotkeyVk);
    }

    private void UnregisterGlobalHotkey()
    {
        if (hotkeyRegistered && hotkeyHwnd != IntPtr.Zero)
            UnregisterHotKey(hotkeyHwnd, HotkeyId);
        hotkeyRegistered = false;
        if (hotkeySource != null) hotkeySource.RemoveHook(HotkeyHook);
        hotkeySource = null;
        hotkeyHwnd = IntPtr.Zero;
    }

    private IntPtr HotkeyHook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WmHotkey && wParam.ToInt32() == HotkeyId)
        {
            TogglePanel();
            handled = true;
        }
        return IntPtr.Zero;
    }


    private async void QuitPanel(bool stopServices)
    {
        if (quitting) return;
        quitting = true;
        timer.Stop();
        UnregisterGlobalHotkey();
        if (stopServices)
        {
            try { await Task.Run(delegate { StopGateway(); StopOwnedTunnel(); }); } catch { }
        }
        allowClose = true;
        notify.Visible = false;
        if (notify.Icon != null) notify.Icon.Dispose();
        notify.Dispose();
        window.Close();
        app.Shutdown();
    }

    private void WireTray()
    {
        Forms.ContextMenuStrip menu = new Forms.ContextMenuStrip();
        openMenuItem = menu.Items.Add("Open Control Panel    " + hotkeyText);
        Forms.ToolStripItem open = openMenuItem;
        Forms.ToolStripItem restart = menu.Items.Add("Restart Gateway");
        Forms.ToolStripItem stop = menu.Items.Add("Stop Gateway");
        menu.Items.Add("-");
        Forms.ToolStripItem tunnel = menu.Items.Add("Open Tunnel UI");
        menu.Items.Add("-");
        Forms.ToolStripItem quitPanel = menu.Items.Add("Quit Control Panel (Keep Services Running)");
        Forms.ToolStripItem quitAll = menu.Items.Add("Quit DeskMCP");
        notify.ContextMenuStrip = menu;

        notify.MouseClick += delegate(object sender, Forms.MouseEventArgs e)
        {
            if (e.Button != Forms.MouseButtons.Left) return;
            TogglePanel();
        };
        open.Click += delegate { UpdateStatus(); AnimateShow(); };
        restart.Click += delegate { RestartGatewayAsync(selectedProfile); };
        stop.Click += delegate { StopGatewayAsync(); };
        tunnel.Click += delegate { OpenPath("http://127.0.0.1:8080/ui"); };
        quitPanel.Click += delegate { QuitPanel(false); };
        quitAll.Click += delegate { QuitPanel(true); };
    }
    public void AttachActivationEvent(EventWaitHandle activationEvent)
    {
        activationWaitRegistration = ThreadPool.RegisterWaitForSingleObject(activationEvent, delegate(object state, bool timedOut)
        {
            window.Dispatcher.BeginInvoke(new Action(delegate
            {
                UpdateStatus();
                if (window.IsVisible && !isHiding) { PositionPanel(); window.Activate(); }
                else AnimateShow();
            }));
        }, null, Timeout.Infinite, false);
    }

    public void Run(bool showInitially)
    {
        bool firstRun = !onboardingCompleted;
        if (firstRun)
        {
            ShowFirstRunWizard();
            AnimateShow();
        }
        else
        {
            UpdateStatus();
            if (showInitially) AnimateShow();
            else { new WindowInteropHelper(window).EnsureHandle(); window.Hide(); }
        }
        timer.Start();
        try { app.Run(); }
        finally { if (activationWaitRegistration != null) { activationWaitRegistration.Unregister(null); activationWaitRegistration = null; } }
    }

    private static void ApplyCaptureTheme(Window preview, bool dark)
    {
        ApplySemanticResources(preview, dark);
        ((Border)preview.FindName("RootCard")).Background = BrushFrom(dark ? "#FF0B0B0D" : "#FFFFFFFF");
        ((Border)preview.FindName("RootCard")).BorderBrush = BrushFrom(dark ? "#18FFFFFF" : "#10000000");
        ((TextBlock)preview.FindName("ProfileSectionTitle")).Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
        ((TextBlock)preview.FindName("ProfileHint")).Foreground = BrushFrom(dark ? "#98989F" : "#8E8E93");
        ((Border)preview.FindName("ProfileShell")).Background = BrushFrom(dark ? "#FF2A2A2E" : "#FFE7E7EC");
        ((Border)preview.FindName("ProfileIndicator")).Background = BrushFrom(dark ? "#FF424248" : "#FFFFFFFF");
        ((Border)preview.FindName("ScopeCard")).Background = BrushFrom(dark ? "#FF161618" : "#FFFFFFFF");
        ((Border)preview.FindName("ScopeCard")).BorderBrush = BrushFrom(dark ? "#24FFFFFF" : "#12000000");
        ((TextBlock)preview.FindName("ScopeLabel")).Foreground = BrushFrom(dark ? "#98989F" : "#8E8E93");
        ((TextBlock)preview.FindName("ScopeText")).Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
        ((TextBlock)preview.FindName("VersionText")).Foreground = BrushFrom(dark ? "#8E8E95" : "#A1A1AA");
        ((TextBlock)preview.FindName("SettingsTitle")).Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
        foreach (string name in new string[] { "WorkspaceLabel", "AppearanceLabel", "ShortcutLabel", "StartupLabel", "TunnelSettingsLabel", "TunnelIdValue" })
            ((TextBlock)preview.FindName(name)).Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
        foreach (string name in new string[] { "WorkspacePathText", "RecentLabel", "ShortcutHint", "StartupHint", "TunnelConfigStatus" })
            ((TextBlock)preview.FindName(name)).Foreground = BrushFrom(dark ? "#98989F" : "#8E8E93");
        ((Border)preview.FindName("ThemeShell")).Background = BrushFrom(dark ? "#FF2C2C2E" : "#FFE7E7EC");
        ((Border)preview.FindName("ThemeIndicator")).Background = BrushFrom(dark ? "#FF3A3A3C" : "#FFFFFFFF");

        foreach (string cardName in new string[] { "WorkspaceCard", "RecentCard", "AppearanceCard", "ShortcutCard", "StartupCard", "TunnelSettingsCard" })
            ((Border)preview.FindName(cardName)).Background = BrushFrom(dark ? "#FF1C1C1E" : "#FFF5F5F7");

        foreach (string name in new string[] { "RefreshButton", "SettingsButton", "SettingsBackButton", "FolderButton", "LogsButton", "ShortcutButton", "WorkspaceChangeButton", "RecentWorkspace1", "RecentWorkspace2", "RecentWorkspace3", "TunnelConfigureButton", "TunnelReconnectButton", "FirstRunChooseWorkspaceButton", "FirstRunTunnelSkipButton", "TunnelSetupCancelButton", "FullControlCancelButton" })
        {
            Button button = (Button)preview.FindName(name);
            button.Background = BrushFrom(dark ? "#FF2C2C2E" : "#FFF2F2F4");
            button.Foreground = BrushFrom(dark ? "#FFF5F5F7" : "#FF27272A");
        }
        Button startup = (Button)preview.FindName("StartupButton");
        startup.Background = BrushFrom(dark ? "#FF214A30" : "#FFEAF7ED");
        startup.Foreground = BrushFrom(dark ? "#FFD9FFE3" : "#FF2E7D32");
        Button tunnelAuto = (Button)preview.FindName("TunnelAutoButton");
        tunnelAuto.Background = BrushFrom(dark ? "#FF343439" : "#FFEFEFF2");
        tunnelAuto.Foreground = BrushFrom(dark ? "#FFA8A8AE" : "#FF71717A");
        Button themeSystem = (Button)preview.FindName("ThemeSystemButton");
        Button themeLight = (Button)preview.FindName("ThemeLightButton");
        Button themeDark = (Button)preview.FindName("ThemeDarkButton");
        themeSystem.Foreground = BrushFrom(dark ? "#F5F5F7" : "#18181B");
        themeLight.Foreground = BrushFrom(dark ? "#A8A8AE" : "#71717A");
        themeDark.Foreground = BrushFrom(dark ? "#A8A8AE" : "#71717A");
    }

    public static void CapturePreview(string xamlPath, string outputPath, int firstRunStep = -1, bool darkTheme = false, bool settingsPage = false, string modalCapture = null)
    {
        Window preview;
        using (FileStream stream = File.OpenRead(xamlPath))
            preview = (Window)XamlReader.Load(stream);
        ApplyCaptureTheme(preview, darkTheme);
        if (settingsPage) preview.Height = 650;

        ((Ellipse)preview.FindName("GatewayDot")).Fill = BrushFrom("#34C759");
        ((TextBlock)preview.FindName("GatewayStatus")).Text = "Running";
        ((Ellipse)preview.FindName("TunnelDot")).Fill = BrushFrom("#34C759");
        ((TextBlock)preview.FindName("TunnelStatus")).Text = "Ready";
        ((Ellipse)preview.FindName("LiveDot")).Fill = BrushFrom("#34C759");
        ((TextBlock)preview.FindName("LiveText")).Text = "Live";
        ((TextBlock)preview.FindName("ProfileBadge")).Text = "WRITE";
        ((TextBlock)preview.FindName("ProfileBadge")).Foreground = BrushFrom("#007AFF");
        ((TextBlock)preview.FindName("ProfileHint")).Text = "Guarded filesystem writes in workspace";
        ((TextBlock)preview.FindName("ScopeText")).Text = "C:\\Users\\User\\Desktop\\workspace";
        ((TextBlock)preview.FindName("VersionText")).Text = "Gateway 0.9.1";
        ((Button)preview.FindName("PowerButton")).Content = "Restart Gateway";
        if (firstRunStep >= 0)
        {
            Grid overlay = (Grid)preview.FindName("FirstRunOverlay");
            overlay.Visibility = Visibility.Visible;
            overlay.Opacity = 1;
            ((Grid)preview.FindName("FirstRunWorkspaceStep")).Visibility = firstRunStep == 0 ? Visibility.Visible : Visibility.Collapsed;
            ((Grid)preview.FindName("FirstRunTunnelStep")).Visibility = firstRunStep == 1 ? Visibility.Visible : Visibility.Collapsed;
            ((Grid)preview.FindName("FirstRunPluginStep")).Visibility = firstRunStep == 2 ? Visibility.Visible : Visibility.Collapsed;
            ((TextBlock)preview.FindName("FirstRunStepLabel")).Text = (firstRunStep + 1).ToString() + " / 3";
            string[] titles = new string[] { "Choose your workspace", "Connect a secure Tunnel", "Connect ChatGPT" };
            ((TextBlock)preview.FindName("FirstRunTitle")).Text = titles[Math.Max(0, Math.Min(2, firstRunStep))];
            ((TextBlock)preview.FindName("FirstRunWorkspacePath")).Text = @"C:\Users\You\Projects\my-workspace";
        }
        if (modalCapture == "tunnel")
        {
            Grid overlay = (Grid)preview.FindName("TunnelSetupOverlay");
            overlay.Visibility = Visibility.Visible; overlay.Opacity = 1;
            ScaleTransform scale = (ScaleTransform)((Border)preview.FindName("TunnelSetupModal")).RenderTransform; scale.ScaleX = 1; scale.ScaleY = 1;
        }
        else if (modalCapture == "full")
        {
            Grid overlay = (Grid)preview.FindName("FullControlOverlay");
            overlay.Visibility = Visibility.Visible; overlay.Opacity = 1;
            ScaleTransform scale = (ScaleTransform)((Border)preview.FindName("FullControlModal")).RenderTransform; scale.ScaleX = 1; scale.ScaleY = 1;
        }
        Button read = (Button)preview.FindName("ReadButton");
        Button write = (Button)preview.FindName("WriteButton");
        Button full = (Button)preview.FindName("FullButton");
        read.Foreground = BrushFrom(darkTheme ? "#A8A8AE" : "#71717A");
        write.Foreground = BrushFrom(darkTheme ? "#F5F5F7" : "#18181B");
        full.Foreground = BrushFrom(darkTheme ? "#A8A8AE" : "#71717A");
        if (settingsPage)
        {
            ((Grid)preview.FindName("MainPage")).Visibility = Visibility.Collapsed;
            Border settings = (Border)preview.FindName("SettingsCard");
            settings.Visibility = Visibility.Visible;
            settings.Opacity = 1;
        }

        Size size = new Size(preview.Width, preview.Height);
        preview.Measure(size);
        preview.Arrange(new Rect(0, 0, preview.Width, preview.Height));
        preview.UpdateLayout();
Border captureRoot = (Border)preview.FindName("RootCard");
        Size captureSize = new Size(preview.Width - 28, preview.Height - 28);
        captureRoot.Measure(captureSize);
        captureRoot.Arrange(new Rect(0, 0, captureSize.Width, captureSize.Height));
        captureRoot.UpdateLayout();
        Grid segments = (Grid)preview.FindName("ProfileSegmentsGrid");
        Border indicator = (Border)preview.FindName("ProfileIndicator");
        TranslateTransform transform = (TranslateTransform)indicator.RenderTransform;
        double segmentWidth = segments.ActualWidth / 3.0;
        indicator.Width = segmentWidth;
        transform.X = segmentWidth;
        indicator.UpdateLayout();
        if (settingsPage)
        {
            Grid themeSegments = (Grid)preview.FindName("ThemeSegmentsGrid");
            Border themeSelection = (Border)preview.FindName("ThemeIndicator");
            TranslateTransform themeTransform = (TranslateTransform)themeSelection.RenderTransform;
            double themeWidth = themeSegments.ActualWidth / 3.0;
            themeSelection.Width = themeWidth;
            themeTransform.X = 0;
            themeSelection.UpdateLayout();
        }
        const double dpi = 144.0;
        int pixelWidth = Math.Max(1, (int)(captureSize.Width * dpi / 96.0));
        int pixelHeight = Math.Max(1, (int)(captureSize.Height * dpi / 96.0));
        RenderTargetBitmap bitmap = new RenderTargetBitmap(
            pixelWidth, pixelHeight, dpi, dpi, PixelFormats.Pbgra32);
        bitmap.Render(captureRoot);
        PngBitmapEncoder encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using (FileStream output = File.Open(outputPath, FileMode.Create))
            encoder.Save(output);
        preview.Close();
    }
}

internal static class Program
{
    private const string MutexName = @"Local\DesktopMCP.ControlPanel.Singleton";
    private const string ActivationName = @"Local\DesktopMCP.ControlPanel.Activate";

    [STAThread]
    private static int Main(string[] args)
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string xamlPath = Path.Combine(baseDir, "Panel.xaml");
        string logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DesktopMCP", "logs");
        Directory.CreateDirectory(logDir);
        string logPath = Path.Combine(logDir, "control-panel-error.log");
        try
        {
            if (args.Length > 0 && args[0].StartsWith("--capture", StringComparison.Ordinal))
            {
                string mode = args[0];
                int step = (mode == "--capture-first-run-tunnel" || mode == "--capture-first-run-tunnel-dark") ? 1 : (mode == "--capture-first-run-plugin" || mode == "--capture-first-run-plugin-dark") ? 2 : (mode == "--capture-first-run" || mode == "--capture-first-run-dark") ? 0 : -1;
                bool darkCapture = mode == "--capture-dark" || mode == "--capture-settings-dark" || mode.EndsWith("-dark", StringComparison.Ordinal);
                bool settingsCapture = mode == "--capture-settings" || mode == "--capture-settings-dark";
                string modalCapture = (mode == "--capture-tunnel-modal" || mode == "--capture-tunnel-modal-dark") ? "tunnel" : (mode == "--capture-full-modal" || mode == "--capture-full-modal-dark") ? "full" : null;
                string output = args.Length > 1 ? args[1] : Path.Combine(baseDir, settingsCapture ? "settings-preview.png" : step >= 0 ? "first-run-preview.png" : modalCapture != null ? modalCapture + "-preview.png" : "panel-preview.png");
                ControlPanelRuntime.CapturePreview(xamlPath, output, step, darkCapture, settingsCapture, modalCapture);
                return 0;
            }
            bool startup = args.Length > 0 && args[0] == "--startup";
            using (EventWaitHandle activation = new EventWaitHandle(false, EventResetMode.AutoReset, ActivationName))
            using (Mutex singleInstance = new Mutex(false, MutexName))
            {
                bool acquired;
                try { acquired = singleInstance.WaitOne(0, false); } catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) { if (!startup) activation.Set(); return 0; }
                try
                {
                    ControlPanelRuntime runtime = new ControlPanelRuntime();
                    runtime.AttachActivationEvent(activation);
                    runtime.Run(!startup);
                    return 0;
                }
                finally { singleInstance.ReleaseMutex(); }
            }
        }
        catch (Exception ex)
        {
            try { File.AppendAllText(logPath, DateTime.Now.ToString("s") + Environment.NewLine + ex + Environment.NewLine + Environment.NewLine); } catch { }
            MessageBox.Show("DeskMCP Control Panel failed to start.\n\n" + ex.Message, "DeskMCP Control", MessageBoxButton.OK, MessageBoxImage.Error);
            return 1;
        }
    }
}
