param([ValidateSet('win-x64','win-arm64')][string]$Target = 'win-x64',[string]$SetupPath)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-targets.ps1')
$TargetConfig = Get-DeskMcpReleaseTarget $Target
$Version = [string]((Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version)
$Setup = if ([string]::IsNullOrWhiteSpace($SetupPath)) { Join-Path (Join-Path $ProjectRoot 'runtime\release') (Get-DeskMcpSetupName $Version $TargetConfig) } else { [IO.Path]::GetFullPath($SetupPath) }
$RunId = $Target + '-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
# Keep the isolated install root short enough that the installer's sibling
# .install-<GUID> / .backup-<GUID> directories do not manufacture a test-only
# MAX_PATH failure. The production install root is fixed and shorter still.
$SmokeParent = Join-Path $ProjectRoot ('runtime\ir\' + $RunId)
$SmokeRoot = Join-Path $SmokeParent 'D'
$StateRoot = Join-Path $ProjectRoot ('runtime\irs\' + $RunId)
$DataRoot = Join-Path $StateRoot 'local'
$SettingsDir = Join-Path $StateRoot 'roaming'
$SettingsPath = Join-Path $SettingsDir 'settings.json'
$StartupDir = Join-Path $StateRoot 'startup'
$StartupLink = Join-Path $StartupDir 'DeskMCP Control Panel.lnk'
$TunnelProfileDir = Join-Path $StateRoot 'tunnel-profile'
$TunnelProfile = Join-Path $TunnelProfileDir 'desktop-mcp.yaml'
$expectedHostArch = if ($Target -eq 'win-arm64') { 'ARM64' } else { 'AMD64' }
if ([string]$env:PROCESSOR_ARCHITECTURE -ne $expectedHostArch) { throw ('Installer release test for ' + $Target + ' requires native host architecture ' + $expectedHostArch + '.') }

function Require([bool]$Condition,[string]$Message){ if(-not $Condition){ throw $Message } }
function Wait-Gone([string]$Path){ for($i=0;$i -lt 25;$i++){ if(-not(Test-Path -LiteralPath $Path)){ return }; Start-Sleep -Seconds 1 }; throw "Path remained: $Path" }
function Get-FreeLoopbackPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); return ([Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}
function Get-OptionalFileState([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Exists=$false; Hash=$null } }
    return [pscustomobject]@{ Exists=$true; Hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash }
}
function Require-UnchangedFileState([string]$Label,[string]$Path,[object]$Before) {
    $after = Get-OptionalFileState $Path
    Require ($after.Exists -eq $Before.Exists -and $after.Hash -eq $Before.Hash) ($Label + ' changed during isolated installer release test.')
}

Require (Test-Path -LiteralPath $Setup) 'Setup is missing.'
$RealStartupLink = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)) 'DeskMCP Control Panel.lnk'
$RealSettingsPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'DesktopMCP\settings.json'
$RealTunnelProfile = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'tunnel-client\desktop-mcp.yaml'
$RealStartupBefore = Get-OptionalFileState $RealStartupLink
$RealSettingsBefore = Get-OptionalFileState $RealSettingsPath
$RealTunnelBefore = Get-OptionalFileState $RealTunnelProfile
$LivePanelPidsBefore = @(Get-Process -Name DeskMCP -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

$PreviousDataRoot = $env:DESKTOP_MCP_DATA_ROOT
$PreviousSettingsDir = $env:DESKTOP_MCP_SETTINGS_DIR
$PreviousPort = $env:DESKTOP_MCP_PORT
$PreviousInstanceNamespace = $env:DESKTOP_MCP_INSTANCE_NAMESPACE
$PreviousStartupLinkPath = $env:DESKTOP_MCP_STARTUP_LINK_PATH
$PreviousTunnelProfilePath = $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH
$PreviousInstallerMutexNamespace = $env:DESKTOP_MCP_INSTALLER_MUTEX_NAMESPACE
$TestPort = Get-FreeLoopbackPort
$TestBaseUrl = 'http://127.0.0.1:' + $TestPort
$panel = $null
$health = $null
$p = $null
$u = $null
$x = $null
try {
    New-Item -ItemType Directory -Force -Path $SmokeParent,$DataRoot,$SettingsDir,$StartupDir,$TunnelProfileDir | Out-Null
    $smokeSettings = @{ onboardingCompleted=$true; profile='read-only'; autoStartTunnel=$false; theme='system'; workspace=(Join-Path $StateRoot 'workspace') } | ConvertTo-Json -Compress
    New-Item -ItemType Directory -Force -Path (Join-Path $StateRoot 'workspace') | Out-Null
    [IO.File]::WriteAllText($SettingsPath,$smokeSettings,[Text.UTF8Encoding]::new($false))
    $env:DESKTOP_MCP_DATA_ROOT = $DataRoot
    $env:DESKTOP_MCP_SETTINGS_DIR = $SettingsDir
    $env:DESKTOP_MCP_PORT = [string]$TestPort
    $env:DESKTOP_MCP_INSTANCE_NAMESPACE = 'installer-release-' + $RunId
    $env:DESKTOP_MCP_STARTUP_LINK_PATH = $StartupLink
    $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH = $TunnelProfile
    $env:DESKTOP_MCP_INSTALLER_MUTEX_NAMESPACE = 'installer-release-' + $RunId
    Write-Output 'INSTALLER_RELEASE_STATE=ISOLATED'
    Write-Output ('INSTALLER_RELEASE_PORT=' + $TestPort)

    Write-Output 'TEST=install'
    $p=Start-Process -FilePath $Setup -ArgumentList @('--install-test',('"'+$SmokeRoot+'"')) -Wait -PassThru
    Require ($p.ExitCode -eq 0) "Install exit=$($p.ExitCode)"
    Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'DeskMCP.exe')) 'Panel missing.'
    Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'DeskMCPUninstaller.exe')) 'Uninstaller missing.'
    Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'node\node.exe')) 'Node missing.'
    Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'LICENSE')) 'Apache-2.0 project LICENSE missing.'
    Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'THIRD_PARTY_NOTICES.md')) 'Third-party notices missing.'
    Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\production-node-packages.csv')) 'Production Node license inventory missing.'
    Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\dotnet\LICENSE.txt')) '.NET distribution license missing.'
    Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\dotnet\ThirdPartyNotices.txt')) '.NET third-party notices missing.'
    $installedContractPath = Join-Path $SmokeRoot 'release-target.json'
    Require (Test-Path -LiteralPath $installedContractPath) 'Installed agent-safe release contract is missing.'
    $installedContract = Get-Content -LiteralPath $installedContractPath -Raw | ConvertFrom-Json
    Require ([int]$installedContract.agentSafeIsolationContract -ge 1) 'Setup predates the agent-safe isolation contract; refusing to start its runtime or uninstaller.'
    Write-Output 'INSTALLER_AGENT_SAFE_ISOLATION_CONTRACT=OK'

    $rollbackMarker=Join-Path $SmokeRoot 'ROLLBACK_MARKER.txt'
    Set-Content -LiteralPath $rollbackMarker -Value 'old-install-must-survive' -Encoding ASCII
    Write-Output 'TEST=upgrade-failure-rollback'
    $failed=Start-Process -FilePath $Setup -ArgumentList @('--install-test-fail-after-backup',('"'+$SmokeRoot+'"')) -Wait -PassThru
    Require ($failed.ExitCode -eq 10) "Injected rollback test exit=$($failed.ExitCode)"
    Require (Test-Path -LiteralPath $rollbackMarker) 'Failed upgrade did not restore previous install.'
    Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'DeskMCP.exe')) 'Failed upgrade left install missing.'

    $marker=Join-Path $SmokeRoot 'UPGRADE_MARKER.txt'
    Set-Content -LiteralPath $marker -Value 'old' -Encoding ASCII
    Write-Output 'TEST=upgrade'
    $u=Start-Process -FilePath $Setup -ArgumentList @('--install-test',('"'+$SmokeRoot+'"')) -Wait -PassThru
    Require ($u.ExitCode -eq 0) "Upgrade exit=$($u.ExitCode)"
    Require (-not(Test-Path -LiteralPath $marker)) 'Upgrade marker survived.'
    Require (@(Get-ChildItem -LiteralPath $SmokeParent -Directory -Filter 'DesktopMCP.backup-*' -ErrorAction SilentlyContinue).Count -eq 0) 'Backup directory remained.'
    Require (@(Get-ChildItem -LiteralPath $SmokeParent -Directory -Filter 'DesktopMCP.install-*' -ErrorAction SilentlyContinue).Count -eq 0) 'Install temp remained.'

    Write-Output 'TEST=interrupted-upgrade-recovery'
    $recoveryMarker=Join-Path $SmokeRoot 'RECOVERY_MARKER.txt'
    Set-Content -LiteralPath $recoveryMarker -Value 'restore-me' -Encoding ASCII
    $simBackup=$SmokeRoot+'.backup-simulated'
    $simTemp=$SmokeRoot+'.install-simulated'
    Move-Item -LiteralPath $SmokeRoot -Destination $simBackup
    New-Item -ItemType Directory -Path $simTemp | Out-Null
    Set-Content -LiteralPath (Join-Path $simTemp 'partial.txt') -Value 'partial' -Encoding ASCII
    $recover=Start-Process -FilePath $Setup -ArgumentList @('--recover-test',('"'+$SmokeRoot+'"')) -Wait -PassThru
    Require ($recover.ExitCode -eq 0) "Recovery exit=$($recover.ExitCode)"
    Require (Test-Path -LiteralPath $recoveryMarker) 'Interrupted upgrade backup was not restored.'
    Require (-not(Test-Path -LiteralPath $simBackup)) 'Recovery backup directory remained.'
    Require (-not(Test-Path -LiteralPath $simTemp)) 'Recovery temp directory remained.'

    Write-Output 'TEST=runtime'
    $panelPath=Join-Path $SmokeRoot 'DeskMCP.exe'
    $panel=Start-Process -FilePath $panelPath -ArgumentList '--startup' -WorkingDirectory $SmokeRoot -PassThru
    for($i=0;$i -lt 90;$i++){
        if($panel.HasExited){ break }
        try{$health=Invoke-RestMethod ($TestBaseUrl + '/health') -TimeoutSec 1; break}catch{Start-Sleep -Milliseconds 500}
    }
    Require ($null -ne $health) 'Installed Gateway did not become healthy.'
    Require ($health.version -eq $Version) "Version=$($health.version); expected=$Version"
    Require ($health.policy.profile -eq 'read-only') "Profile=$($health.policy.profile)"
    $nodePath=[IO.Path]::GetFullPath((Join-Path $SmokeRoot 'node\node.exe'))
    $nodes=@(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { try{ $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $nodePath }catch{$false} })
    Require ($nodes.Count -eq 2) "Installed node count=$($nodes.Count)"

    Write-Output 'TEST=uninstall'
    $uninstaller=Join-Path $SmokeRoot 'DeskMCPUninstaller.exe'
    $x=Start-Process -FilePath $uninstaller -ArgumentList @('--test-root',('"'+$SmokeRoot+'"')) -Wait -PassThru
    Require ($x.ExitCode -eq 0) "Uninstall exit=$($x.ExitCode)"
    Wait-Gone $SmokeRoot
    $left=@(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { try{ $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $nodePath }catch{$false} })
    Require ($left.Count -eq 0) "Installed node cleanup left=$($left.Count)"
    try{ Invoke-RestMethod ($TestBaseUrl + '/health') -TimeoutSec 1 | Out-Null; throw 'Gateway remained online.' }catch{ if($_.Exception.Message -like 'Gateway remained*'){ throw } }
} finally {
    if ($panel -and -not $panel.HasExited) { Stop-Process -Id $panel.Id -Force -ErrorAction SilentlyContinue }
    $env:DESKTOP_MCP_DATA_ROOT = $PreviousDataRoot
    $env:DESKTOP_MCP_SETTINGS_DIR = $PreviousSettingsDir
    $env:DESKTOP_MCP_PORT = $PreviousPort
    $env:DESKTOP_MCP_INSTANCE_NAMESPACE = $PreviousInstanceNamespace
    $env:DESKTOP_MCP_STARTUP_LINK_PATH = $PreviousStartupLinkPath
    $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH = $PreviousTunnelProfilePath
    $env:DESKTOP_MCP_INSTALLER_MUTEX_NAMESPACE = $PreviousInstallerMutexNamespace
    if (Test-Path -LiteralPath $StateRoot) { Remove-Item -LiteralPath $StateRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $SmokeParent) { Remove-Item -LiteralPath $SmokeParent -Recurse -Force -ErrorAction SilentlyContinue }
}

