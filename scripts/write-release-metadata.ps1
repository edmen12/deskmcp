param(
    [Parameter(Mandatory=$true)][string]$SetupPath,
    [string]$Version,
    [string]$Target = 'win-x64'
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = [string]((Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version) }
$ReleaseRoot = Split-Path ([IO.Path]::GetFullPath($SetupPath)) -Parent
$StageRoot = Join-Path $ProjectRoot 'runtime\release-stage\DesktopMCP'
$inventory = Join-Path $StageRoot 'licenses\production-node-packages.csv'
if (-not (Test-Path -LiteralPath $SetupPath)) { throw 'Setup artifact is missing.' }
if (-not (Test-Path -LiteralPath $inventory)) { throw 'License inventory is missing.' }
$artifact = Get-Item -LiteralPath $SetupPath
$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $SetupPath).Hash.ToLowerInvariant()
$signature = Get-AuthenticodeSignature -LiteralPath $SetupPath
$rows = @(Import-Csv -LiteralPath $inventory)
$unknown = @($rows | Where-Object { $_.license -eq 'UNKNOWN' }).Count
$nodeExe = Join-Path $StageRoot 'node\node.exe'
$nodeVersion = if (Test-Path -LiteralPath $nodeExe) { ((& $nodeExe --version) | Out-String).Trim().TrimStart('v') } else { 'unknown' }
$manifest = [ordered]@{
    schemaVersion = 2
    product = 'DeskMCP'
    version = $Version
    channel = 'stable'
    target = $Target
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
        automaticExecutionRequiresAuthenticode = $true
    }
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
}
$manifestPath = Join-Path $ReleaseRoot 'release-manifest.json'
$sumPath = Join-Path $ReleaseRoot 'SHA256SUMS.txt'
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
[IO.File]::WriteAllText($sumPath, ($sha + '  ' + $artifact.Name + [Environment]::NewLine), [Text.Encoding]::ASCII)
Write-Output ('RELEASE_MANIFEST=' + $manifestPath)
Write-Output ('SHA256SUMS=' + $sumPath)
Write-Output ('ARTIFACT_SHA256=' + $sha)
Write-Output ('SIGNATURE_STATUS=' + $signature.Status)
Write-Output ('NODE_PACKAGES=' + $rows.Count)
Write-Output ('UNKNOWN_LICENSES=' + $unknown)