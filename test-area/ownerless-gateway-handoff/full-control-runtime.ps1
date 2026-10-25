$ErrorActionPreference='Stop'
$project='C:\Users\User\Desktop\DeskMCP-ComputerUse-Core-20261023'
$testRoot=Join-Path $project 'test-area\ownerless-gateway-handoff\data'
$installedData='C:\Users\User\AppData\Local\DesktopMCP\agent-desktop\control.json'
$installedGui='C:\Users\User\AppData\Local\Programs\DesktopMCP\DeskMCP.exe'
$nativeHost='C:\Users\User\AppData\Local\Programs\DesktopMCP\DeskMCP.ProcessHost.exe'
$agentHost='C:\Users\User\AppData\Local\Programs\DesktopMCP\DeskMCP.AgentDesktopHost.exe'
$vda='C:\Users\User\AppData\Local\Programs\DesktopMCP\virtual-desktop-accessor\VirtualDesktopAccessor.dll'
$probe=Join-Path $project 'control-panel\wpf\bin\Release\net10.0-windows\win-x64\DeskMCP.exe'
$port=59123
$gateway=$null
$controlPanel=$null
$baselineHash=$null
$result=[ordered]@{
 status='NOT_STARTED';error='';fullRuntimeReady=$false
 gatewayBoundLoopback=$false;fullControlPolicy=$false;separateDataRoot=$true
 independentAudit=$false;wpfRealCoordinatorStarted=$false
 mcpHudExitVerified=$false;wpfExitedCleanly=$false
 gatewayExitedCleanly=$false;productionControlUnchanged=$false
 installedControlPanelUnchanged=$false;testPortReleased=$false
 privateControlsCleared=$false
}
try{
 if(!(Test-Path -LiteralPath $installedData)){throw 'PRODUCTION_CONTROL_FILE_MISSING'}
 $baselineHash=(Get-FileHash -LiteralPath $installedData -Algorithm SHA256).Hash
 $productionGuiPid=@(Get-CimInstance Win32_Process -Filter "name='DeskMCP.exe'" | Where-Object {$_.ExecutablePath -ieq $installedGui} | Select-Object -ExpandProperty ProcessId)
 if($productionGuiPid.Count -ne 1){throw 'PRODUCTION_GUI_PID_PRECHECK_FAILED'}
 foreach($item in @($testRoot,$nativeHost,$agentHost,$vda,$probe)){
  if(!(Test-Path -LiteralPath $item)){throw ('TEST_ASSET_MISSING_'+$item)}
 }
 if(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue){throw 'ISOLATED_PORT_OCCUPIED'}
 $control=Join-Path $testRoot 'agent-desktop\control.json'
 if(Test-Path -LiteralPath $control){
  $state=Get-Content -LiteralPath $control -Raw|ConvertFrom-Json
  if(@($state.controls).Count -ne 0){throw 'ISOLATED_TEST_LEASE_NOT_CLEAR'}
 }
 $env:DESKTOP_MCP_DATA_ROOT=$testRoot
 $env:DESKTOP_MCP_PROFILE='full-control'
 $env:DESKTOP_MCP_ALLOWED_ROOTS=$testRoot
 $env:DESKTOP_MCP_DISABLE_TUNNEL='1'
 $env:DESKTOP_MCP_PORT=[string]$port
 $env:DESKTOP_MCP_INSTANCE_NAMESPACE='ownerless-handoff-20261024'
 $env:DESKTOP_MCP_PROCESS_HOST=$nativeHost
 $env:DESKTOP_MCP_AGENT_DESKTOP_HOST_PATH=$agentHost
 $env:DESKTOP_MCP_VDA_PATH=$vda
 $env:DESKTOP_MCP_AGENT_DESKTOP_OWNERLESS_SAFETY_WINDOWS_EXPERIMENT='1'
 $env:DESKTOP_MCP_AUDIT_LOG=Join-Path $testRoot 'full-control-runtime-audit.jsonl'
 $env:DESKTOP_MCP_SETTINGS_DIR=Join-Path $testRoot 'full-control-settings'
 $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH=Join-Path $testRoot 'candidate-no-tunnel.yaml'
 $env:DESKTOP_MCP_STARTUP_LINK_PATH=Join-Path $testRoot 'candidate-no-startup.lnk'
 $node=(Get-Command node.exe -ErrorAction Stop).Source
 $stdout=Join-Path $testRoot 'full-control-gateway.stdout.log'
 $stderr=Join-Path $testRoot 'full-control-gateway.stderr.log'
 $controlPanel=Start-Process -FilePath $probe -ArgumentList @('--agent-desktop-manager-handoff-isolated-probe','100','OWN_HUD_UIA_EXIT') -WindowStyle Hidden -PassThru
 $readyPath=Join-Path $testRoot 'coordinator-ready.json'
 $ready=$false
 for($i=0;$i -lt 45;$i++){
  Start-Sleep -Milliseconds 250
  if($controlPanel.HasExited){throw ('ISOLATED_WPF_EARLY_EXIT_'+$controlPanel.ExitCode)}
  if(Test-Path -LiteralPath $readyPath){
   $pre=Get-Content -LiteralPath $readyPath -Raw|ConvertFrom-Json
   if($pre.ready -and $pre.privateRoot -and $pre.exitMode -eq 'own-uia-exit'){$ready=$true;break}
  }
 }
 if(!$ready){throw 'WPF_COORDINATOR_READY_TIMEOUT'}
 $result.wpfRealCoordinatorStarted=$true
 $gateway=Start-Process -FilePath $node -ArgumentList @('dist/src/index.js') -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
 $ready=$false
 for($i=0;$i -lt 60;$i++){
  Start-Sleep -Milliseconds 300
  if($gateway.HasExited){throw ('FULL_GATEWAY_EARLY_EXIT_'+$gateway.ExitCode)}
  try{
   $health=Invoke-RestMethod -Uri ("http://127.0.0.1:$port/health") -TimeoutSec 2
   if($health.ok){$ready=$true;break}
  }catch{}
 }
 if(!$ready){throw 'FULL_GATEWAY_HEALTH_TIMEOUT'}
 if($health.mode -ne 'desktop-runtime' -or $health.policy.profile -ne 'full-control' -or $health.auditEnabled -ne $true -or $health.agentDesktopEnabled -ne $true){throw 'FULL_GATEWAY_HEALTH_INVARIANT'}
 $result.fullRuntimeReady=$true
 $result.fullControlPolicy=$true
 $result.independentAudit=$true
 $bind=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)
 if($bind.Count -ne 1 -or $bind[0].LocalAddress -ne '127.0.0.1' -or $bind[0].OwningProcess -ne $gateway.Id){throw 'LOOPBACK_PORT_OWNERSHIP_INVARIANT'}
 $result.gatewayBoundLoopback=$true
 & $node 'test-area/ownerless-gateway-handoff/full-control-client.mjs'
 if($LASTEXITCODE -ne 0){throw 'FULL_CONTROL_MCP_HUD_UIA_CLIENT_FAIL'}
 $result.mcpHudExitVerified=$true
 if(!$controlPanel.WaitForExit(18000)){throw 'WPF_NOT_EXITED_AFTER_UIA'}
 if($controlPanel.ExitCode -ne 0){throw ('WPF_PROCESS_RETURNED_'+$controlPanel.ExitCode)}
 $evidence=Get-Content -LiteralPath (Join-Path $testRoot 'manager-handoff-result.json') -Raw|ConvertFrom-Json
 if($evidence.status -ne 'REAL_MANAGER_UIA_EXIT_PASS' -or $evidence.foreground_events_owned -ne 0 -or !$evidence.owner_remained_desktop1 -or !$evidence.uia_exit_mutation_confirmed){throw 'WPF_UIA_EVIDENCE_INVARIANT'}
 $result.wpfExitedCleanly=$true
 $result.status='FULL_CONTROL_GATEWAY_MCP_HUD_UIA_EXIT_PASS'
}catch{
 $result.status='FULL_CONTROL_GATEWAY_MCP_HUD_UIA_EXIT_FAIL'
 $result.error=$_.Exception.Message
}finally{
 if($gateway){
  try{& $node 'dist/src/stop.js' ([string]$port) *> $null}catch{}
  try{if(!$gateway.HasExited){$gateway.WaitForExit(5000)|Out-Null}}catch{}
  if(!$gateway.HasExited){try{$gateway.Kill();$gateway.WaitForExit(5000)|Out-Null}catch{}}
  $result.gatewayExitedCleanly=$gateway.HasExited
 }
 if($controlPanel){
  if(!$controlPanel.HasExited){try{$controlPanel.Kill();$controlPanel.WaitForExit(5000)|Out-Null}catch{}}
  $result.wpfExitedCleanly=$result.wpfExitedCleanly -and $controlPanel.HasExited
 }
 $result.testPortReleased=!( [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue))
 try{
  $test=Get-Content -LiteralPath (Join-Path $testRoot 'agent-desktop\control.json') -Raw|ConvertFrom-Json
  $result.privateControlsCleared=@($test.controls).Count -eq 0
 }catch{}
 try{
  $result.productionControlUnchanged=((Get-FileHash -LiteralPath $installedData -Algorithm SHA256).Hash -eq $baselineHash)
  $guiAfter=@(Get-CimInstance Win32_Process -Filter "name='DeskMCP.exe'" | Where-Object {$_.ExecutablePath -ieq $installedGui} | Select-Object -ExpandProperty ProcessId)
  $result.installedControlPanelUnchanged=$guiAfter.Count -eq 1 -and $guiAfter[0] -eq $productionGuiPid[0]
 }catch{}
 $result|ConvertTo-Json -Depth 5 |Set-Content -LiteralPath (Join-Path $testRoot 'full-control-runtime-result.json')
 Write-Output ('FULL_CONTROL_GATEWAY='+($result|ConvertTo-Json -Depth 5 -Compress))
}
if($result.status -ne 'FULL_CONTROL_GATEWAY_MCP_HUD_UIA_EXIT_PASS' -or !$result.gatewayExitedCleanly -or !$result.wpfExitedCleanly -or !$result.privateControlsCleared -or !$result.productionControlUnchanged -or !$result.installedControlPanelUnchanged -or !$result.testPortReleased){exit 2}
