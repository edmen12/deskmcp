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
$PanelManagedDll = Join-Path $StageRoot 'DeskMCP.dll'
$PanelDepsJson = Join-Path $StageRoot 'DeskMCP.deps.json'
$PanelRuntimeConfig = Join-Path $StageRoot 'DeskMCP.runtimeconfig.json'
$ProcessHostExe = Join-Path $StageRoot 'DeskMCP.ProcessHost.exe'
$ProcessHostManagedDll = Join-Path $StageRoot 'DeskMCP.ProcessHost.dll'
$ProcessHostDepsJson = Join-Path $StageRoot 'DeskMCP.ProcessHost.deps.json'
$ProcessHostRuntimeConfig = Join-Path $StageRoot 'DeskMCP.ProcessHost.runtimeconfig.json'
$NodeExe = Join-Path $StageRoot 'node\node.exe'
$GatewayRoot = Join-Path $StageRoot 'gateway'
$WinAppRoot = Join-Path $GatewayRoot 'winapp'
$WinAppExe = Join-Path $WinAppRoot 'winapp.exe'
$WinAppSkia = Join-Path $WinAppRoot 'libSkiaSharp.dll'
$WinAppSums = Join-Path $WinAppRoot 'SHA256SUMS.txt'
$WinAppArchiveSum = Join-Path $WinAppRoot 'UPSTREAM_ARCHIVE_SHA256.txt'
$WinAppVersionFile = Join-Path $WinAppRoot 'VERSION.txt'
$WinAppLicense = Join-Path $StageRoot 'licenses\winappcli\LICENSE.txt'
$AgentDesktopHost = Join-Path $StageRoot 'DeskMCP.AgentDesktopHost.exe'
$VdaRoot = Join-Path $StageRoot 'virtual-desktop-accessor'
$VdaDll = Join-Path $VdaRoot 'VirtualDesktopAccessor.dll'
$VdaLicense = Join-Path $VdaRoot 'LICENSE.txt'
$VdaCommit = Join-Path $VdaRoot 'SOURCE_COMMIT.txt'
$VdaSums = Join-Path $VdaRoot 'SHA256SUMS.txt'
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
$PreviousDisableTunnel = $env:DESKTOP_MCP_DISABLE_TUNNEL
$SmokeInstanceNamespace = 'release-smoke-' + $Target + '-' + [Guid]::NewGuid().ToString('N')
if (-not (Test-Path -LiteralPath $PanelExe)) { throw 'Release-stage Panel is missing.' }
foreach ($forbiddenPanelPayload in @($PanelManagedDll,$PanelDepsJson,$PanelRuntimeConfig)) {
    if (Test-Path -LiteralPath $forbiddenPanelPayload) { throw ('Release-stage Panel is not single-file: ' + $forbiddenPanelPayload) }
}
if (-not (Test-Path -LiteralPath $ProcessHostExe)) { throw 'Release-stage ProcessHost is missing.' }
foreach ($forbiddenProcessHostPayload in @($ProcessHostManagedDll,$ProcessHostDepsJson,$ProcessHostRuntimeConfig)) {
    if (Test-Path -LiteralPath $forbiddenProcessHostPayload) { throw ('Release-stage ProcessHost is not single-file: ' + $forbiddenProcessHostPayload) }
}
if (-not (Test-Path -LiteralPath $NodeExe)) { throw 'Release-stage Node is missing.' }
foreach ($requiredAgentDesktopFile in @($AgentDesktopHost,$VdaDll,$VdaLicense,$VdaCommit,$VdaSums)) {
    if (-not (Test-Path -LiteralPath $requiredAgentDesktopFile)) { throw ('Release-stage Agent Desktop payload is missing: ' + $requiredAgentDesktopFile) }
}
foreach ($requiredWinAppFile in @($WinAppExe,$WinAppSkia,$WinAppSums,$WinAppArchiveSum,$WinAppVersionFile,$WinAppLicense)) {
    if (-not (Test-Path -LiteralPath $requiredWinAppFile)) { throw ('Release-stage computer-use payload is missing: ' + $requiredWinAppFile) }
}
$StageContractPath = Join-Path $StageRoot 'release-target.json'
if (-not (Test-Path -LiteralPath $StageContractPath)) { throw 'Release-stage target contract is missing.' }
$StageContract = Get-Content -LiteralPath $StageContractPath -Raw | ConvertFrom-Json
if ([int]$StageContract.agentSafeIsolationContract -lt 2) { throw 'Release-stage predates the tunnel-isolated agent-safe contract; rebuild the stage before smoke testing.' }
if ([int]$StageContract.processJobObjectContract -lt 1) { throw 'Release-stage predates the owned-process Job Object contract; rebuild the stage before smoke testing.' }
if ([int]$StageContract.computerUseContract -lt 1) { throw 'Release-stage predates the computer-use payload contract; rebuild the stage before smoke testing.' }
if ([int]$StageContract.agentDesktopContract -lt 2) { throw 'Release-stage predates the Agent Desktop pool contract; rebuild the stage before smoke testing.' }
if ([int]$StageContract.agentDesktopPoolContract -lt 1) { throw 'Release-stage predates the multi-desktop Agent pool contract; rebuild the stage before smoke testing.' }
if ([int]$StageContract.browserLeaseLifetimeContract -lt 1) { throw 'Release-stage predates the Agent Browser lease-lifetime contract; rebuild the stage before smoke testing.' }
if ([int]$StageContract.panelSingleFileContract -lt 1) { throw 'Release-stage predates the single-file Panel contract; rebuild the stage before smoke testing.' }
if ([int]$StageContract.processHostSingleFileContract -lt 1) { throw 'Release-stage predates the single-file ProcessHost contract; rebuild the stage before smoke testing.' }
if ([int]$StageContract.trayIconEmbeddedContract -lt 1) { throw 'Release-stage predates the embedded Tray icon contract; rebuild the stage before smoke testing.' }
$trayIconSelfTest = Start-Process -FilePath $PanelExe -ArgumentList '--tray-icon-self-test' -Wait -PassThru
if ($trayIconSelfTest.ExitCode -ne 0) { throw ('Embedded Tray icon self-test failed: exit=' + $trayIconSelfTest.ExitCode) }
Write-Output 'TRAY_ICON_EMBEDDED_SELF_TEST=PASS'
if ([string]$StageContract.virtualDesktopAccessorCommit -ne '8172097993b1194e3d5e2ff38421ebb06f867b6c') { throw ('Unexpected VirtualDesktopAccessor source commit: ' + $StageContract.virtualDesktopAccessorCommit) }
if ([string]$StageContract.winAppVersion -ne [string]$TargetConfig.WinAppVersion) { throw ('Unexpected WinApp version in release-target.json: ' + $StageContract.winAppVersion) }
$vdaCommitText = (Get-Content -LiteralPath $VdaCommit -Raw).Trim()
if ($vdaCommitText -ne '8172097993b1194e3d5e2ff38421ebb06f867b6c') { throw ('VirtualDesktopAccessor SOURCE_COMMIT.txt mismatch: ' + $vdaCommitText) }
$vdaHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $VdaDll).Hash.ToLowerInvariant()
$vdaSumsText = Get-Content -LiteralPath $VdaSums -Raw
if ($vdaSumsText -notmatch [regex]::Escape($vdaHash + '  VirtualDesktopAccessor.dll')) { throw 'VirtualDesktopAccessor SHA256SUMS entry is missing or wrong.' }
if ((Get-Content -LiteralPath $VdaLicense -Raw) -notmatch 'Permission is hereby granted, free of charge') { throw 'VirtualDesktopAccessor MIT license payload is invalid.' }
$previousVdaPath = $env:DESKTOP_MCP_VDA_PATH
try {
    $env:DESKTOP_MCP_VDA_PATH = $VdaDll
    $agentDesktopInfoText = (& $AgentDesktopHost info 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw ('Agent Desktop Host runtime smoke failed: ' + $agentDesktopInfoText) }
    $agentDesktopInfo = $agentDesktopInfoText | ConvertFrom-Json
    if ($agentDesktopInfo.officialApi -ne $true -or $agentDesktopInfo.virtualDesktopAccessor -ne $true) { throw 'Agent Desktop Host runtime smoke did not report both desktop backends.' }
} finally { $env:DESKTOP_MCP_VDA_PATH = $previousVdaPath }
Write-Output 'AGENT_DESKTOP_PAYLOAD_INTEGRITY=OK'
Write-Output ('VDA_COMMIT=' + $vdaCommitText)
$expectedWinAppVersion = $TargetConfig.WinAppVersion.TrimStart('v')
$env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $winAppVersionLines = @(& $WinAppExe --version 2>&1 | ForEach-Object { $_.ToString() })
    $winAppVersionExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
