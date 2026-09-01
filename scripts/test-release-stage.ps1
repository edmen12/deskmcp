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
$NodeExe = Join-Path $StageRoot 'node\node.exe'
$GatewayRoot = Join-Path $StageRoot 'gateway'
$SmokeFile = Join-Path $GatewayRoot 'release-smoke.mjs'
$SmokeStateRoot = Join-Path $ProjectRoot ('runtime\release-smoke-state\' + $Target + '-' + [Guid]::NewGuid().ToString('N'))
$SmokeDataRoot = Join-Path $SmokeStateRoot 'local'
$SettingsDir = Join-Path $SmokeStateRoot 'roaming'
$SettingsPath = Join-Path $SettingsDir 'settings.json'
$PreviousDataRoot = $env:DESKTOP_MCP_DATA_ROOT
$PreviousSettingsDir = $env:DESKTOP_MCP_SETTINGS_DIR
$PreviousPort = $env:DESKTOP_MCP_PORT
$PreviousInstanceNamespace = $env:DESKTOP_MCP_INSTANCE_NAMESPACE
$SmokeInstanceNamespace = 'release-smoke-' + $Target + '-' + [Guid]::NewGuid().ToString('N')
if (-not (Test-Path -LiteralPath $PanelExe)) { throw 'Release-stage Panel is missing.' }
if (-not (Test-Path -LiteralPath $NodeExe)) { throw 'Release-stage Node is missing.' }
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
function Wait-StageOwnedProcessesGone([string]$Root, [int]$Seconds = 15) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $running = @(Get-StageOwnedProcesses $Root)
        if ($running.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    $details = ($running | ForEach-Object { $_.ProcessName + ':' + $_.Id + ':' + $_.Path }) -join '; '
    throw ('Stage process cleanup timed out: ' + $details)
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
try {
    New-Item -ItemType Directory -Force -Path $SettingsDir | Out-Null
    New-Item -ItemType Directory -Force -Path $SmokeDataRoot | Out-Null
    $smokeSettings = @{ onboardingCompleted = $true; profile = 'read-only'; autoStartTunnel = $false; theme = 'system' } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($SettingsPath, $smokeSettings, [Text.UTF8Encoding]::new($false))
    $env:DESKTOP_MCP_DATA_ROOT = $SmokeDataRoot
    $env:DESKTOP_MCP_SETTINGS_DIR = $SettingsDir
    $env:DESKTOP_MCP_PORT = [string]$SmokePort
    $env:DESKTOP_MCP_INSTANCE_NAMESPACE = $SmokeInstanceNamespace
    Write-Output 'SMOKE_SETTINGS=ISOLATED_TEMPORARY'
    Write-Output ('SMOKE_PORT=' + $SmokePort)
    Write-Output 'SMOKE_INSTANCE_NAMESPACE=ISOLATED'
    $panel = Start-Process -FilePath $PanelExe -ArgumentList '--startup' -WorkingDirectory $StageRoot -PassThru
    $healthDeadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $healthDeadline -and $null -eq $health) {
        if ($panel.HasExited) { Write-Output ('RELEASE_PANEL_EXIT=' + $panel.ExitCode); break }
        try { $health = Invoke-RestMethod ($SmokeBaseUrl + '/health') -TimeoutSec 1 }
        catch { if ([DateTime]::UtcNow -lt $healthDeadline) { Start-Sleep -Milliseconds 250 } }
    }
    if ($null -eq $health) {
        $stageNodeCount = @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith(([IO.Path]::GetFullPath($StageRoot).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) } catch { $false }
        }).Count
        Write-Output ('RELEASE_SMOKE_NODE_COUNT_ON_FAILURE=' + $stageNodeCount)
        $panelErrorLog = Join-Path $SmokeDataRoot 'logs\control-panel-error.log'
        if (Test-Path -LiteralPath $panelErrorLog) { Write-Output 'RELEASE_PANEL_ERROR_LOG_BEGIN'; Get-Content -LiteralPath $panelErrorLog -Tail 30; Write-Output 'RELEASE_PANEL_ERROR_LOG_END' }
        throw 'Release-stage Gateway did not become healthy within 45 seconds.'
    }
    if ($health.policy.profile -ne 'read-only') { throw "Unexpected profile: $($health.policy.profile)" }
    if ($health.version -ne $Version) { throw "Unexpected Gateway version: $($health.version); expected $Version" }
    $targetNode = [IO.Path]::GetFullPath($NodeExe)
    $stageNodes = @()
    foreach ($p in Get-Process -Name node -ErrorAction SilentlyContinue) {
        try { if ($p.Path -and [IO.Path]::GetFullPath($p.Path) -eq $targetNode) { $stageNodes += $p } } catch { }
    }
    if ($stageNodes.Count -ne 2) { throw "Expected 2 stage Node processes, found $($stageNodes.Count)." }
    $smokeSource = @'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const client = new Client({ name: 'deskmcp-release-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('__SMOKE_BASE_URL__/mcp')));
  const listed = await client.listTools();
  console.log('TOOLS=' + listed.tools.length);
  const status = await client.callTool({ name: 'desktop_policy_status', arguments: {} });
  console.log('POLICY_OK=' + (status.isError !== true));
} finally { await client.close().catch(() => {}); }
'@
    $smokeSource.Replace('__SMOKE_BASE_URL__', $SmokeBaseUrl) | Set-Content -LiteralPath $SmokeFile -Encoding UTF8
    Push-Location $GatewayRoot
    try { $smoke = (& $NodeExe $SmokeFile 2>&1 | Out-String); $smokeExit = $LASTEXITCODE } finally { Pop-Location }
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
    Write-Output ('STAGE_NODE_COUNT=' + $stageNodes.Count)
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
        Wait-StageOwnedProcessesGone $StageRoot 15
        if (Test-Path -LiteralPath $SmokeFile) { Remove-Item -LiteralPath $SmokeFile -Force }
    } finally {
        $env:DESKTOP_MCP_DATA_ROOT = $PreviousDataRoot
        $env:DESKTOP_MCP_SETTINGS_DIR = $PreviousSettingsDir
        $env:DESKTOP_MCP_PORT = $PreviousPort
        $env:DESKTOP_MCP_INSTANCE_NAMESPACE = $PreviousInstanceNamespace
        if (Test-Path -LiteralPath $SmokeStateRoot) { Remove-Item -LiteralPath $SmokeStateRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
$left = @()
foreach ($p in Get-Process -Name node -ErrorAction SilentlyContinue) {
    try { if ($p.Path -and [IO.Path]::GetFullPath($p.Path) -eq [IO.Path]::GetFullPath($NodeExe)) { $left += $p } } catch { }
}
if ($left.Count -ne 0) { throw "Stage Node cleanup failed; remaining=$($left.Count)." }
Write-Output 'STAGE_NODE_CLEANUP=OK'
Invoke-StageRenameLockCheck $StageRoot 10
Write-Output 'STAGE_RENAME_LOCKCHECK=OK'
