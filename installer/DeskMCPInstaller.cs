using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;
using System.Windows.Forms;

[assembly: AssemblyTitle("DeskMCP Setup")]
[assembly: AssemblyProduct("DeskMCP")]
[assembly: AssemblyVersion("0.9.1.0")]
[assembly: AssemblyFileVersion("0.9.1.0")]

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
    public const string Version = "0.9.1";
    private const string ProductKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DesktopMCP";
    private const string PayloadResource = "DesktopMCP.Payload.zip";
    private const string HashResource = "DesktopMCP.Payload.sha256";
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
                Directory.Move(finalDir, backupDir);
                backedUp = true;
            }
            if (options.SimulateFailureAfterBackup)
                throw new InvalidOperationException("Simulated install failure after backup.");
            Directory.Move(tempDir, finalDir);
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
                try { DeleteDirectoryBestEffort(finalDir); Directory.Move(backupDir, finalDir); } catch { }
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
        Directory.Move(restore, finalDir);
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
            "DeskMCPUninstaller.exe"
        };
        foreach (string relative in required) if (!File.Exists(Path.Combine(root, relative))) throw new InvalidDataException("Required payload file is missing: " + relative);
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
                if (p != null) { p.WaitForExit(7000); p.Dispose(); }
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

    private static void DeleteDirectoryBestEffort(string path)
    {
        if (String.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return;
        try { Directory.Delete(path, true); } catch { }
    }
}
internal sealed class InstallerForm : Form
{
    private readonly Label status;
    private readonly ProgressBar progress;
    private readonly Button installButton;
    private readonly Button cancelButton;
    private readonly CheckBox autoStart;
    private readonly CheckBox launchAfter;
    private readonly TextBox installPath;
    public int ExitCode { get; private set; }

    public InstallerForm()
    {
        Text = "DeskMCP Setup";
        Width = 560;
        Height = 365;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9F);
        BackColor = Color.FromArgb(248, 251, 255);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        Panel accent = new Panel();
        accent.BackColor = Color.FromArgb(45, 224, 216);
        accent.Location = new Point(0, 0);
        accent.Size = new Size(560, 6);
        Controls.Add(accent);
        PictureBox brand = new PictureBox();
        brand.Size = new Size(42, 42);
        brand.Location = new Point(30, 24);
        brand.SizeMode = PictureBoxSizeMode.Zoom;
        if (Icon != null) brand.Image = Icon.ToBitmap();
        Controls.Add(brand);

        Label title = new Label();
        title.Text = "DeskMCP";
        title.ForeColor = Color.FromArgb(7, 17, 31);
        title.Font = new Font("Segoe UI Semibold", 24F, FontStyle.Bold);
        title.AutoSize = true;
        title.Location = new Point(82, 22);
        Controls.Add(title);
        Label subtitle = new Label();
        subtitle.Text = "Open-source local desktop bridge for ChatGPT.";
        subtitle.ForeColor = Color.FromArgb(68, 91, 112);
        subtitle.AutoSize = true;
        subtitle.Location = new Point(84, 64);
        Controls.Add(subtitle);

        Label pathLabel = new Label();
        pathLabel.Text = "Install for this Windows user";
        pathLabel.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
        pathLabel.AutoSize = true;
        pathLabel.Location = new Point(33, 111);
        Controls.Add(pathLabel);

        installPath = new TextBox();
        installPath.ReadOnly = true;
        installPath.Text = InstallerEngine.DefaultInstallDir();
        installPath.Location = new Point(36, 136);
        installPath.Width = 478;
        Controls.Add(installPath);

        autoStart = new CheckBox();
        autoStart.Text = "Start DeskMCP with Windows";
        autoStart.Checked = InstallerEngine.DefaultAutoStart();
        autoStart.AutoSize = true;
        autoStart.Location = new Point(36, 177);
        Controls.Add(autoStart);

        launchAfter = new CheckBox();
        launchAfter.Text = "Open DeskMCP after installation";
        launchAfter.Checked = true;
        launchAfter.AutoSize = true;
        launchAfter.Location = new Point(36, 202);
        Controls.Add(launchAfter);

        progress = new ProgressBar();
        progress.Location = new Point(36, 238);
        progress.Width = 478;
        progress.Height = 8;
        progress.Minimum = 0;
        progress.Maximum = 100;
        Controls.Add(progress);

        status = new Label();
        status.Text = "Ready to install · no administrator access required";
        status.ForeColor = Color.FromArgb(105, 105, 112);
        status.AutoSize = true;
        status.Location = new Point(36, 255);
        Controls.Add(status);

        installButton = new Button();
        installButton.Text = "Install";
        installButton.Width = 112;
        installButton.Height = 34;
        installButton.Location = new Point(402, 286);
        installButton.BackColor = Color.FromArgb(37, 99, 235);
        installButton.ForeColor = Color.White;
        installButton.FlatStyle = FlatStyle.Flat;
        installButton.FlatAppearance.BorderSize = 0;
        installButton.Click += InstallButtonClick;
        Controls.Add(installButton);
        cancelButton = new Button();
        cancelButton.Text = "Cancel";
        cancelButton.Width = 92;
        cancelButton.Height = 34;
        cancelButton.Location = new Point(300, 286);
        cancelButton.Click += delegate { Close(); };
        Controls.Add(cancelButton);
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
            progress.Value = Math.Max(0, Math.Min(100, ev.ProgressPercentage));
            status.Text = ev.UserState as string ?? "Installing…";
        };
        worker.RunWorkerCompleted += delegate(object s, RunWorkerCompletedEventArgs ev)
        {
            if (ev.Error != null)
            {
                ExitCode = 2;
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
}
internal static class InstallerProgram
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--recover-test")
        {
            try { InstallerEngine.RecoverInterruptedInstall(Path.GetFullPath(args[1])); return 0; }
            catch { return 12; }
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
            catch { return 10; }
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        InstallerForm form = new InstallerForm();
        Application.Run(form);
        return form.ExitCode;
    }
}
