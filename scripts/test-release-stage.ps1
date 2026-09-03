param([ValidateSet('win-x64','win-arm64')][string]$Target = 'win-x64')
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-targets.ps1')
$TargetConfig = Get-DeskMcpReleaseTarget $Target
$StageRoot = Get-DeskMcpStageRoot $ProjectRoot $Target
$hostArch = [string]$env:PROCESSOR_ARCHITECTURE
if ($Target -eq 'win-arm64' -and $hostArch -ne 'ARM64') { throw 'ARM64 runtime smoke requires a native Windows ARM64 runner.' }
if ($Target -eq 'win-x64' -and $hostArch -ne 'AMD64') { throw 'x64 runtime smoke requires a native Windows x64 runner.' }
$Version = (Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version
$PanelExe = Join-Path $StageRoot 'DeskMCP.exe'
$ProcessHostExe = Join-Path $StageRoot 'DeskMCP.ProcessHost.exe'
$NodeExe = Join-Path $StageRoot 'node\node.exe'
$GatewayRoot = Join-Path $StageRoot 'gateway'
$SmokeStateRoot = Join-Path $ProjectRoot ('runtime\release-smoke-state\' + $Target + '-' + [Guid]::NewGuid().ToString('N'))
$SmokeFile = Join-Path $SmokeStateRoot 'release-smoke.mjs'
$SmokeDataRoot = Join-Path $SmokeStateRoot 'local'
$SettingsDir = Join-Path $SmokeStateRoot 'roaming'
$SettingsPath = Join-Path $SettingsDir 'settings.json'
$SmokeStartupDir = Join-Path $SmokeStateRoot 'startup'
$SmokeStartupLink = Join-Path $SmokeStartupDir 'DeskMCP Control Panel.lnk'
$SmokeTunnelProfileDir = Join-Path $SmokeStateRoot 'tunnel-profile'
$SmokeTunnelProfile = Join-Path $SmokeTunnelProfileDir 'desktop-mcp.yaml'
$RealStartupLink = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)) 'DeskMCP Control Panel.lnk'
$RealStartupExistsBefore = Test-Path -LiteralPath $RealStartupLink
$RealStartupHashBefore = if ($RealStartupExistsBefore) { (Get-FileHash -Algorithm SHA256 -LiteralPath $RealStartupLink).Hash } else { $null }
$LivePanelPidsBefore = @(Get-Process -Name DeskMCP -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and -not [IO.Path]::GetFullPath($_.Path).StartsWith(([IO.Path]::GetFullPath($StageRoot).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) } catch { $false }
} | Select-Object -ExpandProperty Id)
$PreviousDataRoot = $env:DESKTOP_MCP_DATA_ROOT
$PreviousSettingsDir = $env:DESKTOP_MCP_SETTINGS_DIR
$PreviousPort = $env:DESKTOP_MCP_PORT
$PreviousInstanceNamespace = $env:DESKTOP_MCP_INSTANCE_NAMESPACE
$PreviousStartupLinkPath = $env:DESKTOP_MCP_STARTUP_LINK_PATH
$PreviousTunnelProfilePath = $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH
$SmokeInstanceNamespace = 'release-smoke-' + $Target + '-' + [Guid]::NewGuid().ToString('N')
if (-not (Test-Path -LiteralPath $PanelExe)) { throw 'Release-stage Panel is missing.' }
if (-not (Test-Path -LiteralPath $ProcessHostExe)) { throw 'Release-stage ProcessHost is missing.' }
if (-not (Test-Path -LiteralPath $NodeExe)) { throw 'Release-stage Node is missing.' }
$StageContractPath = Join-Path $StageRoot 'release-target.json'
if (-not (Test-Path -LiteralPath $StageContractPath)) { throw 'Release-stage target contract is missing.' }
$StageContract = Get-Content -LiteralPath $StageContractPath -Raw | ConvertFrom-Json
if ([int]$StageContract.agentSafeIsolationContract -lt 1) { throw 'Release-stage predates the agent-safe isolation contract; rebuild the stage before smoke testing.' }
if ([int]$StageContract.processJobObjectContract -lt 1) { throw 'Release-stage predates the owned-process Job Object contract; rebuild the stage before smoke testing.' }
function Get-FreeLoopbackPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}
$SmokePort = Get-FreeLoopbackPort
$SmokeBaseUrl = 'http://127.0.0.1:' + $SmokePort
$panel = $null
$health = $null
function Get-StageOwnedProcesses([string]$Root) {
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
}
function Wait-SpecificProcessIdsGone([int[]]$ProcessIds, [int]$Seconds = 15) {
    if ($null -eq $ProcessIds -or $ProcessIds.Count -eq 0) { return }
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $running = @($ProcessIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($running.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw ('Owned stage process cleanup timed out; remaining PIDs=' + ($running -join ','))
}
function Invoke-StageRenameLockCheck([string]$Root, [int]$Seconds = 10) {
    $parent = Split-Path $Root -Parent
    $lockCheck = Join-Path $parent 'DesktopMCP.lockcheck'
    if (Test-Path -LiteralPath $lockCheck) { Remove-Item -LiteralPath $lockCheck -Recurse -Force }
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $lastError = $null
    do {
        try {
            Rename-Item -LiteralPath $Root -NewName 'DesktopMCP.lockcheck' -ErrorAction Stop
            Rename-Item -LiteralPath $lockCheck -NewName 'DesktopMCP' -ErrorAction Stop
            return
        } catch {
            $lastError = $_
            if ((Test-Path -LiteralPath $lockCheck) -and -not (Test-Path -LiteralPath $Root)) {
                try { Rename-Item -LiteralPath $lockCheck -NewName 'DesktopMCP' -ErrorAction Stop } catch { }
            }
            Start-Sleep -Milliseconds 250
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw ('Stage rename lockcheck failed after process cleanup: ' + $lastError.Exception.Message)
}
$PreexistingStageProcessIds = @(Get-StageOwnedProcesses $StageRoot | Select-Object -ExpandProperty Id)
$OwnedStageNodePids = @()
try {
    New-Item -ItemType Directory -Force -Path $SettingsDir, $SmokeDataRoot, $SmokeStartupDir, $SmokeTunnelProfileDir | Out-Null
    $smokeSettings = @{ onboardingCompleted = $true; profile = 'read-only'; autoStartTunnel = $false; theme = 'system' } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($SettingsPath, $smokeSettings, [Text.UTF8Encoding]::new($false))
    $env:DESKTOP_MCP_DATA_ROOT = $SmokeDataRoot
    $env:DESKTOP_MCP_SETTINGS_DIR = $SettingsDir
    $env:DESKTOP_MCP_PORT = [string]$SmokePort
    $env:DESKTOP_MCP_INSTANCE_NAMESPACE = $SmokeInstanceNamespace
    $env:DESKTOP_MCP_STARTUP_LINK_PATH = $SmokeStartupLink
    $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH = $SmokeTunnelProfile
    Write-Output 'SMOKE_SETTINGS=ISOLATED_TEMPORARY'
    Write-Output ('SMOKE_PORT=' + $SmokePort)
    Write-Output 'SMOKE_INSTANCE_NAMESPACE=ISOLATED'
    Write-Output 'SMOKE_STARTUP_LINK=ISOLATED'
    Write-Output 'SMOKE_TUNNEL_PROFILE=ISOLATED'
    $isolationProbe = Start-Process -FilePath $PanelExe -ArgumentList '--agent-safe-isolation-self-test' -WorkingDirectory $StageRoot -Wait -PassThru
    if ($isolationProbe.ExitCode -ne 0) { throw 'Release-stage Panel failed the agent-safe isolation self-test.' }
    Write-Output 'AGENT_SAFE_ISOLATION_CONTRACT=OK'
    $panel = Start-Process -FilePath $PanelExe -ArgumentList '--startup' -WorkingDirectory $StageRoot -PassThru
    $healthDeadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $healthDeadline -and $null -eq $health) {
        if ($panel.HasExited) { Write-Output ('RELEASE_PANEL_EXIT=' + $panel.ExitCode); break }
        try {
            $candidateHealth = Invoke-RestMethod ($SmokeBaseUrl + '/health') -TimeoutSec 1
            if ($candidateHealth.desktopCommander -and $candidateHealth.desktopCommander.ready -eq $true) { $health = $candidateHealth; break }
        }
        catch { }
        if ([DateTime]::UtcNow -lt $healthDeadline) { Start-Sleep -Milliseconds 250 }
    }
    if ($null -eq $health) {
        $stageNodeCount = @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith(([IO.Path]::GetFullPath($StageRoot).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) } catch { $false }
        }).Count
        Write-Output ('RELEASE_SMOKE_NODE_COUNT_ON_FAILURE=' + $stageNodeCount)
        $panelErrorLog = Join-Path $SmokeDataRoot 'logs\control-panel-error.log'
        if (Test-Path -LiteralPath $panelErrorLog) { Write-Output 'RELEASE_PANEL_ERROR_LOG_BEGIN'; Get-Content -LiteralPath $panelErrorLog -Tail 30; Write-Output 'RELEASE_PANEL_ERROR_LOG_END' }
        throw 'Release-stage Gateway + Desktop Commander did not become ready within 90 seconds.'
    }
    if ($health.policy.profile -ne 'read-only') { throw "Unexpected profile: $($health.policy.profile)" }
    if ($health.version -ne $Version) { throw "Unexpected Gateway version: $($health.version); expected $Version" }
    $targetNode = [IO.Path]::GetFullPath($NodeExe)
    $gatewayProcess = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        try { [int]$_.ParentProcessId -eq [int]$panel.Id -and $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $targetNode -and $_.CommandLine -match 'dist[\\/]src[\\/]index\.js' } catch { $false }
    })
    if ($gatewayProcess.Count -ne 1) { throw "Expected one Gateway child for the smoke Panel, found $($gatewayProcess.Count)." }
    $desktopCommanderProcess = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        try { [int]$_.ParentProcessId -eq [int]$gatewayProcess[0].ProcessId -and $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $targetNode -and $_.CommandLine -match 'desktop-commander' } catch { $false }
    })
    if ($desktopCommanderProcess.Count -ne 1) { throw "Expected one Desktop Commander child for the smoke Gateway, found $($desktopCommanderProcess.Count)." }
    $OwnedStageNodePids = @([int]$gatewayProcess[0].ProcessId, [int]$desktopCommanderProcess[0].ProcessId)
    $clientEntry = (Join-Path $GatewayRoot 'node_modules\@modelcontextprotocol\client\dist\index.mjs').Replace('\','/')
    $smokeSource = @'
import { pathToFileURL } from 'node:url';
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL('__CLIENT_ENTRY__').href);
const client = new Client({ name: 'deskmcp-release-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('__SMOKE_BASE_URL__/mcp')));
  const listed = await client.listTools();
  console.log('TOOLS=' + listed.tools.length);
  const status = await client.callTool({ name: 'desktop_policy_status', arguments: {} });
  console.log('POLICY_OK=' + (status.isError !== true));
} finally { await client.close().catch(() => {}); }
'@
    $smokeSource.Replace('__CLIENT_ENTRY__', $clientEntry).Replace('__SMOKE_BASE_URL__', $SmokeBaseUrl) | Set-Content -LiteralPath $SmokeFile -Encoding UTF8
    try { $smoke = (& $NodeExe $SmokeFile 2>&1 | Out-String); $smokeExit = $LASTEXITCODE } finally { }
    if ($smokeExit -ne 0 -or $smoke -notmatch 'TOOLS=13' -or $smoke -notmatch 'POLICY_OK=true') { throw "MCP smoke failed:`n$smoke" }
    $before = (Get-Process -Name DeskMCP -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $PanelExe }).Count
    $second = Start-Process -FilePath $PanelExe -WorkingDirectory $StageRoot -PassThru
    [void]$second.WaitForExit(5000)
    Start-Sleep -Milliseconds 500
    $after = (Get-Process -Name DeskMCP -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $PanelExe }).Count
    if ($second.ExitCode -ne 0 -or $before -ne 1 -or $after -ne 1) { throw 'Single-instance validation failed.' }
    Write-Output 'RELEASE_SMOKE_RUNTIME_OK'
    Write-Output ('TARGET=' + $Target)
    Write-Output ('PROFILE=' + $health.policy.profile)
    Write-Output ('VERSION=' + $health.version)
    Write-Output ('STAGE_NODE_COUNT=' + $OwnedStageNodePids.Count)
    Write-Output 'TOOLS=13'
    Write-Output 'SINGLE_INSTANCE=OK'
} finally {
    try {
        if ($panel -and -not $panel.HasExited) {
            Stop-Process -Id $panel.Id -Force -ErrorAction SilentlyContinue
            [void]$panel.WaitForExit(10000)
        }
        if ((Test-Path -LiteralPath $NodeExe) -and (Test-Path -LiteralPath (Join-Path $GatewayRoot 'dist\src\stop.js'))) {
            Push-Location $GatewayRoot
            try { & $NodeExe 'dist\src\stop.js' ([string]$SmokePort) 2>$null | Out-Null } catch { } finally { Pop-Location }
        }
        Wait-SpecificProcessIdsGone $OwnedStageNodePids 15
        if (Test-Path -LiteralPath $SmokeFile) { Remove-Item -LiteralPath $SmokeFile -Force }
    } finally {
        $env:DESKTOP_MCP_DATA_ROOT = $PreviousDataRoot
        $env:DESKTOP_MCP_SETTINGS_DIR = $PreviousSettingsDir
        $env:DESKTOP_MCP_PORT = $PreviousPort
        $env:DESKTOP_MCP_INSTANCE_NAMESPACE = $PreviousInstanceNamespace
        $env:DESKTOP_MCP_STARTUP_LINK_PATH = $PreviousStartupLinkPath
        $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH = $PreviousTunnelProfilePath
        if (Test-Path -LiteralPath $SmokeStateRoot) { Remove-Item -LiteralPath $SmokeStateRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
$ownedLeft = @($OwnedStageNodePids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
if ($ownedLeft.Count -ne 0) { throw "Owned stage Node cleanup failed; remaining=$($ownedLeft -join ',')." }
$RealStartupExistsAfter = Test-Path -LiteralPath $RealStartupLink
$RealStartupHashAfter = if ($RealStartupExistsAfter) { (Get-FileHash -Algorithm SHA256 -LiteralPath $RealStartupLink).Hash } else { $null }
if ($RealStartupExistsAfter -ne $RealStartupExistsBefore -or $RealStartupHashAfter -ne $RealStartupHashBefore) {
    throw 'Release-stage smoke modified the real Windows Startup shortcut.'
}
foreach ($livePid in $LivePanelPidsBefore) {
    if (-not (Get-Process -Id $livePid -ErrorAction SilentlyContinue)) { throw "Release-stage smoke terminated pre-existing DeskMCP process PID $livePid." }
}
foreach ($stagePid in $PreexistingStageProcessIds) {
    if (-not (Get-Process -Id $stagePid -ErrorAction SilentlyContinue)) { throw "Release-stage smoke terminated pre-existing stage process PID $stagePid." }
}
Write-Output 'STAGE_NODE_CLEANUP=OK'
Write-Output 'REAL_STARTUP_SHORTCUT_UNCHANGED=OK'
Write-Output 'PREEXISTING_DESKMCP_PROCESSES_PRESERVED=OK'
$currentStageProcesses = @(Get-StageOwnedProcesses $StageRoot)
if ($PreexistingStageProcessIds.Count -eq 0 -and $currentStageProcesses.Count -eq 0) {
    Invoke-StageRenameLockCheck $StageRoot 10
    Write-Output 'STAGE_RENAME_LOCKCHECK=OK'
} else {
    Write-Output 'STAGE_RENAME_LOCKCHECK=SKIPPED_SHARED_STAGE_BUSY'
}
