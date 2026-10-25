$ErrorActionPreference='Stop'
$lease=$args[0]
if(!$lease) {throw 'Expected lease id'}
$object='DeskMCP-Agent-'+$lease.Replace('-','')
$child=$null
try {
  $fixture=(Join-Path (Get-Location) 'test-area\ego-d2-real-winforms-acceptance.ps1')
  $child=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Sta','-ExecutionPolicy','Bypass','-File',('"'+$fixture+'"')) -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 7
  Write-Output ('FIXTURE_PID='+$child.Id)
  $probe=Join-Path (Get-Location) 'runtime\ego-d2-object-window-probe.exe'
  & $probe $object
  if($LASTEXITCODE -ne 0){throw 'Win32 desktop enumeration probe failed'}
  $control=Join-Path (Get-Location) 'runtime\ego-d2-win32-control-probe.exe'
  & $control '--exercise' $object
  if($LASTEXITCODE -ne 0){throw 'Private Win32 background control interaction failed'}
  $hostPath=Join-Path $env:LOCALAPPDATA 'Programs\DesktopMCP\DeskMCP.AgentDesktopHost.exe'
  & $hostPath current-desktop
} finally {
  if($child){Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue}
}
