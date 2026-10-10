using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Test-owned WinForms fixture only; non-activating from CreateParams, DWM
// cloaked before first Show. No global keyboard, mouse or clipboard calls.
internal static class Native
{
    [DllImport("dwmapi.dll")] internal static extern int DwmSetWindowAttribute(IntPtr hwnd,int attribute,ref int value,int length);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out int value,int length);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] internal static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="GetClassNameW")]
    internal static extern int GetClassName(IntPtr hwnd,StringBuilder output,int capacity);
}

internal sealed class EditFixture:Form
{
    private readonly string ready,release,events;
    private readonly long began=Environment.TickCount64;
    private readonly int lifetime;
    private readonly IntPtr originalForeground;
    private readonly TextBox edit;
    private readonly ListBox list;
    private int lastListTop;
    private readonly System.Windows.Forms.Timer timer=new(){Interval=110};
    private bool uncloaked;
    private int edits;
    private readonly IntPtr root;
    private void Log(string entry)=>File.AppendAllText(events,
        DateTime.UtcNow.ToString("O")+" "+entry+"\n");

    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams {
        get {
            CreateParams p=base.CreateParams;
            p.ExStyle |= unchecked((int)0x08000000); // WS_EX_NOACTIVATE before HWND creation
            return p;
        }
    }
    protected override void WndProc(ref Message message)
    {
        if(message.Msg is 0x06 or 0x07 or 0x08 or 0x1c or 0x0100 or 0x0101 or 0x0102
            or 0x0200 or 0x0201 or 0x0202 or 0x0203 or 0x0204 or 0x0205 or 0x020A)
            Log("ROOT_WM_"+message.Msg.ToString("X")+" W="+message.WParam.ToInt64());
        base.WndProc(ref message);
    }

