param([ValidateSet('win-x64','win-arm64')][string]$Target = 'win-x64')
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-targets.ps1')
$TargetConfig = Get-DeskMcpReleaseTarget $Target
$Version = [string]((Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version)
$Setup = Join-Path (Join-Path $ProjectRoot 'runtime\release') (Get-DeskMcpSetupName $Version $TargetConfig)
$SmokeRoot = Join-Path $ProjectRoot ('runtime\install-smoke\' + $Target + '\DesktopMCP')
$expectedHostArch = if ($Target -eq 'win-arm64') { 'ARM64' } else { 'AMD64' }
if ([string]$env:PROCESSOR_ARCHITECTURE -ne $expectedHostArch) { throw ('Installer release test for ' + $Target + ' requires native host architecture ' + $expectedHostArch + '.') }
function Require([bool]$Condition,[string]$Message){ if(-not $Condition){ throw $Message } }
function Wait-Gone([string]$Path){ for($i=0;$i -lt 25;$i++){ if(-not(Test-Path -LiteralPath $Path)){ return }; Start-Sleep -Seconds 1 }; throw "Path remained: $Path" }
Require (Test-Path -LiteralPath $Setup) 'Setup is missing.'
if(Test-Path -LiteralPath $SmokeRoot){ Remove-Item -LiteralPath $SmokeRoot -Recurse -Force }
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
$parent=Split-Path $SmokeRoot -Parent
Require (@(Get-ChildItem -LiteralPath $parent -Directory -Filter 'DesktopMCP.backup-*' -ErrorAction SilentlyContinue).Count -eq 0) 'Backup directory remained.'
Require (@(Get-ChildItem -LiteralPath $parent -Directory -Filter 'DesktopMCP.install-*' -ErrorAction SilentlyContinue).Count -eq 0) 'Install temp remained.'

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
$settingsDir = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'DesktopMCP'
$settingsPath = Join-Path $settingsDir 'settings.json'
$createdInstallerSmokeSettings = $false
$panel = $null
$health = $null
try {
    if (-not (Test-Path -LiteralPath $settingsPath)) {
        New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
        $smokeSettings = @{ onboardingCompleted = $true; profile = 'read-only'; autoStartTunnel = $false; theme = 'system' } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($settingsPath, $smokeSettings, [Text.UTF8Encoding]::new($false))
        $createdInstallerSmokeSettings = $true
        Write-Output 'INSTALLER_SMOKE_SETTINGS=TEMPORARY_FRESH_USER'
    } else {
        Write-Output 'INSTALLER_SMOKE_SETTINGS=EXISTING_PRESERVED'
    }

    Write-Output 'TEST=runtime'
    $panelPath=Join-Path $SmokeRoot 'DeskMCP.exe'
    $panel=Start-Process -FilePath $panelPath -ArgumentList '--startup' -WorkingDirectory $SmokeRoot -PassThru
    for($i=0;$i -lt 90;$i++){ try{$health=Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 1; break}catch{Start-Sleep -Milliseconds 500} }
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
    try{ Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 1 | Out-Null; throw 'Gateway remained online.' }catch{ if($_.Exception.Message -like 'Gateway remained*'){ throw } }
} finally {
    if ($panel -and -not $panel.HasExited) { Stop-Process -Id $panel.Id -Force -ErrorAction SilentlyContinue }
    if ($createdInstallerSmokeSettings -and (Test-Path -LiteralPath $settingsPath)) { Remove-Item -LiteralPath $settingsPath -Force }
}
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
