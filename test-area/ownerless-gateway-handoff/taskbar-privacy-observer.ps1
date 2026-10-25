param(
    [ValidateRange(10,110)][int]$DurationSeconds=80
)
$ErrorActionPreference='Stop'
$testRoot = 'C:\Users\User\Desktop\DeskMCP-ComputerUse-Core-20261023\test-area\ownerless-gateway-handoff\data'
if (!(Test-Path -LiteralPath $testRoot)) {throw 'PRIVATE_ROOT_REQUIRED'}
$ready = Join-Path $testRoot 'taskbar-observer-ready.json'
$output = Join-Path $testRoot 'taskbar-observer-result.json'
Add-Type -AssemblyName System.Drawing
$native = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class TaskbarPrivatePixels {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {public int Left,Top,Right,Bottom;}
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]
  public static extern IntPtr FindWindow(string cls,string title);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="GetWindowTextW")]
  public static extern int GetWindowText(IntPtr hwnd,System.Text.StringBuilder sb,int cap);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(Callback callback,IntPtr state);
  public delegate bool Callback(IntPtr hwnd,IntPtr state);
  public static int TargetVisibleWindows() {
    int count=0;
    EnumWindows((h,state)=>{
       var sb=new System.Text.StringBuilder(200);
       GetWindowText(h,sb,sb.Capacity);
       string name=sb.ToString();
       if (name=="DeskMCP Agent Desktop Control" || name=="DeskMCP Agent Desktop Edge") count++;
       return true;
    },IntPtr.Zero);
    return count;
  }
  public static byte[] GrabOnlyCenterTaskbar() {
     var handle=FindWindow("Shell_TrayWnd",null);
     if(handle==IntPtr.Zero)throw new InvalidOperationException("TASKBAR_MISSING");
     RECT r;
     if(!GetWindowRect(handle,out r))throw new InvalidOperationException("TASKBAR_RECT_UNRESOLVED");
     int w=r.Right-r.Left, h=r.Bottom-r.Top;
     if(w<800 || w>8000 || h<25 || h>95)
       throw new InvalidOperationException("TASKBAR_GEOMETRY_UNEXPECTED");
     int central=Math.Min(1200,w);
     int x=r.Left+(w-central)/2;
     using(Bitmap bitmap=new Bitmap(central,h,PixelFormat.Format32bppArgb)) {
       using(Graphics g=Graphics.FromImage(bitmap)) {
          g.CopyFromScreen(x,r.Top,0,0,new Size(central,h),CopyPixelOperation.SourceCopy);
       }
       BitmapData data=bitmap.LockBits(new Rectangle(0,0,central,h),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
       try {
          byte[] buffer=new byte[data.Stride*h];
          Marshal.Copy(data.Scan0,buffer,0,buffer.Length);
          return buffer;
       } finally { bitmap.UnlockBits(data); }
     }
  }
  public static int DifferentPixels(byte[] a,byte[] b,int threshold=35) {
     if(a.Length!=b.Length)throw new InvalidOperationException("REGION_DIMENSIONS_CHANGED");
     int changes=0;
     for(int i=0;i<a.Length;i+=4) {
        int d0=Math.Abs(a[i]-b[i]),d1=Math.Abs(a[i+1]-b[i+1]),d2=Math.Abs(a[i+2]-b[i+2]);
        if(Math.Max(d0,Math.Max(d1,d2))>=threshold)changes++;
     }
     return changes;
  }
}
'@
Add-Type -TypeDefinition $native -ReferencedAssemblies System.Drawing
if(Test-Path $ready){Remove-Item $ready -Force}
$sample0=[TaskbarPrivatePixels]::GrabOnlyCenterTaskbar()
$baseline=@();$active=@();$noWindow=@();$trace=New-Object 'System.Collections.Generic.List[object]'
$sw=[Diagnostics.Stopwatch]::StartNew()
while($sw.Elapsed.TotalSeconds -lt $DurationSeconds) {
    $count=[TaskbarPrivatePixels]::TargetVisibleWindows()
    $current=[TaskbarPrivatePixels]::GrabOnlyCenterTaskbar()
    $diff=[TaskbarPrivatePixels]::DifferentPixels($sample0,$current)
    $trace.Add([pscustomobject]@{ms=[int]$sw.ElapsedMilliseconds;hudHwndCount=$count;changedPixels=$diff})
    if($sw.Elapsed.TotalSeconds -lt 4){$baseline+= $diff}
    elseif($count -ge 2){$active+= $diff}
    else {$noWindow+= $diff}
    if($sw.Elapsed.TotalSeconds -ge 4 -and -not (Test-Path $ready)){
       ('{"ready":true,"baselineSamples":'+$baseline.Count+'}') | Set-Content -LiteralPath $ready -NoNewline
    }
    Start-Sleep -Milliseconds 300
}
function Summary($a) {
 if(!$a -or $a.Count -eq 0){return @{samples=0;max=0;mean=0;min=0}}
 $s=$a|Measure-Object -Sum -Average -Maximum -Minimum
 return @{samples=$s.Count;max=[int]$s.Maximum;mean=[math]::Round($s.Average,1);min=[int]$s.Minimum}
}
# Never write, return, or retain bitmap/pixel data outside this process.
$r=[ordered]@{
 mode='READ_ONLY_TASKBAR_CENTER_PIXEL_STATS'
 region='Shell_TrayWnd middle 1200px; no image output'
 windowFilter='exact DeskMCP safety HUD and Edge title'
 durationSeconds=$DurationSeconds
 baseline=(Summary $baseline)
 targetVisibleWindows=(Summary $active)
 withoutTargetWindows=(Summary $noWindow)
 maxTargetWindowCount=2
 confirmedTargetSamples=$active.Count
 screenshotsSaved=0
 foregroundChangedByObserver=$false
 firstNonZero=($trace|Where-Object changedPixels -gt 0|Select-Object -First 1)
 firstTarget=($trace|Where-Object hudHwndCount -ge 2|Select-Object -First 1)
 lastTarget=($trace|Where-Object hudHwndCount -ge 2|Select-Object -Last 1)
}
$r|ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $output
$trace | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $testRoot 'taskbar-observer-trace.json')
Remove-Item $ready -ErrorAction SilentlyContinue
Write-Output ('TASKBAR_STATS='+($r|ConvertTo-Json -Depth 5 -Compress))
