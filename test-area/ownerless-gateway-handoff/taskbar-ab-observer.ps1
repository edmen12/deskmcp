param([ValidateRange(25,120)][int]$DurationSeconds=90)
$ErrorActionPreference='Stop'
$testRoot='C:\Users\User\Desktop\DeskMCP-ComputerUse-Core-20261023\test-area\ownerless-gateway-handoff\data'
if(!(Test-Path -LiteralPath $testRoot)){throw 'PRIVATE_TEST_ROOT_MISSING'}
$ready=Join-Path $testRoot 'taskbar-ab-ready.json'
$output=Join-Path $testRoot 'taskbar-ab-result.json'
$traceFile=Join-Path $testRoot 'taskbar-ab-trace.json'
Add-Type -AssemblyName System.Drawing
$code=@'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public static class PrivateTaskbarAB {
 [StructLayout(LayoutKind.Sequential)]
 public struct RECT { public int L,T,R,B; }
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]
 public static extern IntPtr FindWindow(string cls,string title);
 [DllImport("user32.dll")]
 public static extern bool GetWindowRect(IntPtr hwnd,out RECT r);
 [DllImport("user32.dll")]
 public static extern bool EnumWindows(EnumProc callback,IntPtr state);
 public delegate bool EnumProc(IntPtr hwnd,IntPtr state);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]
 public static extern int GetWindowText(IntPtr hwnd,StringBuilder name,int cap);
 [DllImport("user32.dll")]
 public static extern bool IsWindowVisible(IntPtr hwnd);
 public static int CountOwnedHudWindows() {
   int found=0;
   EnumWindows((hwnd,other)=>{
     var title=new StringBuilder(220);
     GetWindowText(hwnd,title,title.Capacity);
     string name=title.ToString();
     if(name=="DeskMCP Agent Desktop Edge" || name=="DeskMCP Agent Desktop Control") found++;
     return true;
   },IntPtr.Zero);
   return found;
 }
 public static byte[] CenterPixels() {
   var shell=FindWindow("Shell_TrayWnd",null);
   if(shell==IntPtr.Zero)throw new InvalidOperationException("TASKBAR_HWND_NOT_FOUND");
   RECT r;
   if(!GetWindowRect(shell,out r))throw new InvalidOperationException("TASKBAR_GEOMETRY_ERROR");
   int full=r.R-r.L, height=r.B-r.T;
   if(full<800 || full>8000 || height<25 || height>95)throw new InvalidOperationException("TASKBAR_BOUNDS_INVALID");
   int width=Math.Min(1200,full), x=r.L+(full-width)/2;
   using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
     using(var g=Graphics.FromImage(bitmap)){
        g.CopyFromScreen(x,r.T,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);
     }
     BitmapData raw=bitmap.LockBits(new Rectangle(0,0,width,height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
     try{
       var bytes=new byte[raw.Stride*height];
       Marshal.Copy(raw.Scan0,bytes,0,bytes.Length);
       return bytes;
     } finally {bitmap.UnlockBits(raw);}
   }
 }
 public static int ChangedPixels(byte[] current,byte[] reference,int threshold) {
    if(current.Length!=reference.Length)throw new InvalidOperationException("TASKBAR_DIMENSION_DRIFT");
    int diff=0;
    for(int i=0;i<current.Length;i+=4)
      if(Math.Max(Math.Abs(current[i]-reference[i]),Math.Max(Math.Abs(current[i+1]-reference[i+1]),Math.Abs(current[i+2]-reference[i+2])))>=threshold)diff++;
    return diff;
 }
 public static int[] ChangedByZone(byte[] a,byte[] b,int zones) {
    if(a.Length!=b.Length)throw new InvalidOperationException("TASKBAR_DIMENSION_DRIFT");
    // Center region has 1200 pixels, each row exactly 4800 bytes (32 bpp)
    // Confirm stride implicitly from rectangle geometry.
    int row=4800;
    if(a.Length%row!=0) throw new InvalidOperationException("TASKBAR_STRIDE_UNEXPECTED");
    var count=new int[zones];
    for(int i=0;i<a.Length;i+=4) {
      if(Math.Max(Math.Abs(a[i]-b[i]),Math.Max(Math.Abs(a[i+1]-b[i+1]),Math.Abs(a[i+2]-b[i+2])))<35)continue;
      int zone=(i%row)/4*zones/1200;
      count[zone]++;
    }
    return count;
 }
}
'@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing
Remove-Item $ready,$traceFile -Force -ErrorAction SilentlyContinue
# Warm-up uses the actual observer capture path and does not count as a control sample.
$warm=New-Object 'System.Collections.Generic.List[byte[]]'
for($i=0;$i -lt 12;$i++){ $warm.Add([PrivateTaskbarAB]::CenterPixels()); Start-Sleep -Milliseconds 220 }
# Select a representative *medoid* baseline rather than the first screenshot.
$score=[long]::MaxValue; $reference=$null
foreach($x in $warm){
  $dist=[long]0
  foreach($y in $warm){$dist += [PrivateTaskbarAB]::ChangedPixels($x,$y,35)}
  if($dist -lt $score){$score=$dist;$reference=$x}
}
$trace=New-Object 'System.Collections.Generic.List[object]'
$watch=[Diagnostics.Stopwatch]::StartNew()
$readyWritten=$false
$seen=0
$prev=$reference
while($watch.Elapsed.TotalSeconds -lt $DurationSeconds){
   $count=[PrivateTaskbarAB]::CountOwnedHudWindows()
   $frame=[PrivateTaskbarAB]::CenterPixels()
   $fromReference=[PrivateTaskbarAB]::ChangedPixels($frame,$reference,35)
   $delta=[PrivateTaskbarAB]::ChangedPixels($frame,$prev,35)
   $zones=[PrivateTaskbarAB]::ChangedByZone($frame,$reference,12)
   $badCapture=$delta -gt 48000
   $trace.Add([pscustomobject]@{ms=[int]$watch.ElapsedMilliseconds;targetHwnds=$count;difference=$fromReference;frameDelta=$delta;captureJump=$badCapture;zones=$zones})
   if($count -ge 2){$seen++}
   if($watch.Elapsed.TotalSeconds -ge 10 -and -not $readyWritten){
     if($seen -gt 0) {throw 'OBSERVER_STARTED_DURING_HUD_TEST'}
     $pre=@($trace|Where-Object {$_.targetHwnds -eq 0})
     '{"ready":true,"preHudSamples":'+$pre.Count+',"baselineAlgorithm":"medoid12"}' | Set-Content -LiteralPath $ready -NoNewline
     $readyWritten=$true
   }
   $prev=$frame
   Start-Sleep -Milliseconds 250
}
function GetStats($group) {
  $a=@($group)
  if($a.Count -eq 0){return @{n=0;mean=0;max=0;deltaMax=0;largeJumps=0}}
  $stats=$a|Measure-Object difference -Average -Maximum
  $delta=$a|Measure-Object frameDelta -Maximum
  return @{n=$a.Count;mean=[math]::Round($stats.Average,1);max=[int]$stats.Maximum;deltaMax=[int]$delta.Maximum;largeJumps=@($a|Where-Object captureJump).Count}
}
$firstHud=($trace|Where-Object targetHwnds -ge 2|Select-Object -First 1)
$lastHud=($trace|Where-Object targetHwnds -ge 2|Select-Object -Last 1)
$before=@($trace|Where-Object {$_.targetHwnds -eq 0 -and (!$firstHud -or $_.ms -lt $firstHud.ms)})
$active=@($trace|Where-Object targetHwnds -ge 2)
$after=@($trace|Where-Object {$_.targetHwnds -eq 0 -and $lastHud -and $_.ms -gt $lastHud.ms})
$outputValue=[ordered]@{
  status=if($active.Count -ge 90){'STATISTICALLY_RELEVANT_WINDOWS_OBSERVED'}else{'INSUFFICIENT_HUD_SAMPLES'}
  privateOnly=$true; imagesSaved=0; imageBuffersExported=$false
  warmupFrames=$warm.Count; medoidDifferenceSum=$score
  durationSeconds=$DurationSeconds
  pre=(GetStats $before); active=(GetStats $active); post=(GetStats $after)
  firstHud=$firstHud;lastHud=$lastHud
  envChangedWithoutHud=(@($before|Where-Object {$_.difference -gt 2000}).Count -gt 0)
}
$outputValue|ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $output
$trace|ConvertTo-Json -Depth 5 |Set-Content -LiteralPath $traceFile
Remove-Item $ready -ErrorAction SilentlyContinue
Write-Output ('TASKBAR_AB='+($outputValue|ConvertTo-Json -Depth 7 -Compress))
