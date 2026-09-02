param([switch]$SkipStage,[ValidateSet('win-x64','win-arm64')][string]$Target = 'win-x64')
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-targets.ps1')
$TargetConfig = Get-DeskMcpReleaseTarget $Target
$RuntimeRoot = Join-Path $ProjectRoot 'runtime'
$StageRoot = Get-DeskMcpStageRoot $ProjectRoot $Target
$InstallerRoot = Join-Path $ProjectRoot 'installer'
$BuildRoot = Join-Path $RuntimeRoot ('installer\' + $Target)
$ReleaseRoot = Join-Path $RuntimeRoot 'release'
$SmokeRunId = $Target + '-' + [guid]::NewGuid().ToString('N')
$SmokeRoot = Join-Path $RuntimeRoot ('install-smoke\' + $SmokeRunId + '\DesktopMCP')
$InstallerSource = Join-Path $InstallerRoot 'DeskMCPInstaller.cs'
$UninstallerSource = Join-Path $InstallerRoot 'DeskMCPUninstaller.cs'
$UninstallerExe = Join-Path $BuildRoot 'DeskMCPUninstaller.exe'
$PayloadZip = Join-Path $BuildRoot 'DesktopMCP-payload.zip'
$PayloadHashFile = Join-Path $BuildRoot 'DesktopMCP-payload.sha256'
$BrandIcon = Join-Path $ProjectRoot 'assets\brand\DeskMCP.ico'
$PackageVersion = [string]((Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version)
$expectedHostArch = if ($Target -eq 'win-arm64') { 'ARM64' } else { 'AMD64' }
if ([string]$env:PROCESSOR_ARCHITECTURE -ne $expectedHostArch) { throw ('Installer smoke for ' + $Target + ' requires native host architecture ' + $expectedHostArch + '.') }

function Require([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Assert-StageNotRunning([string]$StagePath) {
    if (-not (Test-Path -LiteralPath $StagePath)) { return }
    $prefix = [IO.Path]::GetFullPath($StagePath).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
    if ($running.Count -gt 0) {
        $ids = ($running | ForEach-Object { $_.ProcessName + ':' + $_.Id }) -join ', '
        throw ('Release stage is running (' + $ids + '). Quit DeskMCP from the tray before building; no stage files were changed.')
    }
}
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe failed with exit code $LASTEXITCODE" }
}
function Wait-PathGone([string]$Path, [int]$Seconds = 20) {
    for ($i = 0; $i -lt $Seconds; $i++) {
        if (-not (Test-Path -LiteralPath $Path)) { return }
        Start-Sleep -Seconds 1
    }
    throw "Path was not removed: $Path"
}
function Get-FreeLoopbackPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}
function Invoke-IsolatedInstallerTest([string]$Exe, [string[]]$Arguments, [string]$Label) {
    $previousPort = $env:DESKTOP_MCP_PORT
    $previousNamespace = $env:DESKTOP_MCP_INSTANCE_NAMESPACE
    $previousLog = $env:DESKTOP_MCP_INSTALL_TEST_LOG
    $previousInstallerMutexNamespace = $env:DESKTOP_MCP_INSTALLER_MUTEX_NAMESPACE
    $safeLabel = [regex]::Replace($Label, '[^A-Za-z0-9_.-]', '-')
    $logPath = Join-Path $BuildRoot ('installer-test-' + $safeLabel + '.log')
    if (Test-Path -LiteralPath $logPath) { Remove-Item -LiteralPath $logPath -Force }
    $process = $null
    try {
        $env:DESKTOP_MCP_PORT = [string](Get-FreeLoopbackPort)
        $env:DESKTOP_MCP_INSTANCE_NAMESPACE = 'installer-test-' + $Target + '-' + [guid]::NewGuid().ToString('N')
        $env:DESKTOP_MCP_INSTALLER_MUTEX_NAMESPACE = 'installer-test-' + $Target + '-' + [guid]::NewGuid().ToString('N')
        $env:DESKTOP_MCP_INSTALL_TEST_LOG = $logPath
        $process = Start-Process -FilePath $Exe -ArgumentList $Arguments -Wait -PassThru
    } finally {
        $env:DESKTOP_MCP_PORT = $previousPort
        $env:DESKTOP_MCP_INSTANCE_NAMESPACE = $previousNamespace
        $env:DESKTOP_MCP_INSTALLER_MUTEX_NAMESPACE = $previousInstallerMutexNamespace
        $env:DESKTOP_MCP_INSTALL_TEST_LOG = $previousLog
    }
    $diagnostic = if (Test-Path -LiteralPath $logPath) { (Get-Content -LiteralPath $logPath -Raw).Trim() } else { '' }
    if (Test-Path -LiteralPath $logPath) { Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Diagnostic = $diagnostic }
}
function Require-InstallerTest([object]$Result, [int]$ExpectedExitCode, [string]$Label) {
    if ($Result.ExitCode -eq $ExpectedExitCode) { return }
    if (-not [string]::IsNullOrWhiteSpace([string]$Result.Diagnostic)) {
        Write-Output ('INSTALLER_TEST_DIAGNOSTIC=' + [string]$Result.Diagnostic)
    }
    throw ($Label + ' failed: ' + $Result.ExitCode)
}
New-Item -ItemType Directory -Force -Path $BuildRoot, $ReleaseRoot | Out-Null
Assert-StageNotRunning $StageRoot
Require (Test-Path -LiteralPath $InstallerSource) 'Installer source is missing.'
Require (Test-Path -LiteralPath $UninstallerSource) 'Uninstaller source is missing.'
Require (Test-Path -LiteralPath $BrandIcon) 'DeskMCP brand icon is missing.'

if (-not $SkipStage) {
    Write-Output 'STEP=release-stage-build'
    & (Join-Path $PSScriptRoot 'build-release-stage.ps1') -Target $Target
    Write-Output 'STEP=release-stage-smoke'
    & (Join-Path $PSScriptRoot 'test-release-stage.ps1') -Target $Target
} else {
    Write-Output 'STEP=release-stage-skip'
    Require (Test-Path -LiteralPath $StageRoot) 'Release stage is missing.'
}

$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
Require ([bool]$csc) 'Windows .NET Framework C# compiler was not found.'

Write-Output 'STEP=compile-uninstaller'
Invoke-Native $csc @(
    '/nologo', '/target:winexe', ('/platform:' + $TargetConfig.CscPlatform), '/optimize+',
    ('/win32icon:' + $BrandIcon), ('/out:' + $UninstallerExe), '/reference:System.Windows.Forms.dll',
    $UninstallerSource
)
Require (Test-Path -LiteralPath $UninstallerExe) 'Uninstaller build output is missing.'
Copy-Item -LiteralPath $UninstallerExe -Destination (Join-Path $StageRoot 'DeskMCPUninstaller.exe') -Force
Write-Output 'STEP=payload-integrity-manifest'
$targetContract = Get-Content -LiteralPath (Join-Path $StageRoot 'release-target.json') -Raw | ConvertFrom-Json
Require ([int]$targetContract.agentSafeIsolationContract -ge 1) 'Release stage predates the agent-safe isolation contract; rebuild it before packaging.'
Require ([int]$targetContract.processJobObjectContract -ge 1) 'Release stage predates the owned-process Job Object contract; rebuild it before packaging.'
$tunnelRelative = Join-Path ('tunnel-client\' + [string]$targetContract.tunnelVersion) 'bin\tunnel-client.exe'
$integrityRelatives = @(
    'DeskMCP.exe',
    'DeskMCP.ProcessHost.exe',
    'DeskMCP.ProcessHost.dll',
    'DeskMCP.ProcessHost.deps.json',
    'DeskMCP.ProcessHost.runtimeconfig.json',
    'Panel.xaml',
    'node\node.exe',
    'gateway\dist\src\index.js',
    'release-target.json',
    'DeskMCPUninstaller.exe',
    $tunnelRelative
)
$integrityLines = foreach ($relative in $integrityRelatives) {
    $full = Join-Path $StageRoot $relative
    Require (Test-Path -LiteralPath $full) ('Integrity-protected payload file is missing: ' + $relative)
    ((Get-FileHash -Algorithm SHA256 -LiteralPath $full).Hash.ToLowerInvariant() + '  ' + $relative.Replace('\','/'))
}
[IO.File]::WriteAllLines((Join-Path $StageRoot 'install-integrity.sha256'), $integrityLines, [Text.Encoding]::ASCII)
Write-Output 'STEP=package-payload'
if (Test-Path -LiteralPath $PayloadZip) { Remove-Item -LiteralPath $PayloadZip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory(
    $StageRoot, $PayloadZip, [IO.Compression.CompressionLevel]::Optimal, $false
)
$payloadHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PayloadZip).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($PayloadHashFile, $payloadHash, [Text.Encoding]::ASCII)
Require ((Get-Item -LiteralPath $PayloadZip).Length -gt 1MB) 'Payload ZIP is unexpectedly small.'

$installerText = Get-Content -LiteralPath $InstallerSource -Raw
$versionMatch = [regex]::Match($installerText, 'public const string Version = "([^"]+)"')
Require $versionMatch.Success 'Could not read installer version from source.'
$version = $versionMatch.Groups[1].Value
Require ($version -eq $PackageVersion) "Installer version $version does not match package version $PackageVersion."
$SetupExe = Join-Path $ReleaseRoot (Get-DeskMcpSetupName $version $TargetConfig)

Write-Output 'STEP=compile-setup'
Invoke-Native $csc @(
    '/nologo', '/target:winexe', ('/platform:' + $TargetConfig.CscPlatform), '/optimize+',
    ('/win32icon:' + $BrandIcon), ('/out:' + $SetupExe), '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    ('/resource:' + $PayloadZip + ',DesktopMCP.Payload.zip'),
    ('/resource:' + $PayloadHashFile + ',DesktopMCP.Payload.sha256'),
    $InstallerSource
)
Require (Test-Path -LiteralPath $SetupExe) 'Setup build output is missing.'
Write-Output 'STEP=installer-smoke-single-instance'
$mutexProbeRoot = Join-Path $RuntimeRoot ('installer-mutex-probe\' + $Target + '-' + [guid]::NewGuid().ToString('N'))
$mutexReady = Join-Path $mutexProbeRoot 'ready.txt'
$mutexRelease = Join-Path $mutexProbeRoot 'release.txt'
New-Item -ItemType Directory -Force -Path $mutexProbeRoot | Out-Null
$previousMutexProbeNamespace = $env:DESKTOP_MCP_INSTALLER_MUTEX_NAMESPACE
$env:DESKTOP_MCP_INSTALLER_MUTEX_NAMESPACE = 'installer-mutex-probe-' + $Target + '-' + [guid]::NewGuid().ToString('N')
$mutexHolder = Start-Process -FilePath $SetupExe -ArgumentList @('--mutex-test-hold', ('"' + $mutexReady + '"'), ('"' + $mutexRelease + '"')) -PassThru
$mutexHolderClean = $false
try {
    $mutexDeadline = [DateTime]::UtcNow.AddSeconds(45)
    $mutexHandshake = $null
    while ($mutexHandshake -ne 'ready') {
        if ($mutexHolder.HasExited) { throw ('Setup mutex holder exited before readiness: ' + $mutexHolder.ExitCode) }
        if (Test-Path -LiteralPath $mutexReady) {
            try {
                $mutexReadyText = Get-Content -LiteralPath $mutexReady -Raw -ErrorAction Stop
                if ($null -ne $mutexReadyText) { $mutexHandshake = $mutexReadyText.Trim() }
            } catch {
                $mutexHandshake = $null
            }
        }
        if ($mutexHandshake -eq 'ready') { break }
        if ([DateTime]::UtcNow -ge $mutexDeadline) { throw 'Setup mutex holder did not provide a valid readiness handshake within 45 seconds.' }
        Start-Sleep -Milliseconds 100
    }
    $mutexBlocked = Start-Process -FilePath $SetupExe -ArgumentList '--mutex-test-hold' -Wait -PassThru
    Require ($mutexBlocked.ExitCode -eq 11) ('Second Setup instance was not rejected: ' + $mutexBlocked.ExitCode)
    [IO.File]::WriteAllText($mutexRelease, 'release', [Text.Encoding]::ASCII)
    [void]$mutexHolder.WaitForExit(5000)
    $mutexHolderClean = $mutexHolder.HasExited -and $mutexHolder.ExitCode -eq 0
} finally {
    if (-not $mutexHolder.HasExited) { Stop-Process -Id $mutexHolder.Id -Force -ErrorAction SilentlyContinue }
    $env:DESKTOP_MCP_INSTALLER_MUTEX_NAMESPACE = $previousMutexProbeNamespace
    if (Test-Path -LiteralPath $mutexProbeRoot) { Remove-Item -LiteralPath $mutexProbeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
Require $mutexHolderClean 'Setup mutex holder did not finish cleanly.'
Write-Output 'INSTALLER_SINGLE_INSTANCE=OK'
Write-Output 'STEP=installer-smoke-clean'
if (Test-Path -LiteralPath $SmokeRoot) {
    $oldUninstaller = @(
        (Join-Path $SmokeRoot 'DeskMCPUninstaller.exe'),
        (Join-Path $SmokeRoot 'DesktopMCPUninstaller.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($oldUninstaller) {
        $old = Start-Process -FilePath $oldUninstaller -ArgumentList @('--test-root', ('"' + $SmokeRoot + '"')) -Wait -PassThru
        Require ($old.ExitCode -eq 0) "Old smoke uninstall failed: $($old.ExitCode)"
        Wait-PathGone $SmokeRoot 20
    } else {
        Remove-Item -LiteralPath $SmokeRoot -Recurse -Force
    }
}

Write-Output 'STEP=installer-smoke-install'
$install = Invoke-IsolatedInstallerTest $SetupExe @('--install-test', ('"' + $SmokeRoot + '"')) 'clean-install'
Require-InstallerTest $install 0 'Smoke install'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'DeskMCP.exe')) 'Installed Panel is missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'DeskMCPUninstaller.exe')) 'Installed Uninstaller is missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'node\node.exe')) 'Installed Node is missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'LICENSE')) 'Installed Apache-2.0 project LICENSE is missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'THIRD_PARTY_NOTICES.md')) 'Installed third-party notices are missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\production-node-packages.csv')) 'Installed production license inventory is missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\dotnet\ThirdPartyNotices.txt')) 'Installed .NET third-party notices are missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\dotnet\LICENSE.txt')) 'Installed .NET license is missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\dotnet\ThirdPartyNotices.txt')) 'Installed .NET notices are missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'install-integrity.sha256')) 'Installed integrity manifest is missing.'

