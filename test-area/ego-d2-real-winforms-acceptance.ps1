Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class D2DesktopProbe {
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint id);
  [DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",CharSet=CharSet.Unicode)]
  public static extern bool GetUserObjectInformation(IntPtr desktop,int nIndex,StringBuilder text,int length,out int needed);
  public static string CurrentDesktop() {
    var info=new StringBuilder(512);
    int needed;
    var thread=GetCurrentThreadId();
    var desktop=GetThreadDesktop(thread);
    bool success=GetUserObjectInformation(desktop,2,info,1024,out needed);
    return "thread="+thread+";desktop="+(success?info.ToString():"<unknown>")+";handle="+desktop.ToString();
  }
}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = "DeskMCP D2 Acceptance Fixture 20261022"
$form.Width = 480
$form.Height = 330
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.TopMost = $false
$form.ShowInTaskbar = $true
$label = New-Object System.Windows.Forms.Label
$label.Name = "ResultLabel"
$label.Text = "Awaiting Agent input"
$label.Width = 400
$label.Height = 28
$label.Left = 24
$label.Top = 22
$form.Controls.Add($label)
$field = New-Object System.Windows.Forms.TextBox
$field.Name = "AgentInput"
$field.Text = ""
$field.Width = 390
$field.Left = 24
$field.Top = 65
$form.Controls.Add($field)
$button = New-Object System.Windows.Forms.Button
$button.Name = "ApplyButton"
$button.Text = "Apply Input"
$button.Width = 148
$button.Left = 24
$button.Top = 110
$button.Add_Click({
    $label.Text = "Applied: " + $field.Text
    [IO.File]::WriteAllText((Join-Path (Get-Location) "runtime\ego-d2-fixture-event.txt"),$label.Text)
})
$form.Controls.Add($button)
$items = New-Object System.Windows.Forms.ListBox
$items.Name = "AgentList"
$items.Left = 24
$items.Top = 162
$items.Width = 390
$items.Height = 94
1..45 | ForEach-Object { [void]$items.Items.Add("Item " + $_) }
$form.Controls.Add($items)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 90000
$timer.Add_Tick({$timer.Stop();$form.Close()})
$timer.Start()
$form.Add_Shown({
  $record="winformsShown=true;pid="+[System.Diagnostics.Process]::GetCurrentProcess().Id+
    ";hwnd="+$form.Handle.ToInt64()+";"+[D2DesktopProbe]::CurrentDesktop()
  [IO.File]::WriteAllText((Join-Path (Get-Location) "runtime\ego-d2-fixture-desktop.txt"),$record)
})
try {
    [void]$form.ShowDialog()
} finally {
    $result = "field=" + $field.Text + ";label=" + $label.Text + ";items=" + $items.Items.Count
    [IO.File]::WriteAllText((Join-Path (Get-Location) "runtime\ego-d2-fixture-result.txt"),$result)
    $timer.Dispose()
    $form.Dispose()
    Write-Output $result
}
