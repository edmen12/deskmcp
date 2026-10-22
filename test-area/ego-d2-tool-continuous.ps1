# Candidate-only real Desktop 2 test with read-only continuous virtual-desktop sampling.
# A sampled monitor cannot exclude sub-sample transitions. Never switches desktops.
$ErrorActionPreference='Stop'
$lease=$args[0]
if($lease -notmatch '^[0-9a-fA-F-]{36}$'){throw 'Expected owned D2 test lease'}
$root=(Get-Location).Path
$hostExe=Join-Path $root 'runtime\csharp-check\candidate-host\DeskMCP.AgentDesktopHost.exe'
$poller=Join-Path $root 'runtime\ego-d2-switch-monitor.exe'
$dll=Join-Path $env:LOCALAPPDATA 'Programs\DesktopMCP\virtual-desktop-accessor\VirtualDesktopAccessor.dll'
$stopFile=Join-Path $root ('runtime\ego-switch-'+$lease+'.stop')
$out=Join-Path $root ('runtime\ego-switch-'+$lease+'.stdout')
$err=Join-Path $root ('runtime\ego-switch-'+$lease+'.stderr')
$fixture=Join-Path $root 'test-area\ego-d2-real-winforms-acceptance.ps1'
$pollerProcess=$null
$fixtureProcess=$null
$completed=$false
try {
  if(!(Test-Path -LiteralPath $hostExe) -or !(Test-Path -LiteralPath $poller)){throw 'Candidate executable missing'}
  $before=& $hostExe current-desktop | ConvertFrom-Json
  if($before.desktopNumber -ne 1){throw 'User not currently on Desktop 1; abort'}
  Remove-Item -LiteralPath $stopFile,$out,$err,(Join-Path $root 'runtime\ego-d2-fixture-event.txt') -Force -ErrorAction SilentlyContinue
  $pollerProcess=Start-Process -FilePath $poller -ArgumentList @('--monitor',('"'+$dll+'"'),'30000',('"'+$stopFile+'"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  Start-Sleep -Milliseconds 400
  if($pollerProcess.HasExited){throw ('Continuous monitor did not start: '+(Get-Content $err -Raw -ErrorAction SilentlyContinue))}
  $fixtureProcess=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Sta','-ExecutionPolicy','Bypass','-File',('"'+$fixture+'"')) -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 3
  if($fixtureProcess.HasExited){throw 'Private WinForms fixture exited unexpectedly'}
  Write-Output ('TEST_FIXTURE_PID='+$fixtureProcess.Id)
  & node.exe 'test-area\ego-d2-tool-live.mjs' $lease
  if($LASTEXITCODE -ne 0){throw ('Candidate MCP tool chain failed: exit '+$LASTEXITCODE)}
  $after=& $hostExe current-desktop | ConvertFrom-Json
  if($after.desktopNumber -ne 1 -or $after.desktopId -ne $before.desktopId){throw 'Desktop 1 changed before/after'}
  Write-Output 'DESKTOP_1_IDENTITY_BEFORE_AFTER=PASS'
  $completed=$true
} finally {
  if($fixtureProcess){Stop-Process -Id $fixtureProcess.Id -Force -ErrorAction SilentlyContinue}
  if($pollerProcess){
    [IO.File]::WriteAllText($stopFile,'stop')
    if(!$pollerProcess.WaitForExit(7000)){
      Stop-Process -Id $pollerProcess.Id -Force -ErrorAction SilentlyContinue
      throw 'Continuous monitor failed to stop; result invalid'
    }
    $raw=Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue
    Write-Output $raw
    # DeskMCP ProcessHost may not expose child Process.ExitCode via Start-Process.
    # Native monitor prints its own explicit fail-closed status after sampling;
    # require a complete summary and status=PASS rather than a nullable property.
    if($raw -notmatch 'first=0 last=0 samples=(\d+) transitions=0 samples_not_desktop1=0 invalid=0 max_sample_gap_ms=(\d+) elapsed_ms=(\d+) result=PASS'){
      throw 'Continuous monitor did not produce a verified passing desktop sample summary'
    }
    if([int]$Matches[1] -lt 40 -or [int]$Matches[2] -gt 100 -or [int]$Matches[3] -lt 1500){
      throw 'Insufficient coverage or too-large sampling gap'
    }
    Write-Output 'D2_SAMPLED_CURRENT_DESKTOP_NO_SWITCH=PASS'
  }
}
if(!$completed){throw 'Candidate tool chain was incomplete'}