$rollbackMarker = Join-Path $SmokeRoot 'ROLLBACK_OLD_MARKER.txt'
[IO.File]::WriteAllText($rollbackMarker, 'old-install-must-survive', [Text.Encoding]::ASCII)
Write-Output 'STEP=installer-smoke-rollback'
$failedUpgrade = Invoke-IsolatedInstallerTest $SetupExe @('--install-test-fail-after-backup', ('"' + $SmokeRoot + '"')) 'rollback-injected-failure'
Require-InstallerTest $failedUpgrade 10 'Injected rollback test'
Require (Test-Path -LiteralPath $rollbackMarker) 'Failed upgrade did not restore the previous install.'

$marker = Join-Path $SmokeRoot 'UPGRADE_OLD_MARKER.txt'
[IO.File]::WriteAllText($marker, 'old-install-marker', [Text.Encoding]::ASCII)
Write-Output 'STEP=installer-smoke-upgrade'
$upgrade = Invoke-IsolatedInstallerTest $SetupExe @('--install-test', ('"' + $SmokeRoot + '"')) 'upgrade'
Require-InstallerTest $upgrade 0 'Smoke upgrade'
Require (-not (Test-Path -LiteralPath $marker)) 'Upgrade did not atomically replace the old install.'
$smokeParent = Split-Path $SmokeRoot -Parent
$backupDirs = @(Get-ChildItem -LiteralPath $smokeParent -Directory -Filter 'DesktopMCP.backup-*' -ErrorAction SilentlyContinue)
$tempDirs = @(Get-ChildItem -LiteralPath $smokeParent -Directory -Filter 'DesktopMCP.install-*' -ErrorAction SilentlyContinue)
Require ($backupDirs.Count -eq 0) 'Upgrade left a backup directory behind.'
Require ($tempDirs.Count -eq 0) 'Upgrade left an install temp directory behind.'

