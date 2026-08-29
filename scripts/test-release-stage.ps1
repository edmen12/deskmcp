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
$SettingsDir = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'DesktopMCP'
$SettingsPath = Join-Path $SettingsDir 'settings.json'
$CreatedSmokeSettings = $false
if (-not (Test-Path -LiteralPath $PanelExe)) { throw 'Release-stage Panel is missing.' }
if (-not (Test-Path -LiteralPath $NodeExe)) { throw 'Release-stage Node is missing.' }
try {
    Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 1 | Out-Null
    throw 'Port 8765 is already in use; release smoke test requires it to be free.'
} catch {
    if ($_.Exception.Message -like 'Port 8765*') { throw }
}
$panel = $null
$health = $null
try {
    if (-not (Test-Path -LiteralPath $SettingsPath)) {
        New-Item -ItemType Directory -Force -Path $SettingsDir | Out-Null
        $smokeSettings = @{ onboardingCompleted = $true; profile = 'read-only'; autoStartTunnel = $false; theme = 'system' } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($SettingsPath, $smokeSettings, [Text.UTF8Encoding]::new($false))
        $CreatedSmokeSettings = $true
        Write-Output 'SMOKE_SETTINGS=TEMPORARY_FRESH_USER'
    } else {
        Write-Output 'SMOKE_SETTINGS=EXISTING_PRESERVED'
    }
    $panel = Start-Process -FilePath $PanelExe -ArgumentList '--startup' -WorkingDirectory $StageRoot -PassThru
    for ($i = 0; $i -lt 90; $i++) {
        try { $health = Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 1; break } catch { Start-Sleep -Milliseconds 500 }
    }
    if ($null -eq $health) { throw 'Release-stage Gateway did not become healthy within 45 seconds.' }
    if ($health.policy.profile -ne 'read-only') { throw "Unexpected profile: $($health.policy.profile)" }
    if ($health.version -ne $Version) { throw "Unexpected Gateway version: $($health.version); expected $Version" }
    $targetNode = [IO.Path]::GetFullPath($NodeExe)
    $stageNodes = @()
    foreach ($p in Get-Process -Name node -ErrorAction SilentlyContinue) {
        try { if ($p.Path -and [IO.Path]::GetFullPath($p.Path) -eq $targetNode) { $stageNodes += $p } } catch { }
    }
    if ($stageNodes.Count -ne 2) { throw "Expected 2 stage Node processes, found $($stageNodes.Count)." }
    @'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const client = new Client({ name: 'deskmcp-release-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8765/mcp')));
  const listed = await client.listTools();
  console.log('TOOLS=' + listed.tools.length);
  const status = await client.callTool({ name: 'desktop_policy_status', arguments: {} });
  console.log('POLICY_OK=' + (status.isError !== true));
} finally { await client.close().catch(() => {}); }
'@ | Set-Content -LiteralPath $SmokeFile -Encoding UTF8
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
    if ($panel -and -not $panel.HasExited) { Stop-Process -Id $panel.Id -Force -ErrorAction SilentlyContinue }
    if ($null -ne $health) {
        Push-Location $GatewayRoot
        try { & $NodeExe 'dist\src\stop.js' 2>$null | Out-Null } catch { } finally { Pop-Location }
    }
    Start-Sleep -Seconds 2
    if (Test-Path -LiteralPath $SmokeFile) { Remove-Item -LiteralPath $SmokeFile -Force }
    if ($CreatedSmokeSettings -and (Test-Path -LiteralPath $SettingsPath)) { Remove-Item -LiteralPath $SettingsPath -Force }
}
$left = @()
foreach ($p in Get-Process -Name node -ErrorAction SilentlyContinue) {
    try { if ($p.Path -and [IO.Path]::GetFullPath($p.Path) -eq [IO.Path]::GetFullPath($NodeExe)) { $left += $p } } catch { }
}
if ($left.Count -ne 0) { throw "Stage Node cleanup failed; remaining=$($left.Count)." }
$stageParent = Split-Path $StageRoot -Parent
$lockCheck = Join-Path $stageParent 'DesktopMCP.lockcheck'
if (Test-Path -LiteralPath $lockCheck) { Remove-Item -LiteralPath $lockCheck -Recurse -Force }
Rename-Item -LiteralPath $StageRoot -NewName 'DesktopMCP.lockcheck'
Rename-Item -LiteralPath $lockCheck -NewName 'DesktopMCP'
Write-Output 'STAGE_NODE_CLEANUP=OK'
Write-Output 'STAGE_RENAME_LOCKCHECK=OK'