Require-UnchangedFileState 'Real Startup shortcut' $RealStartupLink $RealStartupBefore
Require-UnchangedFileState 'Real DeskMCP settings' $RealSettingsPath $RealSettingsBefore
Require-UnchangedFileState 'Real Tunnel profile' $RealTunnelProfile $RealTunnelBefore
foreach ($livePid in $LivePanelPidsBefore) { Require ([bool](Get-Process -Id $livePid -ErrorAction SilentlyContinue)) "Installer release test terminated pre-existing DeskMCP PID $livePid." }
$setupHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $Setup).Hash.ToLowerInvariant()
Write-Output 'INSTALLER_RELEASE_TEST_OK'
Write-Output ('TARGET='+$Target)
Write-Output ('SETUP_SHA256='+$setupHash)
Write-Output ('INSTALL_EXIT='+$p.ExitCode)
Write-Output ('UPGRADE_EXIT='+$u.ExitCode)
Write-Output ('UNINSTALL_EXIT='+$x.ExitCode)
Write-Output 'RUNTIME_PROFILE=read-only'
Write-Output ('RUNTIME_VERSION='+$Version)
Write-Output 'INSTALLED_NODE_CLEANUP=OK'
Write-Output 'REAL_USER_STATE_UNCHANGED=OK'
Write-Output 'PREEXISTING_DESKMCP_PROCESSES_PRESERVED=OK'