Write-Output 'STEP=installer-smoke-interrupted-recovery'
$recoveryMarker = Join-Path $SmokeRoot 'RECOVERY_MARKER.txt'
[IO.File]::WriteAllText($recoveryMarker, 'restore-me', [Text.Encoding]::ASCII)
$simBackup = $SmokeRoot + '.backup-simulated'
$simTemp = $SmokeRoot + '.install-simulated'
Move-Item -LiteralPath $SmokeRoot -Destination $simBackup
New-Item -ItemType Directory -Path $simTemp | Out-Null
[IO.File]::WriteAllText((Join-Path $simTemp 'partial.txt'), 'partial', [Text.Encoding]::ASCII)
New-Item -ItemType Directory -Force -Path $SmokeRoot, (Join-Path $SmokeRoot 'node'), (Join-Path $SmokeRoot 'gateway\dist\src') | Out-Null
Copy-Item -LiteralPath (Join-Path $simBackup 'install-integrity.sha256') -Destination (Join-Path $SmokeRoot 'install-integrity.sha256')
Copy-Item -LiteralPath (Join-Path $simBackup 'release-target.json') -Destination (Join-Path $SmokeRoot 'release-target.json')
foreach ($relative in @('DeskMCP.exe','Panel.xaml','node\node.exe','gateway\dist\src\index.js','DeskMCPUninstaller.exe')) {
    [IO.File]::WriteAllText((Join-Path $SmokeRoot $relative), 'corrupt-but-present', [Text.Encoding]::ASCII)
}
$corruptContract = Get-Content -LiteralPath (Join-Path $SmokeRoot 'release-target.json') -Raw | ConvertFrom-Json
$corruptTunnel = Join-Path $SmokeRoot ('tunnel-client\' + [string]$corruptContract.tunnelVersion + '\bin\tunnel-client.exe')
New-Item -ItemType Directory -Force -Path (Split-Path $corruptTunnel -Parent) | Out-Null
[IO.File]::WriteAllText($corruptTunnel, 'corrupt-but-present', [Text.Encoding]::ASCII)
$recovery = Invoke-IsolatedInstallerTest $SetupExe @('--recover-test', ('"' + $SmokeRoot + '"')) 'interrupted-recovery'
Require-InstallerTest $recovery 0 'Interrupted recovery'
Require (Test-Path -LiteralPath $recoveryMarker) 'Interrupted recovery did not restore the prior install.'
Require (-not (Test-Path -LiteralPath $simBackup)) 'Interrupted recovery left backup state behind.'
Require (-not (Test-Path -LiteralPath $simTemp)) 'Interrupted recovery left temp state behind.'

$installerSmokeStateRoot = Join-Path $RuntimeRoot ('installer-smoke-state\' + $Target + '-' + [guid]::NewGuid().ToString('N'))
$installerSmokeDataRoot = Join-Path $installerSmokeStateRoot 'local'
$settingsDir = Join-Path $installerSmokeStateRoot 'roaming'
$settingsPath = Join-Path $settingsDir 'settings.json'
$installerSmokeStartupDir = Join-Path $installerSmokeStateRoot 'startup'
$installerSmokeStartupLink = Join-Path $installerSmokeStartupDir 'DeskMCP Control Panel.lnk'
$installerSmokeTunnelProfileDir = Join-Path $installerSmokeStateRoot 'tunnel-profile'
$installerSmokeTunnelProfile = Join-Path $installerSmokeTunnelProfileDir 'desktop-mcp.yaml'
$realStartupLink = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)) 'DeskMCP Control Panel.lnk'
$realStartupExistsBefore = Test-Path -LiteralPath $realStartupLink
$realStartupHashBefore = if ($realStartupExistsBefore) { (Get-FileHash -Algorithm SHA256 -LiteralPath $realStartupLink).Hash } else { $null }
$livePanelPidsBefore = @(Get-Process -Name DeskMCP -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$previousDataRoot = $env:DESKTOP_MCP_DATA_ROOT
$previousSettingsDir = $env:DESKTOP_MCP_SETTINGS_DIR
$previousPort = $env:DESKTOP_MCP_PORT
$previousInstanceNamespace = $env:DESKTOP_MCP_INSTANCE_NAMESPACE
$previousStartupLinkPath = $env:DESKTOP_MCP_STARTUP_LINK_PATH
$previousTunnelProfilePath = $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH
$installerSmokePort = Get-FreeLoopbackPort
$installerSmokeBaseUrl = 'http://127.0.0.1:' + $installerSmokePort
$installerSmokeInstanceNamespace = 'installer-smoke-' + $Target + '-' + [guid]::NewGuid().ToString('N')
$panel = $null
$health = $null
try {
    New-Item -ItemType Directory -Force -Path $settingsDir, $installerSmokeDataRoot, $installerSmokeStartupDir, $installerSmokeTunnelProfileDir | Out-Null
    $smokeSettings = @{ onboardingCompleted = $true; profile = 'read-only'; autoStartTunnel = $false; theme = 'system' } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($settingsPath, $smokeSettings, [Text.UTF8Encoding]::new($false))
    $env:DESKTOP_MCP_DATA_ROOT = $installerSmokeDataRoot
    $env:DESKTOP_MCP_SETTINGS_DIR = $settingsDir
    $env:DESKTOP_MCP_PORT = [string]$installerSmokePort
    $env:DESKTOP_MCP_INSTANCE_NAMESPACE = $installerSmokeInstanceNamespace
    $env:DESKTOP_MCP_STARTUP_LINK_PATH = $installerSmokeStartupLink
    $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH = $installerSmokeTunnelProfile
    Write-Output 'INSTALLER_SMOKE_SETTINGS=ISOLATED_TEMPORARY'
    Write-Output ('INSTALLER_SMOKE_PORT=' + $installerSmokePort)
    Write-Output 'INSTALLER_SMOKE_INSTANCE_NAMESPACE=ISOLATED'
    Write-Output 'INSTALLER_SMOKE_STARTUP_LINK=ISOLATED'
    Write-Output 'INSTALLER_SMOKE_TUNNEL_PROFILE=ISOLATED'

    Write-Output 'STEP=installer-smoke-runtime'
    $installedPanel = Join-Path $SmokeRoot 'DeskMCP.exe'
    $panel = Start-Process -FilePath $installedPanel -ArgumentList '--startup' -WorkingDirectory $SmokeRoot -PassThru
    $healthDeadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $healthDeadline -and $null -eq $health) {
        if ($panel.HasExited) { Write-Output ('INSTALLER_PANEL_EXIT=' + $panel.ExitCode); break }
        try { $health = Invoke-RestMethod ($installerSmokeBaseUrl + '/health') -TimeoutSec 1 }
        catch { if ([DateTime]::UtcNow -lt $healthDeadline) { Start-Sleep -Milliseconds 250 } }
    }
    if ($null -eq $health) {
        $ownedNodes = @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith(([IO.Path]::GetFullPath($SmokeRoot).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) } catch { $false }
        })
        Write-Output ('INSTALLER_SMOKE_NODE_COUNT=' + $ownedNodes.Count)
        $panelErrorLog = Join-Path $installerSmokeDataRoot 'logs\control-panel-error.log'
        if (Test-Path -LiteralPath $panelErrorLog) { Write-Output 'INSTALLER_PANEL_ERROR_LOG_BEGIN'; Get-Content -LiteralPath $panelErrorLog -Tail 30; Write-Output 'INSTALLER_PANEL_ERROR_LOG_END' }
    }
    Require ($null -ne $health) 'Installed Gateway did not become healthy within 45 seconds.'
    Require ($health.policy.profile -eq 'read-only') "Unexpected installed profile: $($health.policy.profile)"
    Require ($health.version -eq $version) "Unexpected installed Gateway version: $($health.version); expected $version"

    Write-Output 'STEP=installer-smoke-uninstall'
    $installedUninstaller = Join-Path $SmokeRoot 'DeskMCPUninstaller.exe'
    $uninstall = Start-Process -FilePath $installedUninstaller -ArgumentList @('--test-root', ('"' + $SmokeRoot + '"')) -Wait -PassThru
    Require ($uninstall.ExitCode -eq 0) "Smoke uninstall failed: $($uninstall.ExitCode)"
    Wait-PathGone $SmokeRoot 20
    try { Invoke-RestMethod ($installerSmokeBaseUrl + '/health') -TimeoutSec 1 | Out-Null; throw 'Gateway remained online after uninstall.' }
    catch { if ($_.Exception.Message -like 'Gateway remained*') { throw } }
} finally {
    if ($panel -and -not $panel.HasExited) { Stop-Process -Id $panel.Id -Force -ErrorAction SilentlyContinue }
    $env:DESKTOP_MCP_DATA_ROOT = $previousDataRoot
    $env:DESKTOP_MCP_SETTINGS_DIR = $previousSettingsDir
    $env:DESKTOP_MCP_PORT = $previousPort
    $env:DESKTOP_MCP_INSTANCE_NAMESPACE = $previousInstanceNamespace
    $env:DESKTOP_MCP_STARTUP_LINK_PATH = $previousStartupLinkPath
    $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH = $previousTunnelProfilePath
    if (Test-Path -LiteralPath $installerSmokeStateRoot) { try { [IO.Directory]::Delete($installerSmokeStateRoot, $true) } catch { } }
}
$realStartupExistsAfter = Test-Path -LiteralPath $realStartupLink
$realStartupHashAfter = if ($realStartupExistsAfter) { (Get-FileHash -Algorithm SHA256 -LiteralPath $realStartupLink).Hash } else { $null }
Require ($realStartupExistsAfter -eq $realStartupExistsBefore -and $realStartupHashAfter -eq $realStartupHashBefore) 'Installer smoke modified the real Windows Startup shortcut.'
foreach ($livePid in $livePanelPidsBefore) {
    Require ([bool](Get-Process -Id $livePid -ErrorAction SilentlyContinue)) "Installer smoke terminated pre-existing DeskMCP process PID $livePid."
}
Write-Output 'INSTALLER_REAL_STARTUP_SHORTCUT_UNCHANGED=OK'
Write-Output 'INSTALLER_PREEXISTING_DESKMCP_PROCESSES_PRESERVED=OK'

$setupItem = Get-Item -LiteralPath $SetupExe
$setupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SetupExe).Hash.ToLowerInvariant()
$payloadItem = Get-Item -LiteralPath $PayloadZip
Write-Output 'STEP=release-metadata'
& (Join-Path $PSScriptRoot 'write-release-metadata.ps1') -SetupPath $SetupExe -Version $version -Target $Target
Write-Output 'INSTALLER_BUILD_OK'
Write-Output ('VERSION=' + $version)
Write-Output ('TARGET=' + $Target)
Write-Output ('PAYLOAD_MB=' + [math]::Round($payloadItem.Length / 1MB, 1))
Write-Output ('PAYLOAD_SHA256=' + $payloadHash)
Write-Output ('SETUP=' + $SetupExe)
Write-Output ('SETUP_MB=' + [math]::Round($setupItem.Length / 1MB, 1))
Write-Output ('SETUP_SHA256=' + $setupHash)
Write-Output ('INSTALL_EXIT=' + $install.ExitCode)
Write-Output ('UPGRADE_EXIT=' + $upgrade.ExitCode)
Write-Output ('UNINSTALL_EXIT=' + $uninstall.ExitCode)
Write-Output 'INSTALLER_SMOKE=OK'
