using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using System.Windows.Forms;

[assembly: AssemblyTitle("DeskMCP Setup")]
[assembly: AssemblyProduct("DeskMCP")]
[assembly: AssemblyVersion("0.9.3.0")]
[assembly: AssemblyFileVersion("0.9.3.0")]

internal sealed class InstallOptions
{
    public string InstallDir;
    public bool AutoStart;
    public bool RegisterUninstall;
    public bool CreateShortcuts;
    public bool LaunchAfterInstall;
    public bool SimulateFailureAfterBackup;
}

internal static class InstallerEngine
{
    public const string Version = "0.9.3";
    private const string ProductKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DesktopMCP";
    private const string PayloadResource = "DesktopMCP.Payload.zip";
    private const string HashResource = "DesktopMCP.Payload.sha256";
    private const string IntegrityManifest = "install-integrity.sha256";
    private const long DiskSafetyMarginBytes = 64L * 1024L * 1024L;
    public static string DefaultInstallDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DesktopMCP");
    }

    public static bool DefaultAutoStart()
    {
        string startup = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "DeskMCP Control Panel.lnk");
        string legacyStartup = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Desktop MCP Control Panel.lnk");
        bool existingInstall = Directory.Exists(DefaultInstallDir());
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(ProductKey)) existingInstall = existingInstall || key != null;
        }
        catch { }
        return existingInstall ? File.Exists(startup) || File.Exists(legacyStartup) : true;
    }

    public static void Install(InstallOptions options, Action<int, string> progress)
    {
        string finalDir = Path.GetFullPath(options.InstallDir);
        string parent = Path.GetDirectoryName(finalDir);
        Directory.CreateDirectory(parent);
        RecoverInterruptedInstall(finalDir);
        string tempDir = finalDir + ".install-" + Guid.NewGuid().ToString("N");
        string backupDir = finalDir + ".backup-" + Guid.NewGuid().ToString("N");
        bool backedUp = false;
        try
        {
            progress(3, "Verifying installation package…");
            ExtractPayload(tempDir, progress);
            VerifyPayload(tempDir);
            progress(82, "Preparing DeskMCP…");
            if (Directory.Exists(finalDir))
            {
                StopInstalledProcesses(finalDir);
                MoveDirectoryWithRetry(finalDir, backupDir, "back up the existing DeskMCP installation");
                backedUp = true;
            }
            if (options.SimulateFailureAfterBackup)
                throw new InvalidOperationException("Simulated install failure after backup.");
            MoveDirectoryWithRetry(tempDir, finalDir, "activate the new DeskMCP installation");
            progress(88, "Creating shortcuts…");
            if (options.CreateShortcuts) ConfigureShortcuts(finalDir, options.AutoStart);
            progress(93, "Registering DeskMCP…");
            if (options.RegisterUninstall) RegisterUninstaller(finalDir);
            if (backedUp) DeleteDirectoryBestEffort(backupDir);
            progress(100, "DeskMCP is installed.");
            if (options.LaunchAfterInstall)
            {
                ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(finalDir, "DeskMCP.exe"));
                psi.WorkingDirectory = finalDir;
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
        }
        catch
        {
            if (backedUp && Directory.Exists(backupDir))
            {
                try { DeleteDirectoryBestEffort(finalDir); MoveDirectoryWithRetry(backupDir, finalDir, "restore the previous DeskMCP installation"); } catch { }
            }
            throw;
        }
        finally
        {
            DeleteDirectoryBestEffort(tempDir);
        }
    }

    public static void RecoverInterruptedInstall(string installDir)
    {
        string finalDir = Path.GetFullPath(installDir);
        string parent = Path.GetDirectoryName(finalDir);
        if (String.IsNullOrEmpty(parent) || !Directory.Exists(parent)) return;
        string name = Path.GetFileName(finalDir);

        foreach (string temp in Directory.GetDirectories(parent, name + ".install-*"))
            DeleteDirectoryBestEffort(temp);

        string[] backups = Directory.GetDirectories(parent, name + ".backup-*");
        if (backups.Length == 0) return;
        if (Directory.Exists(finalDir) && IsValidPayload(finalDir))
        {
            foreach (string backup in backups) DeleteDirectoryBestEffort(backup);
            return;
        }

        string restore = null;
        DateTime newest = DateTime.MinValue;
        foreach (string backup in backups)
        {
            if (!IsValidPayload(backup)) continue;
            DateTime changed = Directory.GetLastWriteTimeUtc(backup);
            if (restore == null || changed > newest) { restore = backup; newest = changed; }
        }
        if (restore == null) return;
        if (Directory.Exists(finalDir)) DeleteDirectoryBestEffort(finalDir);
        MoveDirectoryWithRetry(restore, finalDir, "recover the previous DeskMCP installation");
        foreach (string backup in backups) if (Directory.Exists(backup)) DeleteDirectoryBestEffort(backup);
    }

    private static bool IsValidPayload(string root)
    {
        try { VerifyPayload(root); return true; }
        catch { return false; }
    }

    private static void ExtractPayload(string destination, Action<int, string> progress)
    {
        Directory.CreateDirectory(destination);
        string tempZip = Path.Combine(Path.GetTempPath(), "DesktopMCP-payload-" + Guid.NewGuid().ToString("N") + ".zip");
        try
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream input = asm.GetManifestResourceStream(PayloadResource))
            {
                if (input == null) throw new InvalidOperationException("Embedded DeskMCP payload is missing.");
                using (FileStream output = File.Create(tempZip)) input.CopyTo(output);
            }
            string expected = ReadEmbeddedText(HashResource).Trim().ToLowerInvariant();
            string actual = HashFile(tempZip);
            if (!String.Equals(expected, actual, StringComparison.Ordinal)) throw new InvalidDataException("DeskMCP payload SHA-256 verification failed.");
            progress(8, "Extracting DeskMCP…");
            using (ZipArchive archive = ZipFile.OpenRead(tempZip))
            {
                EnsureDiskSpaceForExtraction(destination, archive);
                string root = Path.GetFullPath(destination).TrimEnd('\\') + "\\";
                int total = Math.Max(1, archive.Entries.Count);
                for (int i = 0; i < archive.Entries.Count; i++)
                {
                    ZipArchiveEntry entry = archive.Entries[i];
                    string target = Path.GetFullPath(Path.Combine(destination, entry.FullName.Replace('/', '\\')));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Unsafe path found in DeskMCP payload.");
                    if (String.IsNullOrEmpty(entry.Name)) Directory.CreateDirectory(target);
                    else
                    {
                        string dir = Path.GetDirectoryName(target);
                        if (!String.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                        entry.ExtractToFile(target, true);
                    }
                    if ((i % 250) == 0) progress(8 + (int)(70.0 * i / total), "Extracting DeskMCP…");
                }
            }
        }
        finally { try { if (File.Exists(tempZip)) File.Delete(tempZip); } catch { } }
    }
    private static void EnsureDiskSpaceForExtraction(string destination, ZipArchive archive)
    {
        long payloadBytes = 0;
        checked
        {
            foreach (ZipArchiveEntry entry in archive.Entries) payloadBytes += entry.Length;
            payloadBytes += DiskSafetyMarginBytes;
        }
        string driveRoot = Path.GetPathRoot(Path.GetFullPath(destination));
        DriveInfo drive = new DriveInfo(driveRoot);
        if (drive.AvailableFreeSpace < payloadBytes)
        {
            long requiredMb = (payloadBytes + 1024L * 1024L - 1) / (1024L * 1024L);
            long availableMb = drive.AvailableFreeSpace / (1024L * 1024L);
            throw new IOException("DeskMCP needs at least " + requiredMb + " MB free on " + drive.Name + "; only " + availableMb + " MB is available.");
        }
    }

    private static string ReadEmbeddedText(string resourceName)
    {
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
        {
            if (stream == null) throw new InvalidOperationException("Embedded resource is missing: " + resourceName);
            using (StreamReader reader = new StreamReader(stream, Encoding.ASCII)) return reader.ReadToEnd();
        }
    }

    private static string HashFile(string path)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream stream = File.OpenRead(path))
        {
            byte[] hash = sha.ComputeHash(stream);
            StringBuilder text = new StringBuilder(hash.Length * 2);
            foreach (byte b in hash) text.Append(b.ToString("x2"));
            return text.ToString();
        }
    }

    private static void VerifyPayload(string root)
    {
        string[] required = {
            "DeskMCP.exe",
            "Panel.xaml",
            Path.Combine("node", "node.exe"),
            Path.Combine("gateway", "dist", "src", "index.js"),
            "release-target.json",
            "DeskMCPUninstaller.exe",
            IntegrityManifest
        };
        foreach (string relative in required)
            if (!File.Exists(Path.Combine(root, relative))) throw new InvalidDataException("Required payload file is missing: " + relative);

        bool sawPanel = false, sawNode = false, sawGateway = false, sawTunnel = false, sawUninstaller = false;
        string rootPrefix = Path.GetFullPath(root).TrimEnd('\\') + "\\";
        foreach (string raw in File.ReadAllLines(Path.Combine(root, IntegrityManifest)))
        {
            string line = raw.Trim();
            if (line.Length == 0) continue;
            if (line.Length < 67 || line[64] != ' ' || line[65] != ' ') throw new InvalidDataException("Malformed DeskMCP integrity manifest entry.");
            string expected = line.Substring(0, 64).ToLowerInvariant();
            for (int i = 0; i < expected.Length; i++)
            {
                char c = expected[i];
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) throw new InvalidDataException("Malformed DeskMCP integrity hash.");
            }
            string relative = line.Substring(66).Replace('/', '\\');
            if (Path.IsPathRooted(relative) || relative.Contains("..")) throw new InvalidDataException("Unsafe path in DeskMCP integrity manifest.");
            string full = Path.GetFullPath(Path.Combine(root, relative));
            if (!full.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
                throw new InvalidDataException("Integrity-protected payload file is missing: " + relative);
            string actual = HashFile(full);
            if (!String.Equals(expected, actual, StringComparison.Ordinal)) throw new InvalidDataException("DeskMCP installed payload integrity check failed: " + relative);
            if (String.Equals(relative, "DeskMCP.exe", StringComparison.OrdinalIgnoreCase)) sawPanel = true;
            if (String.Equals(relative, Path.Combine("node", "node.exe"), StringComparison.OrdinalIgnoreCase)) sawNode = true;
            if (String.Equals(relative, Path.Combine("gateway", "dist", "src", "index.js"), StringComparison.OrdinalIgnoreCase)) sawGateway = true;
            if (String.Equals(relative, "DeskMCPUninstaller.exe", StringComparison.OrdinalIgnoreCase)) sawUninstaller = true;
            if (relative.EndsWith(Path.Combine("bin", "tunnel-client.exe"), StringComparison.OrdinalIgnoreCase) && relative.StartsWith("tunnel-client\\", StringComparison.OrdinalIgnoreCase)) sawTunnel = true;
        }
        if (!sawPanel || !sawNode || !sawGateway || !sawTunnel || !sawUninstaller)
            throw new InvalidDataException("DeskMCP integrity manifest does not cover all critical runtime files.");
    }
    private static void StopInstalledProcesses(string installDir)
    {
        StopExactProcesses("DeskMCP", Path.Combine(installDir, "DeskMCP.exe"));
        StopExactProcesses("DesktopMcpControlPanel", Path.Combine(installDir, "DesktopMcpControlPanel.exe"));
        string nodePath = Path.Combine(installDir, "node", "node.exe");
        string gatewayDir = Path.Combine(installDir, "gateway");
        string stopScript = Path.Combine(gatewayDir, "dist", "src", "stop.js");
        if (File.Exists(nodePath) && File.Exists(stopScript))
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(nodePath, "dist\\src\\stop.js");
                psi.WorkingDirectory = gatewayDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process p = Process.Start(psi);
                if (p != null)
                {
                    try
                    {
                        if (!p.WaitForExit(5000))
                        {
                            try { p.Kill(); } catch { }
                            try { p.WaitForExit(2000); } catch { }
                        }
                    }
                    finally { p.Dispose(); }
                }
            }
            catch { }
        }
        StopExactProcesses("node", nodePath);
        StopProcessesUnderRoot("tunnel-client", installDir);
    }

    private static void StopExactProcesses(string processName, string expectedPath)
    {
        foreach (Process p in Process.GetProcessesByName(processName))
        {
            try
            {
                string actual = p.MainModule.FileName;
                if (!String.Equals(Path.GetFullPath(actual), Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase)) continue;
                p.Kill();
                p.WaitForExit(5000);
            }
            catch { }
            finally { try { p.Dispose(); } catch { } }
        }
    }

    private static void StopProcessesUnderRoot(string processName, string root)
    {
        string prefix = Path.GetFullPath(root).TrimEnd('\\') + "\\";
        foreach (Process p in Process.GetProcessesByName(processName))
        {
            try
            {
                string actual = Path.GetFullPath(p.MainModule.FileName);
                if (!actual.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                p.Kill();
                p.WaitForExit(5000);
            }
            catch { }
            finally { try { p.Dispose(); } catch { } }
        }
    }
    private static void ConfigureShortcuts(string installDir, bool autoStart)
    {
        string panel = Path.Combine(installDir, "DeskMCP.exe");
        string legacyMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Desktop MCP.lnk");
        try { if (File.Exists(legacyMenu)) File.Delete(legacyMenu); } catch { }
        string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "DeskMCP.lnk");
        CreateShortcut(menu, panel, "", installDir, "DeskMCP Control Panel");
        string legacyStartup = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Desktop MCP Control Panel.lnk");
        try { if (File.Exists(legacyStartup)) File.Delete(legacyStartup); } catch { }
        string startup = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "DeskMCP Control Panel.lnk");
        if (autoStart) CreateShortcut(startup, panel, "--startup", installDir, "DeskMCP Control Panel");
        else { try { if (File.Exists(startup)) File.Delete(startup); } catch { } }
    }

    private static void CreateShortcut(string shortcutPath, string target, string arguments, string workingDirectory, string description)
    {
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) throw new InvalidOperationException("Windows Script Host is unavailable.");
        object shell = Activator.CreateInstance(shellType);
        object shortcut = null;
        try
        {
            shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
            Type t = shortcut.GetType();
            t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
            t.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { arguments });
            t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDirectory });
            t.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { description });
            t.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
        finally
        {
            if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (shell != null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }
    private static void RegisterUninstaller(string installDir)
    {
        string uninstaller = Path.Combine(installDir, "DeskMCPUninstaller.exe");
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(ProductKey))
        {
            key.SetValue("DisplayName", "DeskMCP");
            key.SetValue("DisplayVersion", Version);
            key.SetValue("Publisher", "DeskMCP");
            key.SetValue("InstallLocation", installDir);
            key.SetValue("DisplayIcon", Path.Combine(installDir, "DeskMCP.exe"));
            key.SetValue("UninstallString", "\"" + uninstaller + "\"");
            key.SetValue("QuietUninstallString", "\"" + uninstaller + "\" --quiet");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            key.SetValue("EstimatedSize", EstimateSizeKb(installDir), RegistryValueKind.DWord);
        }
    }

    private static int EstimateSizeKb(string root)
    {
        long total = 0;
        try { foreach (string file in Directory.GetFiles(root, "*", SearchOption.AllDirectories)) total += new FileInfo(file).Length; } catch { }
        long kb = total / 1024;
        return kb > Int32.MaxValue ? Int32.MaxValue : (int)kb;
    }

    private static void MoveDirectoryWithRetry(string source, string destination, string action)
    {
        Exception last = null;
        int delayMs = 100;
        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        while (true)
        {
            try
            {
                Directory.Move(source, destination);
                return;
            }
            catch (Exception ex)
            {
                if (!(ex is IOException) && !(ex is UnauthorizedAccessException)) throw;
                last = ex;
                if (DateTime.UtcNow >= deadline) break;
                Thread.Sleep(delayMs);
                delayMs = Math.Min(delayMs * 2, 1000);
            }
        }
        string lastMessage = last == null ? "unknown error" : last.Message;
        throw new IOException("Could not " + action + " within 30 seconds while waiting for transient Windows file locks to clear. Last error: " + lastMessage, last);
    }

    private static void DeleteDirectoryBestEffort(string path)
    {
        if (String.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return;
        try { Directory.Delete(path, true); } catch { }
    }
}
internal sealed class RoundedButton : Button
{
    public int Radius = 12;
    public RoundedButton()
    {
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        UseVisualStyleBackColor = false;
        Cursor = Cursors.Hand;
    }
    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        int r = Math.Max(2, Math.Min(Radius, Math.Min(Width, Height) / 2));
        using (GraphicsPath path = new GraphicsPath())
        {
            int d = r * 2;
            path.AddArc(0, 0, d, d, 180, 90);
            path.AddArc(Width - d - 1, 0, d, d, 270, 90);
            path.AddArc(Width - d - 1, Height - d - 1, d, d, 0, 90);
            path.AddArc(0, Height - d - 1, d, d, 90, 90);
            path.CloseFigure();
            Region = new Region(path);
        }
    }
}

