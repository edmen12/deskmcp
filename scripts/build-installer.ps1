param([switch]$SkipStage)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = Join-Path $ProjectRoot 'runtime'
$StageRoot = Join-Path $RuntimeRoot 'release-stage\DesktopMCP'
$InstallerRoot = Join-Path $ProjectRoot 'installer'
$BuildRoot = Join-Path $RuntimeRoot 'installer'
$ReleaseRoot = Join-Path $RuntimeRoot 'release'
$SmokeRoot = Join-Path $RuntimeRoot 'install-smoke\DesktopMCP'
$InstallerSource = Join-Path $InstallerRoot 'DeskMCPInstaller.cs'
$UninstallerSource = Join-Path $InstallerRoot 'DeskMCPUninstaller.cs'
$UninstallerExe = Join-Path $BuildRoot 'DeskMCPUninstaller.exe'
$PayloadZip = Join-Path $BuildRoot 'DesktopMCP-payload.zip'
$PayloadHashFile = Join-Path $BuildRoot 'DesktopMCP-payload.sha256'
$BrandIcon = Join-Path $ProjectRoot 'assets\brand\DeskMCP.ico'
$PackageVersion = [string]((Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version)

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
New-Item -ItemType Directory -Force -Path $BuildRoot, $ReleaseRoot | Out-Null
Assert-StageNotRunning $StageRoot
Require (Test-Path -LiteralPath $InstallerSource) 'Installer source is missing.'
Require (Test-Path -LiteralPath $UninstallerSource) 'Uninstaller source is missing.'
Require (Test-Path -LiteralPath $BrandIcon) 'DeskMCP brand icon is missing.'

if (-not $SkipStage) {
    Write-Output 'STEP=release-stage-build'
    & (Join-Path $PSScriptRoot 'build-release-stage.ps1')
    Write-Output 'STEP=release-stage-smoke'
    & (Join-Path $PSScriptRoot 'test-release-stage.ps1')
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
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    ('/win32icon:' + $BrandIcon), ('/out:' + $UninstallerExe), '/reference:System.Windows.Forms.dll',
    $UninstallerSource
)
Require (Test-Path -LiteralPath $UninstallerExe) 'Uninstaller build output is missing.'
Copy-Item -LiteralPath $UninstallerExe -Destination (Join-Path $StageRoot 'DeskMCPUninstaller.exe') -Force
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
$SetupExe = Join-Path $ReleaseRoot ("DeskMCP-Setup-$version.exe")

Write-Output 'STEP=compile-setup'
Invoke-Native $csc @(
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    ('/win32icon:' + $BrandIcon), ('/out:' + $SetupExe), '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    ('/resource:' + $PayloadZip + ',DesktopMCP.Payload.zip'),
    ('/resource:' + $PayloadHashFile + ',DesktopMCP.Payload.sha256'),
    $InstallerSource
)
Require (Test-Path -LiteralPath $SetupExe) 'Setup build output is missing.'
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
$install = Start-Process -FilePath $SetupExe -ArgumentList @('--install-test', ('"' + $SmokeRoot + '"')) -Wait -PassThru
Require ($install.ExitCode -eq 0) "Smoke install failed: $($install.ExitCode)"
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'DeskMCP.exe')) 'Installed Panel is missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'DeskMCPUninstaller.exe')) 'Installed Uninstaller is missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'node\node.exe')) 'Installed Node is missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'LICENSE')) 'Installed Apache-2.0 project LICENSE is missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'THIRD_PARTY_NOTICES.md')) 'Installed third-party notices are missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\production-node-packages.csv')) 'Installed production license inventory is missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\dotnet\ThirdPartyNotices.txt')) 'Installed .NET third-party notices are missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\dotnet\LICENSE.txt')) 'Installed .NET license is missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\dotnet\ThirdPartyNotices.txt')) 'Installed .NET notices are missing.'