$winAppVersionOutput = ($winAppVersionLines -join [Environment]::NewLine).Trim()
$winAppVersionLine = @($winAppVersionLines | Where-Object { $_ -match '^\s*v?\d+\.\d+\.\d+\s*$' } | Select-Object -First 1)
$actualWinAppVersion = if ($winAppVersionLine.Count -gt 0) { [regex]::Match($winAppVersionLine[0], '\d+\.\d+\.\d+').Value } else { '' }
if ($winAppVersionExit -ne 0 -or $actualWinAppVersion -ne $expectedWinAppVersion) {
    $versionDetail = if ($winAppVersionOutput.Length -gt 800) { $winAppVersionOutput.Substring($winAppVersionOutput.Length - 800) } else { $winAppVersionOutput }
    throw ('WinApp CLI version smoke failed: actual=' + $actualWinAppVersion + ' expected=' + $expectedWinAppVersion + ' output=' + $versionDetail)
}
if ((Get-Content -LiteralPath $WinAppVersionFile -Raw).Trim() -ne $TargetConfig.WinAppVersion) { throw 'WinApp VERSION.txt does not match release target.' }
$winAppSumsText = Get-Content -LiteralPath $WinAppSums -Raw
$winAppExeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $WinAppExe).Hash.ToLowerInvariant()
$winAppSkiaHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $WinAppSkia).Hash.ToLowerInvariant()
if ($winAppSumsText -notmatch [regex]::Escape($winAppExeHash + '  winapp.exe')) { throw 'WinApp winapp.exe SHA256SUMS entry is missing or wrong.' }
if ($winAppSumsText -notmatch [regex]::Escape($winAppSkiaHash + '  libSkiaSharp.dll')) { throw 'WinApp libSkiaSharp.dll SHA256SUMS entry is missing or wrong.' }
$winAppArchiveText = (Get-Content -LiteralPath $WinAppArchiveSum -Raw).Trim()
if ($winAppArchiveText -ne ($TargetConfig.WinAppSha256 + '  ' + $TargetConfig.WinAppAsset)) { throw 'WinApp upstream archive provenance hash is wrong.' }
if ((Get-Content -LiteralPath $WinAppLicense -Raw) -notmatch 'MIT License') { throw 'WinApp MIT license payload is invalid.' }
Write-Output ('WINAPP_VERSION=' + $actualWinAppVersion)
Write-Output 'WINAPP_PAYLOAD_INTEGRITY=OK'
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
    $env:DESKTOP_MCP_DISABLE_TUNNEL = '1'
    Write-Output 'SMOKE_SETTINGS=ISOLATED_TEMPORARY'
    Write-Output ('SMOKE_PORT=' + $SmokePort)
    Write-Output 'SMOKE_INSTANCE_NAMESPACE=ISOLATED'
    Write-Output 'SMOKE_STARTUP_LINK=ISOLATED'
    Write-Output 'SMOKE_TUNNEL_PROFILE=ISOLATED'
    Write-Output 'SMOKE_TUNNEL_RUNTIME=DISABLED'
    $isolationProbe = Start-Process -FilePath $PanelExe -ArgumentList '--agent-safe-isolation-self-test' -WorkingDirectory $StageRoot -Wait -PassThru
    if ($isolationProbe.ExitCode -ne 0) { throw 'Release-stage Panel failed the agent-safe isolation self-test.' }
    Write-Output 'AGENT_SAFE_ISOLATION_CONTRACT=OK'
    $panel = Start-Process -FilePath $PanelExe -ArgumentList '--startup' -WorkingDirectory $StageRoot -PassThru
    $healthDeadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $healthDeadline -and $null -eq $health) {
        if ($panel.HasExited) { Write-Output ('RELEASE_PANEL_EXIT=' + $panel.ExitCode); break }
        try {
            $candidateHealth = Invoke-RestMethod ($SmokeBaseUrl + '/health') -TimeoutSec 1
            if ($candidateHealth.desktopRuntime -and $candidateHealth.desktopRuntime.ready -eq $true) { $health = $candidateHealth; break }
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
        throw 'Release-stage Gateway + DeskMCP backend did not become ready within 90 seconds.'
    }
    if ($health.policy.profile -ne 'read-only') { throw "Unexpected profile: $($health.policy.profile)" }
    if ($health.version -ne $Version) { throw "Unexpected Gateway version: $($health.version); expected $Version" }
    if ($health.computerUse.available -ne $true) { throw 'Release-stage computer-use backend is not available in Gateway health.' }
    if ($health.computerUse.backendVersion -ne $TargetConfig.WinAppVersion) { throw ('Unexpected computer-use backend version: ' + $health.computerUse.backendVersion) }
    if ($health.computerUse.globalSerialization -ne $true -or $health.computerUse.freshObservationRequired -ne $true) { throw 'Computer-use safety contract is incomplete in Gateway health.' }
    if ($health.recoverableTasksEnabled -ne $true -or $health.artifactsEnabled -ne $true -or $health.dynamicMcpHubEnabled -ne $true -or $health.skillsEnabled -ne $true) { throw 'Agent-runtime capabilities are incomplete in Gateway health.' }
    if ($health.agentDesktopEnabled -ne $true) { throw 'Release-stage Agent Desktop manager is not enabled in Gateway health.' }
    if ($null -eq $health.browserAutomation -or $health.browserAutomation.process_ownership -ne 'deskmcp-job-object' -or $health.browserAutomation.profile_isolation -ne $true -or $health.browserAutomation.reuse_existing_cdp -ne $false) { throw 'Browser-runtime safety contract is incomplete in Gateway health.' }
    Write-Output 'BROWSER_RUNTIME_CONTRACT=OK'
    $targetNode = [IO.Path]::GetFullPath($NodeExe)
    $gatewayProcess = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        try { [int]$_.ParentProcessId -eq [int]$panel.Id -and $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $targetNode -and $_.CommandLine -match 'dist[\\/]src[\\/]index\.js' } catch { $false }
    })
    if ($gatewayProcess.Count -ne 1) { throw "Expected one Gateway child for the smoke Panel, found $($gatewayProcess.Count)." }
    $desktopRuntimeProcess = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        try { [int]$_.ParentProcessId -eq [int]$gatewayProcess[0].ProcessId -and $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $targetNode -and $_.CommandLine -match 'dist[\\/]index\.js' } catch { $false }
    })
    if ($desktopRuntimeProcess.Count -ne 1) { throw "Expected one DeskMCP backend child for the smoke Gateway, found $($desktopRuntimeProcess.Count)." }
    $OwnedStageNodePids = @([int]$gatewayProcess[0].ProcessId, [int]$desktopRuntimeProcess[0].ProcessId)
    $stageTunnelCount = @(Get-Process -Name tunnel-client -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith(([IO.Path]::GetFullPath($StageRoot).TrimEnd('\\') + '\\'), [StringComparison]::OrdinalIgnoreCase) } catch { $false } }).Count
    if ($stageTunnelCount -ne 0) { throw "Release-stage smoke started a tunnel-client despite tunnel isolation: count=$stageTunnelCount" }
    Write-Output 'SMOKE_TUNNEL_PROCESS_COUNT=0'
    $clientEntry = (Join-Path $GatewayRoot 'node_modules\@modelcontextprotocol\client\dist\index.mjs').Replace('\','/')
    $smokeSource = @'
import { pathToFileURL } from 'node:url';
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL('__CLIENT_ENTRY__').href);
const client = new Client({ name: 'deskmcp-release-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('__SMOKE_BASE_URL__/mcp')));
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name);
  console.log('TOOLS=' + listed.tools.length);
  console.log('COMPUTER_TOOLS=' + ['desktop_ui_windows','desktop_ui_snapshot','desktop_ui_action'].every(name => names.includes(name)));
  console.log('AGENT_RUNTIME_TOOLS=' + ['desktop_task_manage','desktop_artifact_manage','desktop_mcp_manage','desktop_mcp_tool_search','desktop_mcp_tool_inspect','desktop_mcp_tool_call','desktop_skill_manage'].every(name => names.includes(name)));
  console.log('BROWSER_TOOLS=' + ['desktop_browser_session','desktop_browser_snapshot','desktop_browser_act'].every(name => names.includes(name)));
  console.log('AGENT_DESKTOP_TOOL=' + names.includes('desktop_agent_desktop'));
  const status = await client.callTool({ name: 'desktop_policy_status', arguments: {} });
  console.log('POLICY_OK=' + (status.isError !== true));
  const denied = await client.callTool({ name: 'desktop_ui_windows', arguments: {} });
  console.log('COMPUTER_POLICY_DENY=' + (denied.isError === true));
  const browserDenied = await client.callTool({ name: 'desktop_browser_session', arguments: { action: 'list' } });
  console.log('BROWSER_POLICY_DENY=' + (browserDenied.isError === true));
  const agentDesktopDenied = await client.callTool({ name: 'desktop_agent_desktop', arguments: { action: 'status' } });
  console.log('AGENT_DESKTOP_POLICY_DENY=' + (agentDesktopDenied.isError === true));
  const taskDiscover = await client.callTool({ name: 'desktop_task_manage', arguments: { action: 'context_discover' } });
  console.log('TASK_DISCOVER_OK=' + (taskDiscover.isError !== true));
  const taskCreateDenied = await client.callTool({ name: 'desktop_task_manage', arguments: { action: 'context_create', context_label: 'release-smoke' } });
  console.log('TASK_WRITE_POLICY_DENY=' + (taskCreateDenied.isError === true));
  const skillList = await client.callTool({ name: 'desktop_skill_manage', arguments: { action: 'list' } });
  console.log('SKILL_LIST_OK=' + (skillList.isError !== true));
  const skillInstallDenied = await client.callTool({ name: 'desktop_skill_manage', arguments: { action: 'install', source_path: 'release-smoke-denied' } });
  console.log('SKILL_WRITE_POLICY_DENY=' + (skillInstallDenied.isError === true));
} finally { await client.close().catch(() => {}); }
'@
    $smokeSource.Replace('__CLIENT_ENTRY__', $clientEntry).Replace('__SMOKE_BASE_URL__', $SmokeBaseUrl) | Set-Content -LiteralPath $SmokeFile -Encoding UTF8
    try { $smoke = (& $NodeExe $SmokeFile 2>&1 | Out-String); $smokeExit = $LASTEXITCODE } finally { }
    if ($smokeExit -ne 0 -or $smoke -notmatch 'TOOLS=27' -or $smoke -notmatch 'COMPUTER_TOOLS=true' -or $smoke -notmatch 'AGENT_RUNTIME_TOOLS=true' -or $smoke -notmatch 'BROWSER_TOOLS=true' -or $smoke -notmatch 'AGENT_DESKTOP_TOOL=true' -or $smoke -notmatch 'POLICY_OK=true' -or $smoke -notmatch 'COMPUTER_POLICY_DENY=true' -or $smoke -notmatch 'BROWSER_POLICY_DENY=true' -or $smoke -notmatch 'AGENT_DESKTOP_POLICY_DENY=true' -or $smoke -notmatch 'TASK_DISCOVER_OK=true' -or $smoke -notmatch 'TASK_WRITE_POLICY_DENY=true' -or $smoke -notmatch 'SKILL_LIST_OK=true' -or $smoke -notmatch 'SKILL_WRITE_POLICY_DENY=true') { throw "MCP smoke failed:`n$smoke" }
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
    Write-Output 'TOOLS=27'
    Write-Output 'BROWSER_TOOLS=OK'
    Write-Output 'BROWSER_POLICY_DENY=OK'
    Write-Output 'AGENT_DESKTOP_TOOL=OK'
    Write-Output 'AGENT_DESKTOP_POLICY_DENY=OK'
    Write-Output 'TASK_DISCOVER=OK'
    Write-Output 'TASK_WRITE_POLICY_DENY=OK'
    Write-Output 'SKILL_LIST=OK'
    Write-Output 'SKILL_WRITE_POLICY_DENY=OK'
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
        $env:DESKTOP_MCP_DISABLE_TUNNEL = $PreviousDisableTunnel
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
