using System;
using System.IO;
using System.Text.Json;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;
using System.Windows.Interop;
using System.Windows.Threading;
using System.Windows.Input;
using System.Windows.Media;
static class Native {
 [DllImport("dwmapi.dll")] internal static extern int DwmSetWindowAttribute(IntPtr h,int a,ref int v,int len);
 [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(IntPtr h,int a,out int v,int len);
 [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
}
sealed class Probe: Window {
 readonly string ready,release,events;
 readonly DispatcherTimer timer=new() {Interval=TimeSpan.FromMilliseconds(120)};
 readonly long since=Environment.TickCount64;
 readonly IntPtr oldForeground;
 readonly IntPtr rootHwnd;
 readonly int life;
 bool uncloaked=false,popupStarted=false;
 int clicks=0;
 void Log(string msg)=>File.AppendAllText(events,DateTime.UtcNow.ToString("O")+" "+msg+"\n");
 public Probe(string readyPath,string releasePath,string eventPath,int ms){
  ready=readyPath;release=releasePath;events=eventPath;life=ms;oldForeground=Native.GetForegroundWindow();
  Title="DeskMCP Desktop2 WPF Probe";Width=550;Height=465;Left=250;Top=200;ShowActivated=false;ShowInTaskbar=true;WindowStartupLocation=WindowStartupLocation.Manual;
  var panel=new StackPanel {Margin=new Thickness(12)};
  panel.Children.Add(new TextBlock{Text="Real Desktop2 WPF native fixture"});
  var edit=new TextBox{Height=32,Margin=new Thickness(0,8,0,8)};
  AutomationProperties.SetAutomationId(edit,"WpfEdit");
  edit.TextChanged+=(_,_)=>Log("APP_EDIT="+edit.Text);
  panel.Children.Add(edit);
  var btn=new Button{Content="Activate",Height=36};
  AutomationProperties.SetAutomationId(btn,"WpfButton");
  btn.Click+=(_,_)=>Log("APP_CLICK="+(++clicks));
  btn.MouseDoubleClick+=(_,_)=>Log("APP_DOUBLE");
  panel.Children.Add(btn);
  var popup=new Button{Content="Open secondary window",Height=32};
  AutomationProperties.SetAutomationId(popup,"WpfPopup");
  popup.Click+=(_,_)=>ShowCloakedPopup();
  panel.Children.Add(popup);
  var viewer=new ScrollViewer{Height=165,VerticalScrollBarVisibility=ScrollBarVisibility.Visible};
  AutomationProperties.SetAutomationId(viewer,"WpfScroller");
  var rows=new StackPanel();
  for(int i=0;i<40;i++)rows.Children.Add(new TextBlock{Text="Row "+i,Height=24});
  viewer.Content=rows;
  viewer.ScrollChanged+=(_,_)=>Log("APP_SCROLL_CHANGED="+viewer.VerticalOffset);
  panel.Children.Add(viewer);
  var scrollBtn=new Button{Content="Scroll bottom",Height=30};
  AutomationProperties.SetAutomationId(scrollBtn,"WpfScrollButton");
  scrollBtn.Click+=(_,_)=>{viewer.ScrollToBottom();viewer.UpdateLayout();Log("APP_SCROLLED="+viewer.VerticalOffset);};
  panel.Children.Add(scrollBtn);
  Content=panel;
  PreviewMouseWheel+=(_,e)=>Log("APP_WHEEL="+e.Delta);
  PreviewMouseMove+=(_,e)=>{if(e.LeftButton==MouseButtonState.Pressed)Log("APP_DRAG");};
  rootHwnd=new WindowInteropHelper(this).EnsureHandle();
  var cloak=1;if(Native.DwmSetWindowAttribute(rootHwnd,13,ref cloak,4)!=0)throw new Exception("ROOT_CLOAK_FAILED");
  HwndSource.FromHwnd(rootHwnd).AddHook((IntPtr h,int msg,IntPtr w,IntPtr l,ref bool handled)=>{
   if(msg==0x200||msg==0x201||msg==0x202||msg==0x203||msg==0x20A||msg==0x102)Log("WM_"+msg.ToString("X"));
   return IntPtr.Zero;
  });
  Loaded+=(_,_)=> {
   Native.DwmGetWindowAttribute(rootHwnd,14,out int cloakState,4);
   File.WriteAllText(ready,JsonSerializer.Serialize(new {hwnd=rootHwnd.ToInt64(),pid=Environment.ProcessId,dwmCloaked=cloakState,initialForeground=oldForeground.ToInt64(),afterForeground=Native.GetForegroundWindow().ToInt64()}));
  };
  timer.Tick+=(_,_)=>{
   if(Environment.TickCount64-since>life){timer.Stop();Close();return;}
   if(!uncloaked&&File.Exists(release)&&File.ReadAllText(release).Trim()=="UN-CLOAK-AFTER-VERIFIED-DESKTOP2"){
    int value=0;if(Native.DwmSetWindowAttribute(rootHwnd,13,ref value,4)!=0)throw new Exception("UNCLOAK_FAILED");
    uncloaked=true;Log("UNCLOAK_SUCCESS");
   }
  };
  timer.Start();
 }
 void ShowCloakedPopup(){
  if(popupStarted)return;popupStarted=true;
  var window=new Window{Title="DeskMCP WPF test popup",Width=340,Height=170,Left=850,Top=250,ShowActivated=false,ShowInTaskbar=true,WindowStartupLocation=WindowStartupLocation.Manual,Content=new TextBlock{Text="POPUP_DESKTOP2",Margin=new Thickness(18)}};
  var hwnd=new WindowInteropHelper(window).EnsureHandle();
  int cloak=1;if(Native.DwmSetWindowAttribute(hwnd,13,ref cloak,4)!=0)throw new Exception("POPUP_CLOAK_FAILED");
  window.Show();
  Log("APP_POPUP_HWND="+hwnd.ToInt64());
 }
}
static class Program {
 [STAThread]static int Main(string[] args){
  try{
   if(args.Length!=4)throw new Exception("need ready/release/events/lifetime");
   new Application().Run(new Probe(args[0],args[1],args[2],int.Parse(args[3])));
   return 0;
  }catch(Exception e){if(args.Length>2)File.AppendAllText(args[2],"PROBE_ERROR "+e+"\n");return 2;}
 }
}