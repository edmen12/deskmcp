using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;

internal static class Native
{
  [DllImport("dwmapi.dll")] internal static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
  [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] internal static extern bool GetCursorPos(out Point point);
}

internal sealed class ProbeForm : Form
{
  private const int DwmCloak=13;
  private const int DwmCloaked=14;
  private readonly string ready;
  private readonly string release;
  private readonly string eventsFile;
  private readonly long started=Environment.TickCount64;
  private readonly System.Windows.Forms.Timer timer=new() { Interval=125 };
  private readonly int lifetimeMs;
  private bool released=false;
  private int clicks=0;
  private int down=0;
  private int wheel=0;
  private string typed="";
  private readonly Button testButton;
  private readonly TextBox testTextbox;
  private readonly IntPtr initialForeground;
  private readonly Point initialCursor;

  public ProbeForm(string readyPath, string releasePath, string eventsPath, int lifetime)
  {
    ready=readyPath; release=releasePath; eventsFile=eventsPath; lifetimeMs=lifetime;
    initialForeground=Native.GetForegroundWindow();
    Native.GetCursorPos(out initialCursor);
    Text="DeskMCP Desktop 2 private WinForms input test";
    ShowInTaskbar=true; StartPosition=FormStartPosition.Manual; Location=new Point(200,175);
    Size=new Size(450,260);
    BackColor=Color.AliceBlue;
    Controls.Add(new Label{ Text="Agent Desktop 2 only", Bounds=new Rectangle(20,10,200,30)});
    testButton = new Button{ Text="AGENT_CLICK", Bounds=new Rectangle(30,65,170,38), TabStop=false };
    testButton.Click += (_,_) => Log("APP_BUTTON_CLICK");
    testButton.MouseDown += (_,e) => Log("APP_BUTTON_DOWN "+e.Button);
    testButton.MouseUp += (_,e) => Log("APP_BUTTON_UP "+e.Button);
    Controls.Add(testButton);
    testTextbox = new TextBox{ Bounds=new Rectangle(30,120,250,32), Text="" };
    testTextbox.TextChanged += (_,_) => Log("APP_TEXTBOX_CHANGED "+testTextbox.Text);
    testTextbox.KeyPress += (_,e) => Log("APP_TEXTBOX_KEYPRESS "+e.KeyChar);
    Controls.Add(testTextbox);
    // NOACTIVATE; no SetForegroundWindow and no mouse capture.
    // Cloak window *before* Show(); otherwise Desktop 1 could flash.
    int cloak=1;
    int status=Native.DwmSetWindowAttribute(Handle,DwmCloak,ref cloak,sizeof(int));
    if(status!=0) throw new InvalidOperationException("DWM_CLOAK_FAILED: "+status);
    Native.DwmGetWindowAttribute(Handle,DwmCloaked,out int cloaked,sizeof(int));
    if(cloaked==0) throw new InvalidOperationException("DWM_NOT_CLOAKED");
    Shown += (_,_)=> SaveReady();
    timer.Tick += (_,_)=> TickProbe();
    timer.Start();
  }

  protected override bool ShowWithoutActivation => true;
  protected override CreateParams CreateParams {
    get { CreateParams p=base.CreateParams; p.ExStyle |= 0x08000000; return p; }
  }
  private void Log(string text) {
    File.AppendAllText(eventsFile,DateTime.UtcNow.ToString("O")+" "+text+"\n");
  }
  private void SaveReady() {
    Native.DwmGetWindowAttribute(Handle,DwmCloaked,out int cloak,sizeof(int));
    Native.GetCursorPos(out Point cursor);
    File.WriteAllText(ready,JsonSerializer.Serialize(new {
      hwnd=Handle.ToInt64(),
      buttonHwnd=testButton.Handle.ToInt64(),
      textboxHwnd=testTextbox.Handle.ToInt64(),
      pid=Environment.ProcessId,
      dwmCloaked=cloak,
      showInTaskbar=ShowInTaskbar,
      noActivate=true,
      initialForeground=initialForeground.ToInt64(),
      afterForeground=Native.GetForegroundWindow().ToInt64(),
      initialCursorX=initialCursor.X,initialCursorY=initialCursor.Y,
      afterCursorX=cursor.X,afterCursorY=cursor.Y,
      stage="CLOAKED_AND_SHOWN"
    }));
  }
  private void TickProbe() {
    if(Environment.TickCount64-started>lifetimeMs) {timer.Stop(); Close();return;}
    if(!released && File.Exists(release)) {
      var cmd=File.ReadAllText(release).Trim();
      if(cmd=="UN-CLOAK-AFTER-VERIFIED-DESKTOP2") {
        int cloak=0;
        int status=Native.DwmSetWindowAttribute(Handle,DwmCloak,ref cloak,sizeof(int));
        if(status!=0) {Log("UNCLOAK_FAILED "+status);Close();return;}
        released=true; Log("UNCLOAK_SUCCESS");
      }
    }
  }
  protected override void WndProc(ref Message m) {
    int msg=m.Msg;
    if (msg==0x200 || msg==0x201 || msg==0x202 || msg==0x203
      || msg==0x204 || msg==0x205 || msg==0x20A || msg==0x100
      || msg==0x101 || msg==0x102) {
       if(eventsFile!=null) Log("WM_"+msg.ToString("X")+" W="+m.WParam.ToInt64()+" L="+m.LParam.ToInt64());
    }
    base.WndProc(ref m);
  }
  protected override void OnMouseDown(MouseEventArgs e) {
    down++; Log("APP_MOUSEDOWN "+e.Button+" "+down); base.OnMouseDown(e);
  }
  protected override void OnMouseUp(MouseEventArgs e) {
    Log("APP_MOUSEUP "+e.Button); base.OnMouseUp(e);
  }
  protected override void OnMouseMove(MouseEventArgs e) {
    if(e.Button != MouseButtons.None) Log("APP_DRAG_MOVE "+e.X+" "+e.Y+" "+e.Button);
    base.OnMouseMove(e);
  }
  protected override void OnMouseDoubleClick(MouseEventArgs e) {
    Log("APP_DOUBLECLICK "+e.Button); base.OnMouseDoubleClick(e);
  }
  protected override void OnMouseClick(MouseEventArgs e) {
    clicks++; Log("APP_MOUSECLICK "+e.Button+" "+clicks); base.OnMouseClick(e);
  }
  protected override void OnMouseWheel(MouseEventArgs e) {
    wheel+=e.Delta; Log("APP_WHEEL "+wheel); base.OnMouseWheel(e);
  }
  protected override void OnKeyPress(KeyPressEventArgs e) {
    typed+=e.KeyChar; Log("APP_KEYPRESS "+typed); base.OnKeyPress(e);
  }
}

internal static class Program {
  [STAThread] private static int Main(string[] args) {
    try {
      if(args.Length!=4) throw new ArgumentException("ready release events lifetime_ms required");
      int limit=int.Parse(args[3]);
      if(limit<10000||limit>180000) throw new ArgumentOutOfRangeException("lifetime_ms");
      Application.SetHighDpiMode(HighDpiMode.SystemAware);
      Application.EnableVisualStyles();
      Application.Run(new ProbeForm(args[0],args[1],args[2],limit));
      return 0;
    } catch(Exception ex) {
      if(args.Length>2) File.AppendAllText(args[2],"PROBE_ERROR "+ex+"\n");
      return 2;
    }
  }
}
