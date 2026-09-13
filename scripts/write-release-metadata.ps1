param(
    [Parameter(Mandatory=$true)][string]$SetupPath,
    [string]$Version,
    [string]$Target = 'win-x64',
    [switch]$ReleaseStageSmokePassed,
    [switch]$InstallerSmokePassed
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-targets.ps1')
. (Join-Path $PSScriptRoot 'release-provenance.ps1')
$TargetConfig = Get-DeskMcpReleaseTarget $Target
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = [string]((Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version) }
$ReleaseRoot = Split-Path ([IO.Path]::GetFullPath($SetupPath)) -Parent
$StageRoot = Get-DeskMcpStageRoot $ProjectRoot $Target
$inventory = Join-Path $StageRoot 'licenses\production-node-packages.csv'
if (-not (Test-Path -LiteralPath $SetupPath)) { throw 'Setup artifact is missing.' }
if (-not (Test-Path -LiteralPath $inventory)) { throw 'License inventory is missing.' }
if (-not $ReleaseStageSmokePassed) { throw 'Release-stage smoke must be explicitly attested before release metadata can claim it passed.' }
if (-not $InstallerSmokePassed) { throw 'Installer smoke must be explicitly attested before release metadata can claim it passed.' }
$artifact = Get-Item -LiteralPath $SetupPath
$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $SetupPath).Hash.ToLowerInvariant()
$signature = Get-AuthenticodeSignature -LiteralPath $SetupPath
$rows = @(Import-Csv -LiteralPath $inventory)
$unknown = @($rows | Where-Object { $_.license -eq 'UNKNOWN' }).Count
$targetInfoPath = Join-Path $StageRoot 'release-target.json'
if (-not (Test-Path -LiteralPath $targetInfoPath)) { throw 'Release-stage target contract is missing.' }
$targetInfo = Get-Content -LiteralPath $targetInfoPath -Raw | ConvertFrom-Json
$setupSourceCommit = Get-DeskMcpSetupSourceCommit $SetupPath
$stageSourceCommit = ([string]$targetInfo.sourceCommit).Trim().ToLowerInvariant()
if ($stageSourceCommit -notmatch '^[0-9a-f]{40}$') { throw 'Release-stage source provenance is missing or invalid.' }
if ($stageSourceCommit -ne $setupSourceCommit) { throw ('Release-stage source commit ' + $stageSourceCommit + ' does not match Setup embedded source commit ' + $setupSourceCommit + '.') }
Assert-DeskMcpReleaseSourceClean $ProjectRoot
$currentSourceCommit = Get-DeskMcpGitSourceCommit $ProjectRoot
if ($setupSourceCommit -ne $currentSourceCommit) { throw ('Setup embedded source commit ' + $setupSourceCommit + ' does not match current source ' + $currentSourceCommit + '.') }
$nodeVersion = if ($targetInfo.nodeVersion) { [string]$targetInfo.nodeVersion } else { [string]$TargetConfig.NodeVersion }
$manifest = [ordered]@{
    schemaVersion = 2
    product = 'DeskMCP'
    version = $Version
    channel = 'stable'
    target = $Target
    architecture = $TargetConfig.Architecture
    sourceCommit = $setupSourceCommit
    artifact = $artifact.Name
    sizeBytes = [int64]$artifact.Length
    sha256 = $sha
    authenticodeStatus = [string]$signature.Status
    productionNodePackages = $rows.Count
    unresolvedNodeLicenses = $unknown
    gatewayVersion = $Version
    nodeVersion = $nodeVersion
    releaseStageSmoke = 'passed'
    installerSmoke = 'passed'
    updatePolicy = [ordered]@{
        preserveUserData = $true
        preservePermissionProfile = $true
        fullControlSessionOnly = $true
        manualInstallerFallback = $true
        automaticExecutionRequiresImmutableRelease = $true
        # Schema-v2 compatibility flag for already released clients; current clients inspect Authenticode locally instead of using this as an execution gate.
        automaticExecutionRequiresAuthenticode = $true
    }
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
}
$metadataSuffix = if ($Target -eq 'win-x64') { '' } else { '-' + $Target }
$manifestPath = Join-Path $ReleaseRoot ('release-manifest' + $metadataSuffix + '.json')
$sumPath = Join-Path $ReleaseRoot ('SHA256SUMS' + $metadataSuffix + '.txt')
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
[IO.File]::WriteAllText($sumPath, ($sha + '  ' + $artifact.Name + [Environment]::NewLine), [Text.Encoding]::ASCII)
Write-Output ('RELEASE_MANIFEST=' + $manifestPath)
Write-Output ('SHA256SUMS=' + $sumPath)
Write-Output ('ARTIFACT_SHA256=' + $sha)
Write-Output ('SIGNATURE_STATUS=' + $signature.Status)
Write-Output ('NODE_PACKAGES=' + $rows.Count)
Write-Output ('UNKNOWN_LICENSES=' + $unknown)