internal sealed class BrandProgressBar : Control
{    private int value;
    public int Value
    {
        get { return value; }
        set { this.value = Math.Max(0, Math.Min(100, value)); Invalidate(); }
    }
    public BrandProgressBar()
    {
        DoubleBuffered = true;
        Height = 8;
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle track = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
        using (GraphicsPath trackPath = RoundedRect(track, Height / 2))
        using (SolidBrush trackBrush = new SolidBrush(Color.FromArgb(231, 231, 236)))
            e.Graphics.FillPath(trackBrush, trackPath);
        int fillWidth = (int)Math.Round(track.Width * (Value / 100.0));
        if (fillWidth < 2) return;
        Rectangle fill = new Rectangle(0, 0, fillWidth, track.Height);
        using (GraphicsPath fillPath = RoundedRect(fill, Height / 2))
        using (LinearGradientBrush brush = new LinearGradientBrush(fill, Color.FromArgb(45,224,216), Color.FromArgb(37,99,235), 0f))
            e.Graphics.FillPath(brush, fillPath);
    }
    private static GraphicsPath RoundedRect(Rectangle r, int radius)
    {        GraphicsPath path = new GraphicsPath();
        int d = Math.Max(2, radius * 2);
        path.AddArc(r.Left, r.Top, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Top, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}

internal sealed class ModernCheckBox : CheckBox
{
    public ModernCheckBox()
    {
        AutoSize = false; Height = 28; BackColor = Color.White; ForeColor = Color.FromArgb(39,39,42);
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Cursor = Cursors.Hand;
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias; e.Graphics.Clear(BackColor);
        Rectangle box = new Rectangle(0, 5, 17, 17);
        using (GraphicsPath path = new GraphicsPath())
        {
            path.AddArc(box.Left,box.Top,6,6,180,90); path.AddArc(box.Right-6,box.Top,6,6,270,90);
            path.AddArc(box.Right-6,box.Bottom-6,6,6,0,90); path.AddArc(box.Left,box.Bottom-6,6,6,90,90); path.CloseFigure();
            using (SolidBrush fill = new SolidBrush(Checked ? Color.FromArgb(37,99,235) : Color.FromArgb(245,245,247))) e.Graphics.FillPath(fill,path);
            using (Pen pen = new Pen(Checked ? Color.FromArgb(37,99,235) : Color.FromArgb(212,212,216))) e.Graphics.DrawPath(pen,path);
        }
        if (Checked) using (Pen check = new Pen(Color.White, 2f)) { check.StartCap=LineCap.Round; check.EndCap=LineCap.Round; e.Graphics.DrawLines(check,new Point[]{new Point(4,13),new Point(7,16),new Point(13,9)}); }
        TextRenderer.DrawText(e.Graphics, Text, Font, new Rectangle(27,0,Width-27,Height), ForeColor, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
    }
    protected override void OnCheckedChanged(EventArgs e) { base.OnCheckedChanged(e); Invalidate(); }
}

internal sealed class InstallerForm : Form
{
    private readonly Label status;
    private readonly BrandProgressBar progress;
    private readonly RoundedButton installButton;
    private readonly RoundedButton cancelButton;
    private readonly ModernCheckBox autoStart;
    private readonly ModernCheckBox launchAfter;
    private readonly TextBox installPath;
    public int ExitCode { get; private set; }

    public InstallerForm()
    {
        Text = "DeskMCP Setup";
        ClientSize = new Size(600, 390);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9F);
        BackColor = Color.White;
        AutoScaleMode = AutoScaleMode.Dpi;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        Panel hero = new Panel();
        hero.BackColor = Color.FromArgb(17, 17, 19);
        hero.Location = new Point(0, 0);
        hero.Size = new Size(600, 112);
        Controls.Add(hero);

        PictureBox brand = new PictureBox();
        brand.Size = new Size(48, 48);
        brand.Location = new Point(34, 27);
        brand.SizeMode = PictureBoxSizeMode.Zoom;
        if (Icon != null) brand.Image = Icon.ToBitmap();
        hero.Controls.Add(brand);

        Label title = new Label();
        title.Text = "DeskMCP";
        title.ForeColor = Color.White;
        title.Font = new Font("Segoe UI Semibold", 23F, FontStyle.Bold);
        title.AutoSize = true;
        title.Location = new Point(96, 22);
        hero.Controls.Add(title);

        Label subtitle = new Label();
        subtitle.Text = "Your desktop. Connected to AI.";
        subtitle.ForeColor = Color.FromArgb(161, 161, 170);
        subtitle.AutoSize = true;
        subtitle.Location = new Point(98, 64);
        hero.Controls.Add(subtitle);

        Label version = new Label();
        version.Text = "v" + InstallerEngine.Version;
        version.ForeColor = Color.FromArgb(142, 142, 147);
        version.AutoSize = true;
        version.Location = new Point(520, 46);
        hero.Controls.Add(version);

        Label pathLabel = new Label();
        pathLabel.Text = "Install location";
        pathLabel.ForeColor = Color.FromArgb(39, 39, 42);
        pathLabel.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
        pathLabel.AutoSize = true;
        pathLabel.Location = new Point(35, 137);
        Controls.Add(pathLabel);

        installPath = new TextBox();
        installPath.ReadOnly = true;
        installPath.Text = InstallerEngine.DefaultInstallDir();
        installPath.Location = new Point(38, 161);
        installPath.Width = 524;
        installPath.Height = 31;
        installPath.BackColor = Color.FromArgb(245, 245, 247);
        installPath.ForeColor = Color.FromArgb(39, 39, 42);
        installPath.BorderStyle = BorderStyle.FixedSingle;
        installPath.TabStop = false;
        Controls.Add(installPath);
        Label installHint = new Label();
        installHint.Text = "Installs for this Windows user only · no administrator access required";
        installHint.ForeColor = Color.FromArgb(113, 113, 122);
        installHint.AutoSize = true;
        installHint.Location = new Point(38, 199);
        Controls.Add(installHint);

        autoStart = new ModernCheckBox();
        autoStart.Text = "Start DeskMCP with Windows";
        autoStart.Checked = InstallerEngine.DefaultAutoStart();
        autoStart.AutoSize = false;
        autoStart.Width = 300;
        autoStart.ForeColor = Color.FromArgb(39, 39, 42);
        autoStart.Location = new Point(38, 228);
        Controls.Add(autoStart);

        launchAfter = new ModernCheckBox();
        launchAfter.Text = "Open DeskMCP after installation";
        launchAfter.Checked = true;
        launchAfter.AutoSize = false;
        launchAfter.Width = 300;
        launchAfter.ForeColor = Color.FromArgb(39, 39, 42);
        launchAfter.Location = new Point(38, 254);
        Controls.Add(launchAfter);

        progress = new BrandProgressBar();
        progress.Location = new Point(38, 291);
        progress.Width = 524;
        Controls.Add(progress);
        status = new Label();
        status.Text = "Ready to install";
        status.ForeColor = Color.FromArgb(113, 113, 122);
        status.AutoSize = true;
        status.Location = new Point(38, 310);
        Controls.Add(status);

        cancelButton = new RoundedButton();
        cancelButton.Text = "Cancel";
        cancelButton.Width = 104;
        cancelButton.Height = 40;
        cancelButton.Location = new Point(336, 335);
        cancelButton.BackColor = Color.FromArgb(242, 242, 244);
        cancelButton.ForeColor = Color.FromArgb(39, 39, 42);
        cancelButton.Font = new Font("Segoe UI Semibold", 9.5F, FontStyle.Bold);
        cancelButton.Click += delegate { Close(); };
        Controls.Add(cancelButton);

        installButton = new RoundedButton();
        installButton.Text = "Install";
        installButton.Width = 122;
        installButton.Height = 40;
        installButton.Location = new Point(448, 335);
        installButton.BackColor = Color.FromArgb(37, 99, 235);
        installButton.ForeColor = Color.White;
        installButton.Font = new Font("Segoe UI Semibold", 9.5F, FontStyle.Bold);
        installButton.Click += InstallButtonClick;
        Controls.Add(installButton);
        AcceptButton = installButton;
        CancelButton = cancelButton;
        Shown += delegate { installButton.Select(); };
    }
    private void InstallButtonClick(object sender, EventArgs e)
    {
        installButton.Enabled = false;
        cancelButton.Enabled = false;
        autoStart.Enabled = false;
        launchAfter.Enabled = false;
        status.Text = "Preparing installation…";
        BackgroundWorker worker = new BackgroundWorker();
        worker.WorkerReportsProgress = true;
        worker.DoWork += delegate
        {
            InstallOptions options = new InstallOptions();
            options.InstallDir = installPath.Text;
            options.AutoStart = autoStart.Checked;
            options.RegisterUninstall = true;
            options.CreateShortcuts = true;
            options.LaunchAfterInstall = launchAfter.Checked;
            InstallerEngine.Install(options, delegate(int percent, string message) { worker.ReportProgress(percent, message); });
        };
        worker.ProgressChanged += delegate(object s, ProgressChangedEventArgs ev)
        {
            progress.Value = ev.ProgressPercentage;
            status.Text = ev.UserState as string ?? "Installing…";
        };
        worker.RunWorkerCompleted += delegate(object s, RunWorkerCompletedEventArgs ev)
        {
            if (ev.Error != null)
            {                ExitCode = 2;
                progress.Value = 0;
                status.Text = "Installation failed";
                MessageBox.Show("DeskMCP could not be installed.\n\n" + ev.Error.Message, "DeskMCP Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                installButton.Enabled = true;
                cancelButton.Enabled = true;
                autoStart.Enabled = true;
                launchAfter.Enabled = true;
                return;
            }
            ExitCode = 0;
            progress.Value = 100;
            status.Text = "DeskMCP is installed.";
            installButton.Text = "Done";
            installButton.Enabled = true;
            installButton.Click -= InstallButtonClick;
            installButton.Click += delegate { Close(); };
            cancelButton.Visible = false;
        };
        worker.RunWorkerAsync();
    }

    public void CaptureTo(string path)
    {
        Show();
        Refresh();
        Application.DoEvents();
        using (Bitmap bitmap = new Bitmap(Width, Height))
        {
            DrawToBitmap(bitmap, new Rectangle(0, 0, Width, Height));
            bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
        Close();
    }
}

internal static class InstallerProgram
{
    private const string InstallerMutexName = @"Local\DeskMCP.Setup.Singleton";

    private static string ResolveInstallerMutexName(string[] args)
    {
        if (args.Length == 0 || !args[0].StartsWith("--", StringComparison.Ordinal)) return InstallerMutexName;
        string testNamespace = Environment.GetEnvironmentVariable("DESKTOP_MCP_INSTALLER_MUTEX_NAMESPACE");
        if (String.IsNullOrWhiteSpace(testNamespace)) return InstallerMutexName;
        if (testNamespace.Length > 64) throw new InvalidOperationException("Installer test mutex namespace is too long.");
        for (int i = 0; i < testNamespace.Length; i++)
        {
            char c = testNamespace[i];
            if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.'))
                throw new InvalidOperationException("Installer test mutex namespace contains invalid characters.");
        }
        return InstallerMutexName + "." + testNamespace;
    }

    private static void WriteTestFailure(string prefix, Exception ex)
    {
        string message = prefix + "=" + ex.GetType().Name + ": " + ex.Message;
        try { Console.Error.WriteLine(message); } catch { }
        string logPath = Environment.GetEnvironmentVariable("DESKTOP_MCP_INSTALL_TEST_LOG");
        if (String.IsNullOrWhiteSpace(logPath)) return;
        try
        {
            string directory = Path.GetDirectoryName(Path.GetFullPath(logPath));
            if (!String.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            File.WriteAllText(logPath, message, new UTF8Encoding(false));
        }
        catch { }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.Length >= 2 && args[0] == "--capture-ui")
        {
            InstallerForm preview = new InstallerForm();
            preview.CaptureTo(Path.GetFullPath(args[1]));
            return 0;
        }

        using (Mutex mutex = new Mutex(false, ResolveInstallerMutexName(args)))
        {
            bool acquired;
            try { acquired = mutex.WaitOne(0, false); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired)
            {
                if (!(args.Length > 0 && args[0].StartsWith("--", StringComparison.Ordinal)))
                    MessageBox.Show("DeskMCP Setup is already running.", "DeskMCP Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 11;
            }
            try
            {
                if (args.Length > 0 && args[0] == "--mutex-test-hold")
                {
                    if (args.Length < 3) return 13;
                    string readyPath = Path.GetFullPath(args[1]);
                    string releasePath = Path.GetFullPath(args[2]);
                    string readyDir = Path.GetDirectoryName(readyPath);
                    if (!String.IsNullOrEmpty(readyDir)) Directory.CreateDirectory(readyDir);
                    File.WriteAllText(readyPath, "ready", Encoding.ASCII);
                    DateTime deadline = DateTime.UtcNow.AddSeconds(90);
                    while (!File.Exists(releasePath) && DateTime.UtcNow < deadline) Thread.Sleep(50);
                    return File.Exists(releasePath) ? 0 : 13;
                }
                if (args.Length >= 2 && args[0] == "--recover-test")
                {
                    try { InstallerEngine.RecoverInterruptedInstall(Path.GetFullPath(args[1])); return 0; }
                    catch (Exception ex) { WriteTestFailure("RECOVER_TEST_ERROR", ex); return 12; }
                }
                if (args.Length >= 2 && (args[0] == "--install-test" || args[0] == "--install-test-fail-after-backup"))
                {
                    try
                    {
                        InstallOptions test = new InstallOptions();
                        test.InstallDir = Path.GetFullPath(args[1]);
                        test.AutoStart = false;
                        test.RegisterUninstall = false;
                        test.CreateShortcuts = false;
                        test.LaunchAfterInstall = false;
                        test.SimulateFailureAfterBackup = args[0] == "--install-test-fail-after-backup";
                        InstallerEngine.Install(test, delegate { });
                        return 0;
                    }
                    catch (Exception ex) { WriteTestFailure("INSTALL_TEST_ERROR", ex); return 10; }
                }
                InstallerForm form = new InstallerForm();
                Application.Run(form);
                return form.ExitCode;
            }
            finally { mutex.ReleaseMutex(); }
        }
    }
}