$rollbackMarker = Join-Path $SmokeRoot 'ROLLBACK_OLD_MARKER.txt'
[IO.File]::WriteAllText($rollbackMarker, 'old-install-must-survive', [Text.Encoding]::ASCII)
Write-Output 'STEP=installer-smoke-rollback'
$failedUpgrade = Start-Process -FilePath $SetupExe -ArgumentList @('--install-test-fail-after-backup', ('"' + $SmokeRoot + '"')) -Wait -PassThru
Require ($failedUpgrade.ExitCode -eq 10) "Injected rollback test failed: $($failedUpgrade.ExitCode)"
Require (Test-Path -LiteralPath $rollbackMarker) 'Failed upgrade did not restore the previous install.'

$marker = Join-Path $SmokeRoot 'UPGRADE_OLD_MARKER.txt'
[IO.File]::WriteAllText($marker, 'old-install-marker', [Text.Encoding]::ASCII)
Write-Output 'STEP=installer-smoke-upgrade'
$upgrade = Start-Process -FilePath $SetupExe -ArgumentList @('--install-test', ('"' + $SmokeRoot + '"')) -Wait -PassThru
Require ($upgrade.ExitCode -eq 0) "Smoke upgrade failed: $($upgrade.ExitCode)"
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
$recovery = Start-Process -FilePath $SetupExe -ArgumentList @('--recover-test', ('"' + $SmokeRoot + '"')) -Wait -PassThru
Require ($recovery.ExitCode -eq 0) "Interrupted recovery failed: $($recovery.ExitCode)"
Require (Test-Path -LiteralPath $recoveryMarker) 'Interrupted recovery did not restore the prior install.'
Require (-not (Test-Path -LiteralPath $simBackup)) 'Interrupted recovery left backup state behind.'
Require (-not (Test-Path -LiteralPath $simTemp)) 'Interrupted recovery left temp state behind.'

Write-Output 'STEP=installer-smoke-runtime'
$installedPanel = Join-Path $SmokeRoot 'DeskMCP.exe'
$panel = Start-Process -FilePath $installedPanel -ArgumentList '--startup' -WorkingDirectory $SmokeRoot -PassThru
$health = $null
for ($i = 0; $i -lt 90; $i++) {
    try { $health = Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 1; break }
    catch { Start-Sleep -Milliseconds 500 }
}
Require ($null -ne $health) 'Installed Gateway did not become healthy within 45 seconds.'
Require ($health.policy.profile -eq 'read-only') "Unexpected installed profile: $($health.policy.profile)"
Require ($health.version -eq $version) "Unexpected installed Gateway version: $($health.version); expected $version"

Write-Output 'STEP=installer-smoke-uninstall'
$installedUninstaller = Join-Path $SmokeRoot 'DeskMCPUninstaller.exe'
$uninstall = Start-Process -FilePath $installedUninstaller -ArgumentList @('--test-root', ('"' + $SmokeRoot + '"')) -Wait -PassThru
Require ($uninstall.ExitCode -eq 0) "Smoke uninstall failed: $($uninstall.ExitCode)"
Wait-PathGone $SmokeRoot 20
try { Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 1 | Out-Null; throw 'Gateway remained online after uninstall.' }
catch { if ($_.Exception.Message -like 'Gateway remained*') { throw }
 }
$setupItem = Get-Item -LiteralPath $SetupExe
$setupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SetupExe).Hash.ToLowerInvariant()
$payloadItem = Get-Item -LiteralPath $PayloadZip
Write-Output 'STEP=release-metadata'
& (Join-Path $PSScriptRoot 'write-release-metadata.ps1') -SetupPath $SetupExe -Version $version -Target 'win-x64'
Write-Output 'INSTALLER_BUILD_OK'
Write-Output ('VERSION=' + $version)
Write-Output ('PAYLOAD_MB=' + [math]::Round($payloadItem.Length / 1MB, 1))
Write-Output ('PAYLOAD_SHA256=' + $payloadHash)
Write-Output ('SETUP=' + $SetupExe)
Write-Output ('SETUP_MB=' + [math]::Round($setupItem.Length / 1MB, 1))
Write-Output ('SETUP_SHA256=' + $setupHash)
Write-Output ('INSTALL_EXIT=' + $install.ExitCode)
Write-Output ('UPGRADE_EXIT=' + $upgrade.ExitCode)
Write-Output ('UNINSTALL_EXIT=' + $uninstall.ExitCode)
Write-Output 'INSTALLER_SMOKE=OK'
