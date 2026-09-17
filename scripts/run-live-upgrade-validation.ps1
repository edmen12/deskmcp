param(
    [Parameter(Mandatory=$true)][string]$SetupPath,
    [Parameter(Mandatory=$true)][string]$ExpectedFromVersion,
    [Parameter(Mandatory=$true)][string]$ExpectedToVersion,
    [Parameter(Mandatory=$true)][string]$ExpectedSourceCommit,
    [Parameter(Mandatory=$true)][string]$ExpectedSetupSha256,
    [Parameter(Mandatory=$true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'

function Get-FileState([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [ordered]@{ exists=$false; sha256=$null }
    }
    return [ordered]@{
        exists=$true
        sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    }
}

function Get-InstalledVersion([string]$InstallDir) {
    $packagePath = Join-Path $InstallDir 'gateway\package.json'
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { return $null }
    return [string]((Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version)
}

function Get-InstalledSourceCommit([string]$InstallDir) {
    $contractPath = Join-Path $InstallDir 'release-target.json'
    if (-not (Test-Path -LiteralPath $contractPath -PathType Leaf)) { return $null }
    return ([string]((Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json).sourceCommit)).Trim().ToLowerInvariant()
}

function Same-State($Before,$After) {
    return [bool]($Before.exists -eq $After.exists -and $Before.sha256 -eq $After.sha256)
}

$setup = [IO.Path]::GetFullPath($SetupPath)
$resultFile = [IO.Path]::GetFullPath($ResultPath)
$installDir = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\DesktopMCP'))
$settingsPath = Join-Path $env:APPDATA 'DesktopMCP\settings.json'
$tunnelProfilePath = Join-Path $env:APPDATA 'tunnel-client\desktop-mcp.yaml'
$startupPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)) 'DeskMCP Control Panel.lnk'
$expectedSource = $ExpectedSourceCommit.Trim().ToLowerInvariant()
$expectedSetupHash = $ExpectedSetupSha256.Trim().ToLowerInvariant()

$result = [ordered]@{
    schemaVersion = 1
    startedAtUtc = [DateTime]::UtcNow.ToString('o')
    completedAtUtc = $null
    expectedFromVersion = $ExpectedFromVersion
    expectedToVersion = $ExpectedToVersion
    expectedSourceCommit = $expectedSource
    expectedSetupSha256 = $expectedSetupHash
    setupExitCode = $null
    before = $null
    after = $null
    statePreserved = $false
    success = $false
    error = $null
}

try {
    if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'Setup is missing.' }
    $actualSetupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $setup).Hash.ToLowerInvariant()
    if ($actualSetupHash -ne $expectedSetupHash) { throw ('Setup SHA-256 mismatch: ' + $actualSetupHash) }

    $before = [ordered]@{
        version = Get-InstalledVersion $installDir
        sourceCommit = Get-InstalledSourceCommit $installDir
        settings = Get-FileState $settingsPath
        tunnel = Get-FileState $tunnelProfilePath
        startup = Get-FileState $startupPath
    }
    $result.before = $before
    if ($before.version -ne $ExpectedFromVersion) { throw ('Installed version=' + $before.version + '; expected=' + $ExpectedFromVersion) }

    $process = Start-Process -FilePath $setup -ArgumentList '--install-current-user' -PassThru
    try {
        $process.WaitForExit()
        $result.setupExitCode = $process.ExitCode
    } finally {
        $process.Dispose()
    }
    if ($result.setupExitCode -ne 0) { throw ('Setup exit=' + $result.setupExitCode) }

    $after = [ordered]@{
        version = Get-InstalledVersion $installDir
        sourceCommit = Get-InstalledSourceCommit $installDir
        settings = Get-FileState $settingsPath
        tunnel = Get-FileState $tunnelProfilePath
        startup = Get-FileState $startupPath
    }
    $result.after = $after
    if ($after.version -ne $ExpectedToVersion) { throw ('Installed version after upgrade=' + $after.version + '; expected=' + $ExpectedToVersion) }
    if ($after.sourceCommit -ne $expectedSource) { throw ('Installed source after upgrade=' + $after.sourceCommit + '; expected=' + $expectedSource) }

    $result.statePreserved = (Same-State $before.settings $after.settings) -and (Same-State $before.tunnel $after.tunnel) -and (Same-State $before.startup $after.startup)
    if (-not $result.statePreserved) { throw 'Settings, Tunnel profile, or Startup shortcut changed during live upgrade.' }
    $result.success = $true
} catch {
    $result.error = $_.Exception.GetType().FullName + ': ' + $_.Exception.Message
} finally {
    $result.completedAtUtc = [DateTime]::UtcNow.ToString('o')
    $parent = Split-Path $resultFile -Parent
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($resultFile, ($result | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}

if (-not $result.success) {
    Write-Error ('LIVE_UPGRADE_VALIDATION=FAIL ' + $result.error)
    exit 1
}
Write-Output 'LIVE_UPGRADE_VALIDATION=PASS'
Write-Output ('FROM_VERSION=' + $ExpectedFromVersion)
Write-Output ('TO_VERSION=' + $ExpectedToVersion)
Write-Output ('SOURCE_COMMIT=' + $expectedSource)
Write-Output ('SETUP_SHA256=' + $expectedSetupHash)
Write-Output 'USER_STATE_UNCHANGED=PASS'
exit 0
