param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$Cleanup = Join-Path $PSScriptRoot 'cleanup-runtime.ps1'
$Fixture = Join-Path $ProjectRoot ('test-area\runtime-cleanup-' + [guid]::NewGuid().ToString('N'))
$Old = [DateTime]::UtcNow.AddDays(-10)
$Recent = [DateTime]::UtcNow

function Require([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

try {
    New-Item -ItemType Directory -Force -Path $Fixture | Out-Null

    $staleSmoke = Join-Path $Fixture 'i\stale-run'
    $recentSmoke = Join-Path $Fixture 'i\recent-run'
    $cache = Join-Path $Fixture 'downloads\node-cache'
    $legacy = Join-Path $Fixture 'live-gate-old'
    foreach ($path in @($staleSmoke,$recentSmoke,$cache,$legacy)) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
        [IO.File]::WriteAllText((Join-Path $path 'marker.txt'), 'x')
    }
    (Get-Item -LiteralPath $staleSmoke).LastWriteTimeUtc = $Old
    (Get-Item -LiteralPath $legacy).LastWriteTimeUtc = $Old
    (Get-Item -LiteralPath $recentSmoke).LastWriteTimeUtc = $Recent
    (Get-Item -LiteralPath $cache).LastWriteTimeUtc = $Old

    $dry = & $Cleanup -RuntimeRoot $Fixture -OlderThanDays 3 -Scope transient 2>&1 | Out-String
    Require ($LASTEXITCODE -eq 0) 'Dry-run cleanup failed.'
    Require ($dry -match 'RUNTIME_CLEANUP_CANDIDATES=1') 'Dry-run did not identify exactly one transient candidate.'
    Require (Test-Path -LiteralPath $staleSmoke) 'Dry-run deleted stale smoke data.'
    Require (Test-Path -LiteralPath $recentSmoke) 'Dry-run deleted recent smoke data.'
    Require (Test-Path -LiteralPath $cache) 'Dry-run deleted reusable cache data.'
    Require (Test-Path -LiteralPath $legacy) 'Transient scope deleted legacy diagnostics.'

    $apply = & $Cleanup -RuntimeRoot $Fixture -OlderThanDays 3 -Scope transient -Apply 2>&1 | Out-String
    Require ($LASTEXITCODE -eq 0) 'Apply cleanup failed.'
    Require ($apply -match 'RUNTIME_CLEANUP_DELETED=1') 'Apply cleanup did not delete exactly one transient candidate.'
    Require (-not (Test-Path -LiteralPath $staleSmoke)) 'Stale smoke data was not deleted.'
    Require (Test-Path -LiteralPath $recentSmoke) 'Recent smoke data was deleted.'
    Require (Test-Path -LiteralPath $cache) 'Reusable cache data was deleted.'
    Require (Test-Path -LiteralPath $legacy) 'Legacy data was deleted without opt-in.'

    $legacyApply = & $Cleanup -RuntimeRoot $Fixture -OlderThanDays 3 -Scope legacy -Apply 2>&1 | Out-String
    Require ($LASTEXITCODE -eq 0) 'Legacy cleanup failed.'
    Require ($legacyApply -match 'RUNTIME_CLEANUP_DELETED=1') 'Legacy cleanup did not delete exactly one candidate.'
    Require (-not (Test-Path -LiteralPath $legacy)) 'Opt-in legacy cleanup did not remove the stale legacy directory.'
    Require (Test-Path -LiteralPath $cache) 'Legacy cleanup deleted reusable cache data.'

    Write-Output 'RUNTIME_CLEANUP_TEST=PASS'
}
finally {
    if (Test-Path -LiteralPath $Fixture) {
        Remove-Item -LiteralPath $Fixture -Recurse -Force -ErrorAction SilentlyContinue
    }
}
