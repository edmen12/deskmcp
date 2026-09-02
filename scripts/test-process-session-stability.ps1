param(
    [int]$SessionCount = 32,
    [int]$AttemptCount = 0,
    [switch]$Quick
)
$ErrorActionPreference = 'Stop'
if ($Quick) { $SessionCount = 8; $AttemptCount = 8 }
if ($SessionCount -lt 1 -or $SessionCount -gt 32) { throw 'SessionCount must be between 1 and 32.' }
if ($AttemptCount -eq 0) { $AttemptCount = $SessionCount }
if ($AttemptCount -lt $SessionCount -or $AttemptCount -gt 64) { throw 'AttemptCount must be between SessionCount and 64.' }

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RunId = [guid]::NewGuid().ToString('N')
$Marker = 'DESKMCP_PROCESS_PRESSURE_' + $RunId
$RunRoot = Join-Path $ProjectRoot ('runtime\agent-safe-process-pressure\' + $RunId)
$GatewayRoot = Join-Path $RunRoot 'gateway'
$GatewayDist = Join-Path $GatewayRoot 'dist'
$Workspace = Join-Path $RunRoot 'workspace'
$AuditLog = Join-Path $RunRoot 'audit.jsonl'
$StressScript = Join-Path $RunRoot 'process-pressure.mjs'
$ShutdownScript = Join-Path $RunRoot 'shutdown-pressure.mjs'
$NodeExe = Join-Path $ProjectRoot 'runtime\downloads\node-v24.19.0\node-v24.19.0-win-x64\node.exe'
$TscCmd = Join-Path $ProjectRoot 'node_modules\.bin\tsc.cmd'
$DcEntry = Join-Path $ProjectRoot 'node_modules\@wonderwhy-er\desktop-commander\dist\index.js'
$ClientEntry = Join-Path $ProjectRoot 'node_modules\@modelcontextprotocol\client\dist\index.mjs'
$SourceNodeModules = Join-Path $ProjectRoot 'node_modules'
$gateway = $null

function Require([bool]$Condition,[string]$Message){ if(-not $Condition){ throw $Message } }
function FreePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    try { $listener.Start(); return ([Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}
function MarkerProcesses {
    return @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Marker) })
}
function Wait-MarkerCount([int]$Expected,[int]$Seconds=15) {
    $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $items=@(MarkerProcesses)
        if($items.Count -eq $Expected){ return $items }
        Start-Sleep -Milliseconds 200
    } while([DateTime]::UtcNow -lt $deadline)
    throw ('Marker process count=' + $items.Count + '; expected=' + $Expected)
}
function Get-OptionalFileState([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Exists=$false; Hash=$null } }
    return [pscustomobject]@{ Exists=$true; Hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash }
}
function Require-UnchangedFileState([string]$Label,[string]$Path,[object]$Before) {
    $after = Get-OptionalFileState $Path
    Require ($after.Exists -eq $Before.Exists -and $after.Hash -eq $Before.Hash) ($Label + ' changed during process-session stability test.')
}

