$ErrorActionPreference='Stop'
$lease=$args[0]
if(!$lease){throw 'D2 fixture lease required'}
$desktopObject='DeskMCP-Agent-'+$lease.Replace('-','')
$script=Join-Path (Get-Location) 'test-area\ego-d2-real-winforms-acceptance.ps1'
$fixture=$null
try {
  $fixture=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Sta','-ExecutionPolicy','Bypass','-File',('"'+$script+'"')) -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 4
  $native=Join-Path (Get-Location) 'runtime\ego-d2-native-control-probe.exe'
  & $native $desktopObject --act
  if($LASTEXITCODE -ne 0){throw "Native desktop UI interaction failed with exit $LASTEXITCODE"}
  & (Join-Path $env:LOCALAPPDATA 'Programs\DesktopMCP\DeskMCP.AgentDesktopHost.exe') current-desktop
  if($LASTEXITCODE -ne 0){throw 'Current desktop verification failed'}
} finally {
  if($fixture){Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue}
}
