using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace DeskMCP.ProcessHost;

internal static class ElevationDisclosure
{
    private const int DisplayMilliseconds = 1300;

    internal static bool IsEnabled()
    {
        try
        {
            string? settingsDir = Environment.GetEnvironmentVariable("DESKTOP_MCP_SETTINGS_DIR");
            if (String.IsNullOrWhiteSpace(settingsDir))
                settingsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DesktopMCP");
            string settingsPath = Path.Combine(Path.GetFullPath(settingsDir), "settings.json");
            if (!File.Exists(settingsPath)) return true;
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(settingsPath));
            if (document.RootElement.TryGetProperty("showAdminRequestDetails", out JsonElement value) &&
                (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.False))
                return value.GetBoolean();
        }
        catch { }
        return true;
    }

    internal static void ShowIfEnabled(string shell, string command)
    {
        if (!IsEnabled()) return;
        try
        {
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            using DisclosureForm form = new DisclosureForm(shell, RedactCommand(command));
            using System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = DisplayMilliseconds };
            timer.Tick += delegate { timer.Stop(); form.Close(); };
            form.Shown += delegate { timer.Start(); };
            Application.Run(form);
        }
        catch
        {
            // Disclosure is informational only. A rendering failure must never bypass,
            // approve, deny, or otherwise alter the Windows UAC decision.
        }
    }

    internal static int RunSelfTest()
    {
        string sample = "tool.exe --api-key topsecret password=hunter2 Authorization=Bearer123";
        string redacted = RedactCommand(sample);
        if (redacted.Contains("topsecret", StringComparison.Ordinal) ||
            redacted.Contains("hunter2", StringComparison.Ordinal) ||
            redacted.Contains("Bearer123", StringComparison.Ordinal))
            return 1;
        if (!redacted.Contains("tool.exe", StringComparison.Ordinal)) return 1;

        string? previousSettingsDir = Environment.GetEnvironmentVariable("DESKTOP_MCP_SETTINGS_DIR");
        string root = Path.Combine(Path.GetTempPath(), "deskmcp-disclosure-selftest-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(root);
            Environment.SetEnvironmentVariable("DESKTOP_MCP_SETTINGS_DIR", root);
            if (!IsEnabled()) return 1;
            File.WriteAllText(Path.Combine(root, "settings.json"), "{\"showAdminRequestDetails\":false}");
            if (IsEnabled()) return 1;
            File.WriteAllText(Path.Combine(root, "settings.json"), "{\"showAdminRequestDetails\":true}");
            if (!IsEnabled()) return 1;
            File.WriteAllText(Path.Combine(root, "settings.json"), "{invalid-json");
            if (!IsEnabled()) return 1;
        }
        finally
        {
            Environment.SetEnvironmentVariable("DESKTOP_MCP_SETTINGS_DIR", previousSettingsDir);
            try { Directory.Delete(root, true); } catch { }
        }

        Console.WriteLine("ELEVATION_DISCLOSURE_SELF_TEST=PASS");
        return 0;
    }

    private static string RedactCommand(string command)
    {
        string value = Regex.Replace(command ?? String.Empty, @"[\r\n\t]+", " ").Trim();
        value = Regex.Replace(value,
            @"(?i)(--?(?:password|passwd|pwd|token|api[-_]?key|apikey|secret|authorization))(?:\s+|=)(?:""[^""]*""|'[^']*'|[^\s]+)",
            "$1=••••");
        value = Regex.Replace(value,
            @"(?i)\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|token|api[-_]?key|apikey|secret|authorization)[A-Za-z0-9_.-]*)\s*=\s*(?:""[^""]*""|'[^']*'|[^\s]+)",
            "$1=••••");
        value = Regex.Replace(value, @"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer ••••");
        if (value.Length > 220) value = value.Substring(0, 217) + "...";
        return value;
    }

    private sealed class DisclosureForm : Form
    {
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int WS_EX_TOOLWINDOW = 0x00000080;

        internal DisclosureForm(string shell, string command)
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            Width = 470;
            Height = 166;
            BackColor = Color.FromArgb(28, 28, 30);
            ForeColor = Color.White;
            Opacity = 0.98;

            Rectangle area = Screen.FromPoint(Cursor.Position).WorkingArea;
            Location = new Point(area.Left + Math.Max(20, (area.Width - Width) / 2), area.Top + 38);

            Label title = NewLabel("Administrator permission request", 15F, FontStyle.Bold, Color.FromArgb(245, 245, 247));
            title.Location = new Point(24, 18); title.Size = new Size(410, 26);
            Controls.Add(title);

            Label target = NewLabel(shell == "powershell.exe" ? "Windows PowerShell" : "Command Prompt", 11F, FontStyle.Bold, Color.FromArgb(45, 224, 216));
            target.Location = new Point(24, 52); target.Size = new Size(410, 22);
            Controls.Add(target);

            Label detail = NewLabel(command, 9.5F, FontStyle.Regular, Color.FromArgb(205, 205, 211));
            detail.Location = new Point(24, 78); detail.Size = new Size(420, 42); detail.AutoEllipsis = true;
            Controls.Add(detail);

            Label footer = NewLabel("Opening Windows permission prompt…", 9F, FontStyle.Regular, Color.FromArgb(142, 142, 149));
            footer.Location = new Point(24, 132); footer.Size = new Size(410, 20);
            Controls.Add(footer);
        }

        protected override bool ShowWithoutActivation => true;

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            using GraphicsPath path = RoundedRectangle(ClientRectangle, 16);
            Region = new Region(path);
        }

        private static Label NewLabel(string text, float size, FontStyle style, Color color)
        {
            return new Label
            {
                Text = text,
                Font = new Font("Segoe UI", size, style, GraphicsUnit.Point),
                ForeColor = color,
                BackColor = Color.Transparent,
                AutoSize = false,
                UseMnemonic = false
            };
        }

        private static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
        {
            int diameter = radius * 2;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
