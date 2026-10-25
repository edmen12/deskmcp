param([string]$OutputFile,[int]$Seconds=90,[string]$ReadyFile)
$ErrorActionPreference='Stop'
$cs=@'
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class D2FocusWatch {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr LoadLibraryW(string dll);
 [DllImport("kernel32.dll",CharSet=CharSet.Ansi,SetLastError=true)]static extern IntPtr GetProcAddress(IntPtr dll,string name);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)]delegate int CurrentDesk();
 static string Observation(int desk,long ms){
  var hwnd=GetForegroundWindow();uint pid;GetWindowThreadProcessId(hwnd,out pid);
  return DateTime.UtcNow.ToString("O")+" uptimeMs="+ms+" desktopIndex="+desk+" foregroundPid="+pid+" hwnd="+hwnd.ToString("X");
 }
 public static void Run(string library,string output,string ready,int seconds){
  var h=LoadLibraryW(library);if(h==IntPtr.Zero)throw new Exception("VDA DLL load failed");
  var p=GetProcAddress(h,"GetCurrentDesktopNumber");if(p==IntPtr.Zero)throw new Exception("missing VDA method");
  var get=(CurrentDesk)Marshal.GetDelegateForFunctionPointer(p,typeof(CurrentDesk));
  var watch=Stopwatch.StartNew();int old=get(),changes=0;long lastTick=0;
  using(var log=new StreamWriter(output,false)){
   log.AutoFlush=true;log.WriteLine("START "+Observation(old,watch.ElapsedMilliseconds)+" intervalMs=20");
   File.WriteAllText(ready,"READY");
   while(watch.ElapsedMilliseconds<seconds*1000L){
    var desk=get();var now=watch.ElapsedMilliseconds;
    if(desk!=old){changes++;log.WriteLine("DESKTOP_SWITCH "+Observation(desk,now)+" from="+old);old=desk;}
    if(now-lastTick>500){log.WriteLine("HEARTBEAT "+Observation(desk,now));lastTick=now;}
    Thread.Sleep(20);
   }
   log.WriteLine("END "+Observation(get(),watch.ElapsedMilliseconds)+" transitions="+changes);
  }
 }
}
'@
Add-Type -TypeDefinition $cs
$path='C:\Users\User\Desktop\DeskMCP\runtime\agent-desktop-runtime\win-x64\virtual-desktop-accessor\VirtualDesktopAccessor.dll'
[D2FocusWatch]::Run($path,$OutputFile,$ReadyFile,$Seconds)
