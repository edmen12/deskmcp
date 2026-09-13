param(
    [Parameter(Mandatory=$true)][string]$ProjectRoot,
    [Parameter(Mandatory=$true)][string]$Version
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)

function Short-Hash([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '<unknown>' }
    return $Value.Substring(0, [Math]::Min(12, $Value.Length))
}

$git = Get-Command git -ErrorAction SilentlyContinue
if ($null -eq $git) {
    Write-Output 'Git is unavailable; cannot prove that this release version is unused.'
    exit 2
}

$headLines = @(& $git.Source -C $ProjectRoot rev-parse HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or $headLines.Count -eq 0 -or [string]::IsNullOrWhiteSpace([string]$headLines[0])) {
    Write-Output 'Could not resolve the current Git commit; refusing public release readiness.'
    exit 2
}
$head = ([string]$headLines[0]).Trim()
$tag = 'v' + $Version
$tagRef = 'refs/tags/' + $tag

& $git.Source -C $ProjectRoot show-ref --verify --quiet $tagRef
$localTagExit = $LASTEXITCODE
if ($localTagExit -eq 0) {
    $tagLines = @(& $git.Source -C $ProjectRoot rev-parse --verify ($tagRef + '^{commit}') 2>$null)
    if ($LASTEXITCODE -ne 0 -or $tagLines.Count -eq 0 -or [string]::IsNullOrWhiteSpace([string]$tagLines[0])) {
        Write-Output ('Existing ' + $tag + ' tag could not be resolved to a commit; refusing public release readiness.')
        exit 2
    }
    $tagCommit = ([string]$tagLines[0]).Trim()
    if ($tagCommit -ne $head) {
        Write-Output ('Release version ' + $Version + ' is already tagged at ' + (Short-Hash $tagCommit) + '; current source is ' + (Short-Hash $head) + '. Bump the version instead of rebuilding an existing release.')
        exit 2
    }
    Write-Output ('Release version ' + $Version + ' matches existing tag ' + $tag + ' at this exact commit.')
    exit 0
}
if ($localTagExit -ne 1) {
    Write-Output ('Could not inspect local Git tag state for ' + $tag + '; refusing public release readiness.')
    exit 2
}

$remoteLines = @(& $git.Source -C $ProjectRoot ls-remote --tags origin $tagRef ($tagRef + '^{}') 2>$null)
if ($LASTEXITCODE -ne 0) {
    Write-Output ('Could not verify ' + $tag + ' against origin; refusing public release readiness.')
    exit 2
}
if ($remoteLines.Count -eq 0) {
    Write-Output ('Release version ' + $Version + ' has no existing origin tag collision.')
    exit 0
}

$peeled = @($remoteLines | Where-Object { $_ -match '\^\{\}$' } | Select-Object -First 1)
$selected = if ($peeled.Count -gt 0) { [string]$peeled[0] } else { [string]$remoteLines[0] }
$remoteCommit = ($selected -split '\s+')[0].Trim()
if ([string]::IsNullOrWhiteSpace($remoteCommit)) {
    Write-Output ('Origin returned an unreadable commit for ' + $tag + '; refusing public release readiness.')
    exit 2
}
if ($remoteCommit -ne $head) {
    Write-Output ('Release version ' + $Version + ' already exists on origin at ' + (Short-Hash $remoteCommit) + '; current source is ' + (Short-Hash $head) + '. Bump the version instead of rebuilding an existing release.')
    exit 2
}
Write-Output ('Release version ' + $Version + ' matches origin tag ' + $tag + ' at this exact commit.')
exit 0