foreach ($required in @($NodeExe,$TscCmd,$DcEntry,$ClientEntry)) { Require (Test-Path -LiteralPath $required) ('Required dependency is missing: ' + $required) }
$RealStartupLink = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)) 'DeskMCP Control Panel.lnk'
$RealSettingsPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'DesktopMCP\settings.json'
$RealTunnelProfile = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'tunnel-client\desktop-mcp.yaml'
$RealStartupBefore = Get-OptionalFileState $RealStartupLink
$RealSettingsBefore = Get-OptionalFileState $RealSettingsPath
$RealTunnelBefore = Get-OptionalFileState $RealTunnelProfile
$LivePanelPidsBefore = @(Get-Process -Name DeskMCP -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$old = @{
    Profile=$env:DESKTOP_MCP_PROFILE; Roots=$env:DESKTOP_MCP_ALLOWED_ROOTS; Port=$env:DESKTOP_MCP_PORT;
    Audit=$env:DESKTOP_MCP_AUDIT_LOG; Dc=$env:DESKTOP_COMMANDER_ENTRY
}

try {
    New-Item -ItemType Directory -Force -Path $GatewayRoot,$GatewayDist,$Workspace | Out-Null
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'package.json') -Destination (Join-Path $GatewayRoot 'package.json') -Force
    & $TscCmd -p (Join-Path $ProjectRoot 'tsconfig.json') --outDir $GatewayDist
    if ($LASTEXITCODE -ne 0) { throw 'Private Gateway TypeScript build failed.' }
    New-Item -ItemType Junction -Path (Join-Path $GatewayRoot 'node_modules') -Target $SourceNodeModules | Out-Null

    $clientEntryUrl = $ClientEntry.Replace('\','/')
    $nodeForCommand = $NodeExe.Replace('\','\\')
    $stressSource = @'
import { pathToFileURL } from 'node:url';
const [rawPort, rawExpectedCount, rawAttemptCount, marker] = process.argv.slice(2);
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL('__CLIENT_ENTRY__').href);
const expectedCount = Number(rawExpectedCount);
const attemptCount = Number(rawAttemptCount);
const baseUrl = `http://127.0.0.1:${rawPort}/mcp`;
const clients = Array.from({ length: attemptCount }, (_, i) => new Client(
  { name: `deskmcp-process-pressure-${i}`, version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } }
));
const text = result => JSON.stringify(result.content);
const sessionId = result => {
  const m = text(result).match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  if (!m) throw new Error(`missing process session id: ${text(result)}`);
  return m[0];
};
try {
  await Promise.all(clients.map(c => c.connect(new StreamableHTTPClientTransport(new URL(baseUrl)))));
  const command = `echo ${marker} && ping 127.0.0.1 -t`;
  const started = await Promise.all(clients.map(c => c.callTool({
    name: 'desktop_start_process',
    arguments: { command, timeout_ms: 750, shell: 'cmd.exe' }
  })));
  const accepted = started
    .map((result, index) => ({ result, client: clients[index], index }))
    .filter(item => item.result.isError !== true)
    .map(item => ({ ...item, id: sessionId(item.result) }));
  const denied = started.filter(result => result.isError === true);
  if (accepted.length !== expectedCount) {
    throw new Error(`accepted ${accepted.length}; expected ${expectedCount}: ${started.map(text).join(' | ')}`);
  }
  if (denied.length !== attemptCount - expectedCount) {
    throw new Error(`denied ${denied.length}; expected ${attemptCount - expectedCount}`);
  }
  if (denied.some(result => !/Process session limit reached/.test(text(result)))) {
    throw new Error(`unexpected start denial: ${denied.map(text).join(' | ')}`);
  }
  const ids = accepted.map(item => item.id);
  if (new Set(ids).size !== expectedCount) throw new Error('process session IDs were not unique');
  console.log(`PROCESS_SESSIONS_STARTED=${ids.length}`);
  console.log(`PROCESS_SESSION_START_DENIED=${denied.length}`);

  const reads = await Promise.all(accepted.map(item => item.client.callTool({
    name: 'desktop_read_process',
    arguments: { session_id: item.id, timeout_ms: 0, offset: 0, length: 100 }
  })));
  if (reads.some(r => r.isError === true)) {
    console.error('PROCESS_READ_FAILURES=' + reads.map(text).join(' | '));
    throw new Error('concurrent process read failed');
  }
  console.log(`PROCESS_SESSION_READS=${reads.length}`);

  const terminated = await Promise.all(accepted.map(item => item.client.callTool({
    name: 'desktop_terminate_process',
    arguments: { session_id: item.id }
  })));
  if (terminated.some(r => r.isError === true)) throw new Error('concurrent process termination failed');
  console.log(`PROCESS_SESSIONS_TERMINATED=${terminated.length}`);

  const replay = await accepted[0].client.callTool({
    name: 'desktop_read_process',
    arguments: { session_id: ids[0], timeout_ms: 0 }
  });
  if (replay.isError !== true || !/Unknown or unowned process session/.test(text(replay))) {
    throw new Error('terminated process session capability was reusable');
  }
  console.log('PROCESS_SESSION_REPLAY=DENIED');

  const completedStart = await clients[0].callTool({
    name: 'desktop_start_process',
    arguments: { command: 'echo DESKMCP_COMPLETED_OUTPUT', timeout_ms: 750, shell: 'cmd.exe' }
  });
  if (completedStart.isError === true) throw new Error(`completed process start failed: ${text(completedStart)}`);
  const completedId = sessionId(completedStart);
  const completedRead = await clients[0].callTool({
    name: 'desktop_read_process',
    arguments: { session_id: completedId, timeout_ms: 0, offset: 0, length: 100 }
  });
  if (completedRead.isError === true || !/DESKMCP_COMPLETED_OUTPUT/.test(text(completedRead)) || !/Process completed with exit code 0/.test(text(completedRead))) {
    throw new Error(`completed process output was not readable: ${text(completedRead)}`);
  }
  console.log('PROCESS_COMPLETED_READ=PASS');

  for (let i = 0; i < 40; i++) {
    const quick = await clients[i % clients.length].callTool({
      name: 'desktop_start_process',
      arguments: { command: `echo DESKMCP_RECYCLE_${i}`, timeout_ms: 750, shell: 'cmd.exe' }
    });
    if (quick.isError === true) throw new Error(`completed-session capacity did not recycle at ${i}: ${text(quick)}`);
  }
  console.log('PROCESS_COMPLETED_CAPACITY_RECYCLE=40');

  const raceCount = Math.min(16, clients.length);
  const raceStarts = await Promise.all(clients.slice(0, raceCount).map(client => client.callTool({
    name: 'desktop_start_process',
    arguments: { command, timeout_ms: 750, shell: 'cmd.exe' }
  })));
  if (raceStarts.some(result => result.isError === true)) {
    throw new Error(`read/terminate race setup failed: ${raceStarts.map(text).join(' | ')}`);
  }
  const raceItems = raceStarts.map((result, index) => ({ id: sessionId(result), client: clients[index] }));
  await Promise.all(raceItems.map(async item => {
    const [readResult, terminateResult] = await Promise.all([
      item.client.callTool({
        name: 'desktop_read_process',
        arguments: { session_id: item.id, timeout_ms: 0, offset: 0, length: 50 }
      }),
      item.client.callTool({ name: 'desktop_terminate_process', arguments: { session_id: item.id } })
    ]);
    if (terminateResult.isError === true) {
      throw new Error(`concurrent terminate failed: ${text(terminateResult)}`);
    }
    if (readResult.isError === true && !/Unknown or unowned process session|No session found|No active session found/.test(text(readResult))) {
      throw new Error(`unexpected concurrent read failure: ${text(readResult)}`);
    }
  }));
  console.log(`PROCESS_READ_TERMINATE_RACE=${raceCount}`);
} finally {
  await Promise.allSettled(clients.map(c => c.close()));
}
'@
    [IO.File]::WriteAllText($StressScript,$stressSource.Replace('__CLIENT_ENTRY__',$clientEntryUrl),[Text.UTF8Encoding]::new($false))
    $shutdownSource = @'
import { pathToFileURL } from 'node:url';
const [rawPort,rawCount]=process.argv.slice(2);
const { Client, StreamableHTTPClientTransport }=await import(pathToFileURL('__CLIENT_ENTRY__').href);
const count=Number(rawCount);
const clients=Array.from({length:count},(_,i)=>new Client(
  {name:`deskmcp-shutdown-pressure-${i}`,version:'1.0.0'},
  {versionNegotiation:{mode:'auto'}}
));
const text=result=>JSON.stringify(result.content);
try {
  await Promise.all(clients.map(client=>client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${rawPort}/mcp`)))));
  const results=await Promise.all(clients.map(client=>client.callTool({
    name:'desktop_start_process',
    arguments:{command:'echo __MARKER__ && ping 127.0.0.1 -t',timeout_ms:750,shell:'cmd.exe'}
  })));
  if(results.some(result=>result.isError===true)) throw new Error(`shutdown setup failed: ${results.map(text).join(' | ')}`);
  console.log(`PROCESS_SHUTDOWN_SESSIONS_STARTED=${results.length}`);
} finally {
  await Promise.allSettled(clients.map(client=>client.close()));
}
'@
    $shutdownSource = $shutdownSource.Replace('__CLIENT_ENTRY__',$clientEntryUrl).Replace('__MARKER__',$Marker)
    [IO.File]::WriteAllText($ShutdownScript,$shutdownSource,[Text.UTF8Encoding]::new($false))

    $port = FreePort
    $env:DESKTOP_MCP_PROFILE = 'full-control'
    $env:DESKTOP_MCP_ALLOWED_ROOTS = $Workspace
    $env:DESKTOP_MCP_PORT = [string]$port
    $env:DESKTOP_MCP_AUDIT_LOG = $AuditLog
    $env:DESKTOP_COMMANDER_ENTRY = $DcEntry
    $gateway = Start-Process -FilePath $NodeExe -ArgumentList 'dist\src\index.js' -WorkingDirectory $GatewayRoot -PassThru

    $base = 'http://127.0.0.1:' + $port
    $health=$null;$deadline=[DateTime]::UtcNow.AddSeconds(40)
    do {
        if($gateway.HasExited){throw ('Private Gateway exited early: '+$gateway.ExitCode)}
        try{$health=Invoke-RestMethod ($base+'/health') -TimeoutSec 1}catch{Start-Sleep -Milliseconds 250}
    } while(-not $health -and [DateTime]::UtcNow -lt $deadline)
    Require ([bool]$health) 'Private process-pressure Gateway did not become healthy.'
    Require ($health.policy.profile -eq 'full-control') 'Private process-pressure Gateway has the wrong profile.'

    & $NodeExe $StressScript ([string]$port) ([string]$SessionCount) ([string]$AttemptCount) $Marker
    if($LASTEXITCODE -ne 0){throw ('Process pressure exited '+$LASTEXITCODE)}

    # The client has already requested termination; all test processes must now disappear.
    [void](Wait-MarkerCount 0 15)

    # A Desktop Commander crash must not orphan terminal children. The next process
    # call must reconnect only the bridge while keeping the Gateway alive.
    & $NodeExe $ShutdownScript ([string]$port) '1'
    if($LASTEXITCODE -ne 0){throw ('DC-crash setup exited '+$LASTEXITCODE)}
    [void](Wait-MarkerCount 1 15)
    $privateDc=@(Get-CimInstance Win32_Process | Where-Object {
        [int]$_.ParentProcessId -eq $gateway.Id -and $_.Name -eq 'node.exe' -and $_.CommandLine -match 'desktop-commander'
    })
    Require ($privateDc.Count -eq 1) ('Private Desktop Commander count='+$privateDc.Count)
    Stop-Process -Id ([int]$privateDc[0].ProcessId) -Force
    [void](Wait-MarkerCount 0 15)
    $dcHealthDeadline=[DateTime]::UtcNow.AddSeconds(10);$dcHealth=$null
    do {
        try{$dcHealth=Invoke-RestMethod ($base+'/health') -TimeoutSec 1}catch{}
        if($dcHealth -and $dcHealth.desktopCommander.ready -eq $false){break}
        Start-Sleep -Milliseconds 100
    } while([DateTime]::UtcNow -lt $dcHealthDeadline)
    Require ($dcHealth -and $dcHealth.desktopCommander.ready -eq $false) 'Desktop Commander crash did not surface ready=false.'
    Write-Output 'PROCESS_DC_CRASH_CHILD_CLEANUP=PASS'

    $shutdownCount=[Math]::Min(8,$SessionCount)
    & $NodeExe $ShutdownScript ([string]$port) ([string]$shutdownCount)
    if($LASTEXITCODE -ne 0){throw ('Shutdown-cleanup setup exited '+$LASTEXITCODE)}
    [void](Wait-MarkerCount $shutdownCount 15)
    $reconnectedHealth=Invoke-RestMethod ($base+'/health') -TimeoutSec 2
    Require ($reconnectedHealth.desktopCommander.ready -eq $true) 'Desktop Commander bridge did not reconnect on the next process call.'
    Write-Output 'PROCESS_DC_RECONNECT=PASS'
    $previousErrorActionPreference=$ErrorActionPreference
    try {
        $ErrorActionPreference='Continue'
        & $NodeExe (Join-Path $GatewayRoot 'dist\src\stop.js') ([string]$port) 1>$null 2>$null
        $stopExit=$LASTEXITCODE
    } finally {
        $ErrorActionPreference=$previousErrorActionPreference
    }
    if($stopExit -ne 0){throw ('Private Gateway graceful stop exited '+$stopExit)}
    Require ($gateway.WaitForExit(10000)) 'Private Gateway did not exit after graceful shutdown.'
    [void](Wait-MarkerCount 0 15)
    Write-Output ('PROCESS_GATEWAY_SHUTDOWN_CLEANUP='+$shutdownCount)

    $auditText=Get-Content -LiteralPath $AuditLog -Raw
    Require (-not $auditText.Contains($Marker)) 'Audit log leaked process command content.'
    Write-Output ('PROCESS_SESSION_STABILITY_' + $SessionCount + '=PASS')
} finally {
    try {
        if($gateway -and -not $gateway.HasExited){
            try{& $NodeExe (Join-Path $GatewayRoot 'dist\src\stop.js') ([string]$port) *> $null}catch{}
            try{if(-not $gateway.WaitForExit(5000)){Stop-Process -Id $gateway.Id -Force -ErrorAction SilentlyContinue}}catch{}
        }
        foreach($process in MarkerProcesses){
            try {
                if($process.CommandLine -and $process.CommandLine.Contains($Marker)){ Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue }
            } catch {}
        }
    } finally {
        $env:DESKTOP_MCP_PROFILE=$old.Profile;$env:DESKTOP_MCP_ALLOWED_ROOTS=$old.Roots;$env:DESKTOP_MCP_PORT=$old.Port
        $env:DESKTOP_MCP_AUDIT_LOG=$old.Audit;$env:DESKTOP_COMMANDER_ENTRY=$old.Dc
        try{if(Test-Path -LiteralPath $RunRoot){Remove-Item -LiteralPath $RunRoot -Recurse -Force}}catch{}
    }
}

Require-UnchangedFileState 'Real Startup shortcut' $RealStartupLink $RealStartupBefore
Require-UnchangedFileState 'Real DeskMCP settings' $RealSettingsPath $RealSettingsBefore
Require-UnchangedFileState 'Real Tunnel profile' $RealTunnelProfile $RealTunnelBefore
foreach($livePid in $LivePanelPidsBefore){Require ([bool](Get-Process -Id $livePid -ErrorAction SilentlyContinue)) "Process-session stability test terminated pre-existing DeskMCP PID $livePid."}
Write-Output 'REAL_USER_STATE_UNCHANGED=OK'
Write-Output 'PREEXISTING_DESKMCP_PROCESSES_PRESERVED=OK'
