using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Controls;

internal sealed class UpdateCheckInfo
{
    public string kind { get; set; }
    public string version { get; set; }
    public string[] reasons { get; set; }
    public string releaseUrl { get; set; }
    public string downloadUrl { get; set; }
    public string artifact { get; set; }
    public long? sizeBytes { get; set; }
    public string sha256 { get; set; }
    public string target { get; set; }
}

internal sealed partial class ControlPanelRuntime
{
    private bool updateCheckInFlight;
    private string lastUpdateReleaseUrl;

    private static string CurrentProductVersion()
    {
        Version version = typeof(ControlPanelRuntime).Assembly.GetName().Version;
        return version.Major + "." + version.Minor + "." + Math.Max(version.Build, 0);
    }
    private static string InstalledUpdateTarget()
    {
        if (RuntimeInformation.ProcessArchitecture == Architecture.Arm64) return "win-arm64";
        if (RuntimeInformation.ProcessArchitecture == Architecture.X64) return "win-x64";
        return "unsupported";
    }

    private async void HandleUpdateButton()
    {
        if (updateCheckInFlight) return;
        Button button = Find<Button>("UpdateButton");
        if ((string)button.Content == "View Release" && !String.IsNullOrWhiteSpace(lastUpdateReleaseUrl))
        {
            OpenPath(lastUpdateReleaseUrl);
            return;
        }

        TextBlock status = Find<TextBlock>("UpdateStatus");
        updateCheckInFlight = true;
        button.IsEnabled = false;
        button.Content = "Checking…";
        status.Text = "Checking GitHub Releases…";
        try
        {
            UpdateCheckInfo result = await Task.Run(delegate { return RunUpdateCheck(); });
            ApplyUpdateCheckResult(result, button, status);
        }
        catch (Exception ex)
        {
            lastUpdateReleaseUrl = null;
            status.Text = "Could not check updates · " + ex.Message;
            button.Content = "Retry";
        }
        finally
        {
            updateCheckInFlight = false;
            button.IsEnabled = true;
        }
    }

    private UpdateCheckInfo RunUpdateCheck()
    {
        string target = InstalledUpdateTarget();
        if (target == "unsupported") throw new InvalidOperationException("This Windows architecture is unsupported.");
        string script = Path.Combine(projectRoot, "dist", "src", "update-check.js");
        if (!File.Exists(script)) throw new FileNotFoundException("Update checker is missing.", script);

        ProcessStartInfo psi = NewHiddenProcess(
            nodePath,
            "dist\\src\\update-check.js " + CurrentProductVersion() + " " + target
        );
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        using (Process process = Process.Start(psi))
        {
            if (process == null) throw new InvalidOperationException("Could not start the update checker.");
            Task<string> outputTask = process.StandardOutput.ReadToEndAsync();
            Task<string> errorTask = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(25000))
            {
                try { process.Kill(true); } catch { }
                throw new TimeoutException("Update check timed out.");
            }
            if (!Task.WaitAll(new Task[] { outputTask, errorTask }, 3000))
                throw new TimeoutException("Update checker output did not close cleanly.");
            string output = outputTask.Result;
            string error = errorTask.Result;
            if (process.ExitCode != 0)
                throw new InvalidOperationException(String.IsNullOrWhiteSpace(error) ? "Update checker failed." : error.Trim());
            UpdateCheckInfo result = JsonSerializer.Deserialize<UpdateCheckInfo>(output);
            if (result == null || String.IsNullOrWhiteSpace(result.kind))
                throw new InvalidDataException("Update checker returned invalid data.");
            return result;
        }
    }
    private void ApplyUpdateCheckResult(UpdateCheckInfo result, Button button, TextBlock status)
    {
        lastUpdateReleaseUrl = result.releaseUrl;
        string version = String.IsNullOrWhiteSpace(result.version) ? "new release" : "v" + result.version;
        if (result.kind == "up-to-date")
        {
            status.Text = "Up to date · " + version;
            button.Content = "Check Again";
            lastUpdateReleaseUrl = null;
            return;
        }
        if (result.kind == "verified-download-allowed")
        {
            status.Text = version + " available · verified metadata; signed auto-install remains gated";
            button.Content = "View Release";
            return;
        }
        if (result.kind == "manual-only")
        {
            status.Text = version + " available · manual install required (" + FriendlyUpdateReason(result.reasons) + ")";
            button.Content = "View Release";
            return;
        }
        status.Text = "Release metadata rejected · " + FriendlyUpdateReason(result.reasons);
        button.Content = String.IsNullOrWhiteSpace(lastUpdateReleaseUrl) ? "Retry" : "View Release";
    }

    private static string FriendlyUpdateReason(string[] reasons)
    {
        string reason = reasons != null && reasons.Length > 0 ? reasons[0] : "security policy";
        if (reason == "unsupported-manifest-schema") return "legacy release metadata";
        if (reason == "release-manifest-missing") return "no target manifest";
        if (reason == "release-manifest-unavailable") return "manifest unavailable";
        if (reason == "release-not-immutable") return "release is mutable";
        if (reason == "target-mismatch") return "different architecture";
        if (reason == "non-stable-release") return "non-stable release";
        return reason.Replace('-', ' ');
    }
}