    private sealed class TracedEdit:TextBox
    {
        private readonly Action<string> log;
        public TracedEdit(Action<string> logger){log=logger;}
        protected override void WndProc(ref Message msg) {
            if(msg.Msg is 0x06 or 0x07 or 0x08 or 0x0100 or 0x0101 or 0x0102)
                log("EDIT_WM_"+msg.Msg.ToString("X")+" W="+msg.WParam.ToInt64());
            base.WndProc(ref msg);
        }
    }
    private sealed class TracedButton:Button
    {
        private readonly Action<string> log;
        public TracedButton(Action<string> logger){log=logger;}
        protected override void WndProc(ref Message msg) {
            if(msg.Msg is 0x06 or 0x07 or 0x08 or 0x0100 or 0x0101 or 0x0102
               or 0x0201 or 0x0202 or 0x00F5)
                log("BUTTON_WM_"+msg.Msg.ToString("X")+" W="+msg.WParam.ToInt64());
            base.WndProc(ref msg);
        }
    }
    public EditFixture(string readyPath,string releasePath,string eventPath,int lifetimeMs)
    {
        ready=readyPath;release=releasePath;events=eventPath;lifetime=lifetimeMs;
        originalForeground=Native.GetForegroundWindow();
        Text="DeskMCP D2 Native WinForms Edit Fixture";Name="DeskMCPD2OwnedNativeEdit";
        Width=465;Height=450;StartPosition=FormStartPosition.Manual;
        Left=400;Top=250;ShowInTaskbar=true;TopMost=false;
        FormBorderStyle=FormBorderStyle.FixedSingle;MaximizeBox=false;
        edit=new TracedEdit(Log) {
            Name="OwnedSingleLineEdit",Multiline=false,ReadOnly=false,
            UseSystemPasswordChar=false,Text="",Left=22,Top=35,Width=400,Height=30
        };
        edit.TextChanged+=(_,_)=>Log("APP_EDIT="+(++edits)+":"+edit.Text);
        Controls.Add(edit);
        var hint=new Label{Text="Owned WinForms single-line Edit control",Left=22,Top=80,Width=400};
        Controls.Add(hint);
        var button=new TracedButton(Log) {
            Name="OwnedNativePushButton",Text="Test action",Left=22,Top=125,Width=185,Height=38,
            UseVisualStyleBackColor=false,FlatStyle=FlatStyle.System
        };
        int clickCount=0;
        button.Click+=(_,_)=>Log("APP_BUTTON_CLICK="+(++clickCount));
        Controls.Add(button);
        list=new ListBox {Name="OwnedScrollableList",Left=22,Top=205,
            Width=400,Height=128,IntegralHeight=false,SelectionMode=SelectionMode.One,
            DrawMode=DrawMode.Normal};
        for(int i=0;i<80;i++)list.Items.Add("Test list item "+i.ToString("D3"));
        Controls.Add(list);
        lastListTop=list.TopIndex;
        root=Handle;
        IntPtr child=edit.Handle;
        IntPtr buttonHandle=button.Handle;
        IntPtr listHandle=list.Handle;
        var rootStyle=Native.GetWindowLongPtr(root,-20).ToInt64();
        if((rootStyle & 0x08000000L)==0)throw new Exception("PROTECTED_NOACTIVATE_STYLE_MISSING");
        int cloak=1;
        if(Native.DwmSetWindowAttribute(root,13,ref cloak,4)!=0)
            throw new Exception("ROOT_DWM_CLOAK_FAILED");
        Shown+=(_,_)=>{
            Native.DwmGetWindowAttribute(root,14,out int state,4);
            StringBuilder klass=new(256);
            Native.GetClassName(child,klass,klass.Capacity);
            StringBuilder buttonClass=new(256);
            Native.GetClassName(buttonHandle,buttonClass,buttonClass.Capacity);
            StringBuilder listClass=new(256);
            Native.GetClassName(listHandle,listClass,listClass.Capacity);
            File.WriteAllText(ready,JsonSerializer.Serialize(new {
                hwnd=root.ToInt64(),pid=Environment.ProcessId,childHwnd=child.ToInt64(),
                childClass=klass.ToString(),buttonHwnd=buttonHandle.ToInt64(),
                buttonClass=buttonClass.ToString(),
                buttonStyle=Native.GetWindowLongPtr(buttonHandle,-16).ToInt64(),
                listHwnd=listHandle.ToInt64(),listClass=listClass.ToString(),
                listStyle=Native.GetWindowLongPtr(listHandle,-16).ToInt64(),
                listCount=list.Items.Count,listTop=list.TopIndex,
                dwmCloaked=state,rootNoActivate=true,
                initialForeground=originalForeground.ToInt64(),
                afterForeground=Native.GetForegroundWindow().ToInt64()
            }));
            Log("APP_SHOWN_FOREGROUND="+Native.GetForegroundWindow().ToInt64());
        };
        timer.Tick+=(_,_)=>{
            if(list.TopIndex!=lastListTop){lastListTop=list.TopIndex;Log("APP_LIST_TOP="+lastListTop);}
            if(Environment.TickCount64-began>lifetime){timer.Stop();Close();return;}
            if(!uncloaked && File.Exists(release) &&
                File.ReadAllText(release).Trim()=="UN-CLOAK-AFTER-VERIFIED-DESKTOP2") {
                int value=0;
                if(Native.DwmSetWindowAttribute(root,13,ref value,4)!=0)
                    throw new Exception("ROOT_UNCLOAK_FAILED");
                uncloaked=true;Log("UNCLOAK_SUCCESS");
            }
        };
        timer.Start();
    }
}
internal static class Program
{
    [STAThread] public static int Main(string[] args)
    {
        try{
            if(args.Length!=4)throw new Exception("ready release events lifetime required");
            Application.SetHighDpiMode(HighDpiMode.SystemAware);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new EditFixture(args[0],args[1],args[2],int.Parse(args[3])));
            return 0;
        }catch(Exception ex){
            if(args.Length>=3)File.AppendAllText(args[2],"FIXTURE_ERROR "+ex+"\n");
            return 2;
        }
    }
}
