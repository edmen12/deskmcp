using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using Microsoft.Win32;
using System.Windows.Forms;

[assembly: AssemblyTitle("DeskMCP Uninstaller")]
[assembly: AssemblyProduct("DeskMCP")]
[assembly: AssemblyVersion("0.9.4.0")]
[assembly: AssemblyFileVersion("0.9.4.0")]

internal static class DeskMcpUninstaller
{
    private const string ProductKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DesktopMCP";

    [STAThread]
    private static int Main(string[] args)
    {
        bool quiet = HasArg(args, "--quiet");
        bool purge = HasArg(args, "--purge-data");
        bool testMode = args.Length >= 2 && args[0] == "--test-root";
        string installDir = testMode ? Path.GetFullPath(args[1]) : AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        if (testMode) quiet = true;
        if (!quiet)
        {
            DialogResult answer = MessageBox.Show("Remove DeskMCP from this Windows account?\n\nYour settings, secrets, logs and workspace are kept by default.", "Uninstall DeskMCP", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return 1;
            purge = MessageBox.Show("Also remove DeskMCP user data?\n\nChoose No to keep settings, secrets, logs and workspace.", "Remove user data?", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes;
        }
        try
        {
            StopInstalledProcesses(installDir);
            if (!testMode)
            {
                DeleteIfExists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "DeskMCP Control Panel.lnk"));
                DeleteIfExists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Desktop MCP Control Panel.lnk"));
                DeleteIfExists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "DeskMCP.lnk"));
                DeleteIfExists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Desktop MCP.lnk"));
                try { Registry.CurrentUser.DeleteSubKeyTree(ProductKey, false); } catch { }
            }
            ScheduleRemoval(installDir, purge && !testMode);
            return 0;
        }
        catch (Exception ex)
        {
            if (!quiet) MessageBox.Show("DeskMCP could not be fully uninstalled.\n\n" + ex.Message, "Uninstall DeskMCP", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }
    }

    private static bool HasArg(string[] args, string value)
    {
        foreach (string arg in args) if (String.Equals(arg, value, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static void DeleteIfExists(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }
    private static string ResolveGatewayPortArgument()
    {
        string raw = Environment.GetEnvironmentVariable("DESKTOP_MCP_PORT");
        if (String.IsNullOrWhiteSpace(raw)) return "8765";
        int port;
        if (!Int32.TryParse(raw, out port) || port < 1 || port > 65535) return "8765";
        return port.ToString();
    }

    private static void StopInstalledProcesses(string installDir)
    {
        StopExactProcesses("DeskMCP", Path.Combine(installDir, "DeskMCP.exe"));
        StopExactProcesses("DesktopMcpControlPanel", Path.Combine(installDir, "DesktopMcpControlPanel.exe"));

        string gatewayDir = Path.Combine(installDir, "gateway");
        string nodePath = Path.Combine(installDir, "node", "node.exe");
        string stopScript = Path.Combine(gatewayDir, "dist", "src", "stop.js");
        if (File.Exists(nodePath) && File.Exists(stopScript))
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(nodePath, "dist\\src\\stop.js " + ResolveGatewayPortArgument());
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
    private static void ScheduleRemoval(string installDir, bool purgeData)
    {
        string script = Path.Combine(Path.GetTempPath(), "DesktopMCP-uninstall-" + Guid.NewGuid().ToString("N") + ".cmd");
        StringBuilder text = new StringBuilder();
        text.AppendLine("@echo off");
        text.AppendLine("timeout /t 2 /nobreak >nul");
        text.AppendLine("rmdir /s /q \"" + installDir.Replace("\"", "\"\"") + "\"");
        if (purgeData)
        {
            string localData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DesktopMCP");
            string roamingData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DesktopMCP");
            text.AppendLine("rmdir /s /q \"" + localData.Replace("\"", "\"\"") + "\"");
            text.AppendLine("rmdir /s /q \"" + roamingData.Replace("\"", "\"\"") + "\"");
        }
        text.AppendLine("del /q \"%~f0\"");
        File.WriteAllText(script, text.ToString(), Encoding.ASCII);
        string comspec = Environment.GetEnvironmentVariable("ComSpec");
        if (String.IsNullOrWhiteSpace(comspec)) comspec = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        ProcessStartInfo psi = new ProcessStartInfo(comspec, "/d /c \"\"" + script + "\"\"");
        psi.WorkingDirectory = Path.GetTempPath();
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        Process.Start(psi);
    }
}
