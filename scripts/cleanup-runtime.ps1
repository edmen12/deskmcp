param(
    [string]$RuntimeRoot = (Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime'),
    [ValidateRange(0, 3650)]
    [int]$OlderThanDays = 3,
    [ValidateSet('transient','legacy','all')]
    [string]$Scope = 'transient',
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'

function Resolve-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path)
}

function Test-IsOlderThanCutoff([IO.FileSystemInfo]$Item, [datetime]$Cutoff) {
    return $Item.LastWriteTimeUtc -lt $Cutoff
}

function Add-Candidate(
    [Collections.Generic.List[object]]$Rows,
    [IO.FileSystemInfo]$Item,
    [string]$Kind
) {
    $Rows.Add([pscustomobject]@{
        Kind = $Kind
        Path = $Item.FullName
        LastWriteUtc = $Item.LastWriteTimeUtc.ToString('o')
    })
}

$root = Resolve-FullPath $RuntimeRoot
if (-not (Test-Path -LiteralPath $root)) {
    Write-Output ('RUNTIME_CLEANUP_ROOT_MISSING=' + $root)
    exit 0
}

$rootItem = Get-Item -LiteralPath $root -Force
if (-not $rootItem.PSIsContainer) {
    throw "RuntimeRoot is not a directory: $root"
}

$cutoff = [DateTime]::UtcNow.AddDays(-$OlderThanDays)
$candidates = [Collections.Generic.List[object]]::new()

# These parents are created by DeskMCP's normal smoke/test scripts. Their children
# are run-scoped scratch directories and are never release inputs or reusable caches.
$transientParents = @(
    'i',
    'ir',
    'irs',
    'installer-mutex-probe',
    'installer-owned-wrapper-probe',
    'installer-smoke-state',
    'release-smoke-state',
    'agent-safe-multi-client',
    'agent-safe-process-pressure',
    'agent-safe-stability'
)

if ($Scope -in @('transient','all')) {
    foreach ($name in $transientParents) {
        $parent = Join-Path $root $name
        if (-not (Test-Path -LiteralPath $parent)) { continue }
        foreach ($child in Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue) {
            if (Test-IsOlderThanCutoff $child $cutoff) {
                Add-Candidate $candidates $child ('transient:' + $name)
            }
        }
    }

    foreach ($file in Get-ChildItem -LiteralPath $root -Force -File -ErrorAction SilentlyContinue) {
        if ($file.Name -like 'installer-lock-tree-*.pid' -and (Test-IsOlderThanCutoff $file $cutoff)) {
            Add-Candidate $candidates $file 'transient:lock-tree-pid'
        }
    }
}

# Historical ad-hoc validation/candidate directories from pre-retention DeskMCP
# development. They are intentionally opt-in because they may contain useful
# diagnostics from an older investigation.
if ($Scope -in @('legacy','all')) {
    $legacyPatterns = @(
        'isolated-*',
        'recovery-verify-*',
        'live-gate-*',
        'release-candidate-*',
        'fresh-build-check*',
        'upgrade-race-repro*',
        'arm64-probe*',
        'browser-e2e*',
        'chrome-*',
        'agent-desktop-native-e2e*',
        'candidate-*',
        'previous-*',
        'final-candidate-*',
        '*-publish'
    )
    foreach ($item in Get-ChildItem -LiteralPath $root -Force -Directory -ErrorAction SilentlyContinue) {
        $matches = $false
        foreach ($pattern in $legacyPatterns) {
            if ($item.Name -like $pattern) { $matches = $true; break }
        }
        if ($matches -and (Test-IsOlderThanCutoff $item $cutoff)) {
            Add-Candidate $candidates $item 'legacy'
        }
    }
}

$ordered = @($candidates | Sort-Object Path -Unique)
Write-Output ('RUNTIME_CLEANUP_ROOT=' + $root)
Write-Output ('RUNTIME_CLEANUP_SCOPE=' + $Scope)
Write-Output ('RUNTIME_CLEANUP_CUTOFF_UTC=' + $cutoff.ToString('o'))
Write-Output ('RUNTIME_CLEANUP_MODE=' + $(if ($Apply) { 'APPLY' } else { 'DRY_RUN' }))
Write-Output ('RUNTIME_CLEANUP_CANDIDATES=' + $ordered.Count)

foreach ($row in $ordered) {
    Write-Output ('RUNTIME_CLEANUP_CANDIDATE kind=' + $row.Kind + ' path=' + $row.Path + ' last_write_utc=' + $row.LastWriteUtc)
}

if (-not $Apply) {
    Write-Output 'RUNTIME_CLEANUP=DRY_RUN_COMPLETE'
    exit 0
}

$deleted = 0
foreach ($row in $ordered) {
    if (-not (Test-Path -LiteralPath $row.Path)) { continue }
    Remove-Item -LiteralPath $row.Path -Recurse -Force
    $deleted++
}

if ($Scope -in @('transient','all')) {
    foreach ($name in $transientParents) {
        $parent = Join-Path $root $name
        if (-not (Test-Path -LiteralPath $parent)) { continue }
        if (@(Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue).Count -eq 0) {
            Remove-Item -LiteralPath $parent -Force
        }
    }
}

Write-Output ('RUNTIME_CLEANUP_DELETED=' + $deleted)
Write-Output 'RUNTIME_CLEANUP=PASS'
