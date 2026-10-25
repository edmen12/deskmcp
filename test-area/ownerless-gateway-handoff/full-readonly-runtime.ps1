$ErrorActionPreference='Stop'
$root='C:\Users\User\Desktop\DeskMCP-ComputerUse-Core-20261023'
$dir=Join-Path $root 'test-area\ownerless-gateway-handoff\data'
$hostExe='C:\Users\User\AppData\Local\Programs\DesktopMCP\DeskMCP.ProcessHost.exe'
$desktopHost='C:\Users\User\AppData\Local\Programs\DesktopMCP\DeskMCP.AgentDesktopHost.exe'
$port=59123
$proc=$null
$result=[ordered]@{
 status='NOT_STARTED';candidateRoot=$true;privateState=$true;readOnlyProfile=$true
 boundLoopback=$false;fullRuntime=$false;hudToolRegistered=$false
 policyDeniedUnauthenticatedStart=$false;cleanShutdown=$false
 productDesktop2StillFree=$true;error=''
}
if(!(Test-Path -LiteralPath $dir) -or !(Test-Path -LiteralPath $hostExe) -or !(Test-Path -LiteralPath $desktopHost)){
 throw 'PINNED_ISOLATED_CANDIDATE_PREREQUISITES_MISSING'
}
$existing=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if($existing){throw 'TEST_PORT_ALREADY_OCCUPIED'}
$testControl=Join-Path $dir 'agent-desktop\control.json'
if(Test-Path -LiteralPath $testControl){
 $parsed=Get-Content -LiteralPath $testControl -Raw|ConvertFrom-Json
 if(@($parsed.controls).Count -ne 0){throw 'ISOLATED_CONTROL_ALREADY_ACTIVE'}
}
$env:DESKTOP_MCP_DATA_ROOT=$dir
$env:DESKTOP_MCP_PROFILE='read-only'
$env:DESKTOP_MCP_INSTANCE_NAMESPACE='ownerless-readonly-runtime-20261024'
$env:DESKTOP_MCP_ALLOWED_ROOTS=$dir
$env:DESKTOP_MCP_DISABLE_TUNNEL='1'
$env:DESKTOP_MCP_PORT=[string]$port
$env:DESKTOP_MCP_AUDIT_LOG=Join-Path $dir 'full-runtime-audit.jsonl'
$env:DESKTOP_MCP_PROCESS_HOST=$hostExe
$env:DESKTOP_MCP_AGENT_DESKTOP_HOST_PATH=$desktopHost
$env:DESKTOP_MCP_SETTINGS_DIR=Join-Path $dir 'settings'
$env:DESKTOP_MCP_TUNNEL_PROFILE_PATH=Join-Path $dir 'candidate-no-tunnel.yaml'
$env:DESKTOP_MCP_STARTUP_LINK_PATH=Join-Path $dir 'candidate-no-startup.lnk'
$env:DESKTOP_MCP_AGENT_DESKTOP_OWNERLESS_SAFETY_WINDOWS_EXPERIMENT='1'
$node=(Get-Command node.exe -ErrorAction Stop).Source
$stdout=Join-Path $dir 'full-runtime.stdout.log'
$stderr=Join-Path $dir 'full-runtime.stderr.log'
try{
  $proc=Start-Process -FilePath $node -ArgumentList @('dist/src/index.js') -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $ready=$false
  for($i=0;$i -lt 40;$i++){
    Start-Sleep -Milliseconds 350
    if($proc.HasExited){throw ('CANDIDATE_GATEWAY_EXITED_EARLY_'+$proc.ExitCode)}
    try{
       $health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$port+'/health') -TimeoutSec 2
       if($health.ok -eq $true){$ready=$true;break}
    }catch{}
  }
  if(!$ready){throw 'CANDIDATE_GATEWAY_HEALTH_TIMEOUT'}
  if($health.mode -ne 'desktop-runtime' -or $health.policy.profile -ne 'read-only' -or
     $health.auditEnabled -ne $true -or $health.agentDesktopEnabled -ne $true)
       {throw 'FULL_GATEWAY_RUNTIME_INVARIANT_MISSING'}
  $result.fullRuntime=$true
  $bindings=@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
  if($bindings.Count -ne 1 -or $bindings[0].LocalAddress -ne '127.0.0.1' -or
     $bindings[0].OwningProcess -ne $proc.Id)
      {throw 'GATEWAY_LOOPBACK_ONLY_BIND_INVARIANT_FAILED'}
  $result.boundLoopback=$true
  & $node 'test-area/ownerless-gateway-handoff/full-readonly-client.mjs'
  if($LASTEXITCODE -ne 0){throw 'ISOLATED_GATEWAY_MCP_POLICY_NEGATIVE_TEST_FAILED'}
  $result.hudToolRegistered=$true
  $result.policyDeniedUnauthenticatedStart=$true
  $result.status='FULL_READONLY_GATEWAY_SMOKE_PASS'
}catch{
  $result.status='FULL_READONLY_GATEWAY_SMOKE_FAIL'
  $result.error=$_.Exception.Message
}finally{
  if($proc){
    try{
       # Only stop the uniquely addressed private-port candidate.
       & $node 'dist/src/stop.js' ([string]$port) *> $null
    }catch{}
    try{if(!$proc.HasExited){$proc.WaitForExit(5000)|Out-Null}}catch{}
    if(!$proc.HasExited){
       # Only the PID created above is ever killed, never the installed Gateway.
       try{$proc.Kill();$proc.WaitForExit(4000)|Out-Null}catch{}
    }
    $result.cleanShutdown=$proc.HasExited
  }
  $result | ConvertTo-Json -Depth 5 |Set-Content -LiteralPath (Join-Path $dir 'full-readonly-runtime-result.json')
  Write-Output ('FULL_GATEWAY_SMOKE='+($result|ConvertTo-Json -Depth 4 -Compress))
}
if($result.status -ne 'FULL_READONLY_GATEWAY_SMOKE_PASS' -or !$result.cleanShutdown){exit 2}
