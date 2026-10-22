$ErrorActionPreference='Stop'
$lease=$args[0]
if(!$lease){throw 'Missing controlled D2 lease'}
$hostExe=Join-Path (Get-Location) 'runtime\csharp-check\candidate-host\DeskMCP.AgentDesktopHost.exe'
$before=(& $hostExe current-desktop | ConvertFrom-Json)
if($before.desktopNumber -ne 1){throw ('Expected Desktop 1 before operation, got '+$before.desktopNumber)}
$fixture=Join-Path (Get-Location) 'test-area\ego-d2-real-winforms-acceptance.ps1'
$child=$null
Remove-Item -LiteralPath (Join-Path (Get-Location) 'runtime\ego-d2-fixture-event.txt') -Force -ErrorAction SilentlyContinue
try{
  $child=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Sta','-ExecutionPolicy','Bypass','-File',('"'+$fixture+'"')) -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 3
  Write-Output ('OWNED_D2_FIXTURE_PID='+$child.Id)
  & node.exe 'test-area\ego-d2-tool-live.mjs' $lease
  $result=$LASTEXITCODE
  if($result -ne 0){throw ('Real MCP tool path failed: '+$result)}
  $after=(& $hostExe current-desktop | ConvertFrom-Json)
  if($after.desktopNumber -ne 1 -or $after.desktopId -ne $before.desktopId){throw 'Desktop 1 switched during candidate E2E'}
  Write-Output 'DESKTOP_1_CURRENT_BEFORE_AND_AFTER=PASS'
}finally{
  if($child){Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue}
}
