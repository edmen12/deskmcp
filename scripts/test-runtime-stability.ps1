param(
    [int]$GatewaySpacedLoops = 5,
    [int]$GatewayStormLoops = 4,
    [int]$DesktopCommanderLoops = 5,
    [switch]$Quick
)
$ErrorActionPreference = 'Stop'
if ($Quick) { $GatewaySpacedLoops = 1; $GatewayStormLoops = 1; $DesktopCommanderLoops = 1 }
foreach ($value in @($GatewaySpacedLoops,$GatewayStormLoops,$DesktopCommanderLoops)) { if ($value -lt 0 -or $value -gt 20) { throw 'Stability loop counts must be between 0 and 20.' } }

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = Join-Path $ProjectRoot 'runtime'
$RunRoot = Join-Path $RuntimeRoot ('agent-safe-stability\' + [guid]::NewGuid().ToString('N'))
$PrivateSourceRoot = Join-Path $RunRoot 'source'
$PrivateWpfRoot = Join-Path $PrivateSourceRoot 'control-panel\wpf'
$PrivateBrandRoot = Join-Path $PrivateSourceRoot 'assets\brand'
$PanelRoot = Join-Path $RunRoot 'panel'
$GatewayRoot = Join-Path $RunRoot 'gateway'
$GatewayDist = Join-Path $GatewayRoot 'dist'
$DataRoot = Join-Path $RunRoot 'local'
$SettingsRoot = Join-Path $RunRoot 'roaming'
$Workspace = Join-Path $RunRoot 'workspace'
$StartupDir = Join-Path $RunRoot 'startup'
$StartupLink = Join-Path $StartupDir 'DeskMCP Control Panel.lnk'
$TunnelProfileDir = Join-Path $RunRoot 'tunnel-profile'
$TunnelProfile = Join-Path $TunnelProfileDir 'desktop-mcp.yaml'
$ProbeScript = Join-Path $RunRoot 'mcp-probe.mjs'
$NodeExe = Join-Path $ProjectRoot 'runtime\downloads\node-v24.19.0\node-v24.19.0-win-x64\node.exe'
$DotnetExe = Join-Path $ProjectRoot 'runtime\dotnet-sdk\dotnet.exe'
$TscCmd = Join-Path $ProjectRoot 'node_modules\.bin\tsc.cmd'
$DcEntry = Join-Path $ProjectRoot 'node_modules\@wonderwhy-er\desktop-commander\dist\index.js'
$TunnelExe = Join-Path $ProjectRoot 'tools\tunnel-client\v0.0.13\bin\tunnel-client.exe'
$SourceNodeModules = Join-Path $ProjectRoot 'node_modules'
$panel = $null

function Require([bool]$Condition,[string]$Message){ if(-not $Condition){ throw $Message } }
function FreePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    try { $listener.Start(); return ([Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}
function Health([string]$BaseUrl) { try { return Invoke-RestMethod ($BaseUrl + '/health') -TimeoutSec 1 } catch { return $null } }
function ChildProcesses([int]$ProcessId) { return @(Get-CimInstance Win32_Process | Where-Object { [int]$_.ParentProcessId -eq $ProcessId }) }
function GatewayChild([int]$PanelPid) {
    $items = @(ChildProcesses $PanelPid | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist[\\/]src[\\/]index\.js' })
    if ($items.Count -ne 1) { return $null }
    return $items[0]
}
function DcChild([int]$GatewayPid) {
    $items = @(ChildProcesses $GatewayPid | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'desktop-commander' })
    if ($items.Count -ne 1) { return $null }
    return $items[0]
}
function StopExpectedNodeChild([int]$ProcessId,[int]$ExpectedParentId,[string]$CommandPattern) {
    $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction SilentlyContinue
    if (-not $process) { return }
    Require ($process.Name -eq 'node.exe' -and [int]$process.ParentProcessId -eq $ExpectedParentId -and $process.CommandLine -match $CommandPattern) ("Refusing to terminate PID $ProcessId because it no longer matches the owned child identity.")
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
}
function StopCurrentPrivateTree([System.Diagnostics.Process]$PanelProcess) {
    if (-not $PanelProcess -or $PanelProcess.HasExited) { return }
    $panelPid = [int]$PanelProcess.Id
    $gateways = @(ChildProcesses $panelPid | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist[\\/]src[\\/]index\.js' })
    foreach ($gateway in $gateways) {
        $dcs = @(ChildProcesses ([int]$gateway.ProcessId) | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'desktop-commander' })
        foreach ($dc in $dcs) { try { StopExpectedNodeChild ([int]$dc.ProcessId) ([int]$gateway.ProcessId) 'desktop-commander' } catch { } }
        try { StopExpectedNodeChild ([int]$gateway.ProcessId) $panelPid 'dist[\\/]src[\\/]index\.js' } catch { }
    }
    try { if (-not $PanelProcess.HasExited) { Stop-Process -Id $panelPid -Force -ErrorAction Stop } } catch { }
}
function Get-OptionalFileState([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Exists=$false; Hash=$null } }
    return [pscustomobject]@{ Exists=$true; Hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash }
}
function Require-UnchangedFileState([string]$Label,[string]$Path,[object]$Before) {
    $after = Get-OptionalFileState $Path
    Require ($after.Exists -eq $Before.Exists -and $after.Hash -eq $Before.Hash) ($Label + ' changed during agent-safe stability test.')
}
function ProbeTool([int]$Port) {
    & $NodeExe $ProbeScript ([string]$Port) $Workspace *> $null
    return [int]$LASTEXITCODE
}
function WaitInitial([string]$BaseUrl,[int]$PanelPid,[int]$Seconds=40) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $health = Health $BaseUrl
        $gateway = GatewayChild $PanelPid
        if ($health -and $gateway) {
            $dc = DcChild ([int]$gateway.ProcessId)
            if ($dc) { return @($health,$gateway,$dc) }
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    $errorLog = Join-Path $DataRoot 'logs\control-panel-error.log'
    if (Test-Path -LiteralPath $errorLog) { Write-Output 'CONTROL_PANEL_ERROR_BEGIN'; Get-Content -LiteralPath $errorLog -Tail 40; Write-Output 'CONTROL_PANEL_ERROR_END' }
    throw 'Private stability instance did not reach healthy Gateway + Desktop Commander topology.'
}

foreach ($required in @($NodeExe,$DotnetExe,$TscCmd,$DcEntry,$TunnelExe)) { Require (Test-Path -LiteralPath $required) ('Required stability dependency is missing: ' + $required) }
$RealStartupLink = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)) 'DeskMCP Control Panel.lnk'
$RealSettingsPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'DesktopMCP\settings.json'
$RealTunnelProfile = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'tunnel-client\desktop-mcp.yaml'
$RealStartupBefore = Get-OptionalFileState $RealStartupLink
$RealSettingsBefore = Get-OptionalFileState $RealSettingsPath
$RealTunnelBefore = Get-OptionalFileState $RealTunnelProfile
$LivePanelPidsBefore = @(Get-Process -Name DeskMCP -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$old = @{
    Data=$env:DESKTOP_MCP_DATA_ROOT; Settings=$env:DESKTOP_MCP_SETTINGS_DIR; Port=$env:DESKTOP_MCP_PORT;
    Namespace=$env:DESKTOP_MCP_INSTANCE_NAMESPACE; Gateway=$env:DESKTOP_MCP_GATEWAY_ROOT;
    Node=$env:DESKTOP_MCP_NODE_PATH; Dc=$env:DESKTOP_COMMANDER_ENTRY; Tunnel=$env:DESKTOP_MCP_TUNNEL_PATH;
    Startup=$env:DESKTOP_MCP_STARTUP_LINK_PATH; TunnelProfile=$env:DESKTOP_MCP_TUNNEL_PROFILE_PATH
}

try {
    New-Item -ItemType Directory -Force -Path $PrivateWpfRoot,$PrivateBrandRoot,$PanelRoot,$GatewayRoot,$GatewayDist,$DataRoot,$SettingsRoot,$Workspace,$StartupDir,$TunnelProfileDir | Out-Null
    foreach ($name in @('DeskMCP.ControlPanel.csproj','DeskMCPControlPanel.cs','Panel.xaml','RuntimeReliability.cs','UpdateExecution.cs','UpdatePublisherPins.cs','UpdateSupport.cs')) {
        Copy-Item -LiteralPath (Join-Path $ProjectRoot ('control-panel\wpf\' + $name)) -Destination (Join-Path $PrivateWpfRoot $name) -Force
    }
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'assets\brand\DeskMCP.ico') -Destination (Join-Path $PrivateBrandRoot 'DeskMCP.ico') -Force
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'assets\brand\deskmcp-mark-64.png') -Destination (Join-Path $PrivateBrandRoot 'deskmcp-mark-64.png') -Force
    & $DotnetExe build (Join-Path $PrivateWpfRoot 'DeskMCP.ControlPanel.csproj') -c Release -o $PanelRoot
    if ($LASTEXITCODE -ne 0) { throw 'Private WPF stability build failed.' }

    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'package.json') -Destination (Join-Path $GatewayRoot 'package.json') -Force
    & $TscCmd -p (Join-Path $ProjectRoot 'tsconfig.json') --outDir $GatewayDist
    if ($LASTEXITCODE -ne 0) { throw 'Private Gateway TypeScript build failed.' }
    New-Item -ItemType Junction -Path (Join-Path $GatewayRoot 'node_modules') -Target $SourceNodeModules | Out-Null

    $clientEntry = (Join-Path $ProjectRoot 'node_modules\@modelcontextprotocol\client\dist\index.mjs').Replace('\','/')
    $probe = @'
import { pathToFileURL } from 'node:url';
const [rawPort, probePath] = process.argv.slice(2);
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL('__CLIENT_ENTRY__').href);
const client = new Client({ name: 'deskmcp-agent-safe-stability', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${rawPort}/mcp`)));
  const result = await client.callTool({ name: 'desktop_get_file_info', arguments: { path: probePath } });
  if (result.isError === true) process.exitCode = 2;
} finally { await client.close().catch(() => undefined); }
'@
    [IO.File]::WriteAllText($ProbeScript,$probe.Replace('__CLIENT_ENTRY__',$clientEntry),[Text.UTF8Encoding]::new($false))
    $settings = @{ onboardingCompleted=$true; profile='read-only'; autoStartTunnel=$false; theme='system'; workspace=$Workspace } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $SettingsRoot 'settings.json'),$settings,[Text.UTF8Encoding]::new($false))

    $port = FreePort
    $base = 'http://127.0.0.1:' + $port
    $env:DESKTOP_MCP_DATA_ROOT=$DataRoot
    $env:DESKTOP_MCP_SETTINGS_DIR=$SettingsRoot
    $env:DESKTOP_MCP_PORT=[string]$port
    $env:DESKTOP_MCP_INSTANCE_NAMESPACE='stability-' + [guid]::NewGuid().ToString('N')
    $env:DESKTOP_MCP_GATEWAY_ROOT=$GatewayRoot
    $env:DESKTOP_MCP_NODE_PATH=$NodeExe
    $env:DESKTOP_COMMANDER_ENTRY=$DcEntry
    $env:DESKTOP_MCP_TUNNEL_PATH=$TunnelExe
    $env:DESKTOP_MCP_STARTUP_LINK_PATH=$StartupLink
    $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH=$TunnelProfile

    $panelExe = Join-Path $PanelRoot 'DeskMCP.exe'
    $isolationProbe = Start-Process -FilePath $panelExe -ArgumentList '--agent-safe-isolation-self-test' -WorkingDirectory $PanelRoot -Wait -PassThru
    Require ($isolationProbe.ExitCode -eq 0) 'Private Panel failed the agent-safe isolation self-test.'
    Write-Output 'AGENT_SAFE_ISOLATION_CONTRACT=OK'
    $panel = Start-Process -FilePath $panelExe -ArgumentList '--startup' -WorkingDirectory $PanelRoot -PassThru
    $initial = WaitInitial $base ([int]$panel.Id)
    $gateway=$initial[1]; $dc=$initial[2]
    Require ((ProbeTool $port) -eq 0) 'Initial private MCP tool probe failed.'
    Write-Output ("STABILITY_INITIAL=OK panel={0} gateway={1} dc={2} port={3}" -f $panel.Id,$gateway.ProcessId,$dc.ProcessId,$port)

    for($i=1;$i -le $GatewaySpacedLoops;$i++) {
        $oldGatewayPid=[int]$gateway.ProcessId
        $timer=[Diagnostics.Stopwatch]::StartNew(); StopExpectedNodeChild $oldGatewayPid ([int]$panel.Id) 'dist[\\/]src[\\/]index\.js'
        $deadline=[DateTime]::UtcNow.AddSeconds(45); $gateway=$null;$dc=$null
        do {
            Start-Sleep -Milliseconds 250; $h=Health $base; $candidate=GatewayChild ([int]$panel.Id)
            if($h -and $candidate -and [int]$candidate.ProcessId -ne $oldGatewayPid){$candidateDc=DcChild ([int]$candidate.ProcessId);if($candidateDc){$gateway=$candidate;$dc=$candidateDc;break}}
        } while([DateTime]::UtcNow -lt $deadline)
        $timer.Stop(); Require ($gateway -and $dc) "Spaced Gateway crash recovery $i failed."
        Require ((ProbeTool $port) -eq 0) "Spaced Gateway tool probe $i failed."
        Require ($timer.Elapsed.TotalSeconds -lt 22) "Gateway retry state did not reset after healthy interval $i."
        Write-Output ("GATEWAY_SPACED_{0}=PASS elapsedMs={1}" -f $i,[int]$timer.Elapsed.TotalMilliseconds)
        if($i -lt $GatewaySpacedLoops -or $GatewayStormLoops -gt 0){Start-Sleep -Seconds 13;Require ([bool](Health $base)) "Gateway lost health during stabilization interval $i."}
    }

    for($i=1;$i -le $GatewayStormLoops;$i++) {
        $oldGatewayPid=[int]$gateway.ProcessId
        $timer=[Diagnostics.Stopwatch]::StartNew(); StopExpectedNodeChild $oldGatewayPid ([int]$panel.Id) 'dist[\\/]src[\\/]index\.js'
        $deadline=[DateTime]::UtcNow.AddSeconds(60); $gateway=$null;$dc=$null
        do {
            Start-Sleep -Milliseconds 250; $h=Health $base; $candidate=GatewayChild ([int]$panel.Id)
            if($h -and $candidate -and [int]$candidate.ProcessId -ne $oldGatewayPid){$candidateDc=DcChild ([int]$candidate.ProcessId);if($candidateDc){$gateway=$candidate;$dc=$candidateDc;break}}
        } while([DateTime]::UtcNow -lt $deadline)
        $timer.Stop(); Require ($gateway -and $dc) "Gateway crash storm recovery $i failed."
        Require ((ProbeTool $port) -eq 0) "Gateway crash storm tool probe $i failed."
        Write-Output ("GATEWAY_STORM_{0}=PASS elapsedMs={1}" -f $i,[int]$timer.Elapsed.TotalMilliseconds)
    }

    for($i=1;$i -le $DesktopCommanderLoops;$i++) {
        $stableGatewayPid=[int]$gateway.ProcessId; $oldDcPid=[int]$dc.ProcessId; StopExpectedNodeChild $oldDcPid $stableGatewayPid 'desktop-commander'
        $sawNotReady=$false; $deadline=[DateTime]::UtcNow.AddSeconds(10)
        do { Start-Sleep -Milliseconds 100; $h=Health $base; if($h -and $h.desktopCommander -and $h.desktopCommander.ready -eq $false){$sawNotReady=$true;break} } while([DateTime]::UtcNow -lt $deadline)
        Require $sawNotReady "Desktop Commander crash $i never surfaced ready=false."
        Require ((ProbeTool $port) -eq 0) "Desktop Commander recovery tool probe $i failed."
        $deadline=[DateTime]::UtcNow.AddSeconds(15);$dc=$null
        do {
            Start-Sleep -Milliseconds 150; $currentGateway=GatewayChild ([int]$panel.Id)
            Require ($currentGateway -and [int]$currentGateway.ProcessId -eq $stableGatewayPid) "Gateway restarted during Desktop Commander recovery $i."
            $candidateDc=DcChild $stableGatewayPid; $h=Health $base
            if($candidateDc -and [int]$candidateDc.ProcessId -ne $oldDcPid -and $h -and $h.desktopCommander.ready -eq $true){$dc=$candidateDc;break}
        } while([DateTime]::UtcNow -lt $deadline)
        Require ([bool]$dc) "Desktop Commander crash recovery $i failed."
        Write-Output ("DC_CRASH_{0}=PASS gateway={1} readyFalseObserved=True" -f $i,$stableGatewayPid)
    }

    Write-Output ('AGENT_SAFE_GATEWAY_SPACED_CRASH_LOOPS=' + $GatewaySpacedLoops)
    Write-Output ('AGENT_SAFE_GATEWAY_STORM_LOOPS=' + $GatewayStormLoops)
    Write-Output ('AGENT_SAFE_DC_CRASH_LOOPS=' + $DesktopCommanderLoops)
    Write-Output 'AGENT_SAFE_STABILITY=PASS'
}
finally {
    try {
        if($panel -and -not $panel.HasExited){try{& $NodeExe (Join-Path $GatewayRoot 'dist\src\stop.js') ([string]$port) *> $null;Start-Sleep -Milliseconds 500}catch{}}
        StopCurrentPrivateTree $panel
    } finally {
        $env:DESKTOP_MCP_DATA_ROOT=$old.Data;$env:DESKTOP_MCP_SETTINGS_DIR=$old.Settings;$env:DESKTOP_MCP_PORT=$old.Port
        $env:DESKTOP_MCP_INSTANCE_NAMESPACE=$old.Namespace;$env:DESKTOP_MCP_GATEWAY_ROOT=$old.Gateway;$env:DESKTOP_MCP_NODE_PATH=$old.Node
        $env:DESKTOP_COMMANDER_ENTRY=$old.Dc;$env:DESKTOP_MCP_TUNNEL_PATH=$old.Tunnel;$env:DESKTOP_MCP_STARTUP_LINK_PATH=$old.Startup;$env:DESKTOP_MCP_TUNNEL_PROFILE_PATH=$old.TunnelProfile
        try{if(Test-Path -LiteralPath $RunRoot){Remove-Item -LiteralPath $RunRoot -Recurse -Force}}catch{}
    }
}

Require-UnchangedFileState 'Real Startup shortcut' $RealStartupLink $RealStartupBefore
Require-UnchangedFileState 'Real DeskMCP settings' $RealSettingsPath $RealSettingsBefore
Require-UnchangedFileState 'Real Tunnel profile' $RealTunnelProfile $RealTunnelBefore
foreach($livePid in $LivePanelPidsBefore){Require ([bool](Get-Process -Id $livePid -ErrorAction SilentlyContinue)) "Agent-safe stability test terminated pre-existing DeskMCP PID $livePid."}
Write-Output 'REAL_USER_STATE_UNCHANGED=OK'
Write-Output 'PREEXISTING_DESKMCP_PROCESSES_PRESERVED=OK'
