param([switch]$RequireSigned)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$StageRoot = Join-Path $ProjectRoot 'runtime\release-stage\DesktopMCP'
$Version = [string]((Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version)
$Setup = Join-Path $ProjectRoot ("runtime\release\DeskMCP-Setup-$Version.exe")
$blockers = [Collections.Generic.List[string]]::new()
$warnings = [Collections.Generic.List[string]]::new()

function Pass([string]$Message) { Write-Host ('PASS  ' + $Message) }
function Block([string]$Message) { $script:blockers.Add($Message); Write-Host ('BLOCK ' + $Message) }
function Warn([string]$Message) { $script:warnings.Add($Message); Write-Host ('WARN  ' + $Message) }
function Require-File([string]$Path, [string]$Label) {
    if (Test-Path -LiteralPath $Path) { Pass $Label; return $true }
    Block ($Label + ' missing: ' + $Path)
    return $false
}

Write-Output 'DeskMCP public release readiness'
Write-Output '------------------------------------'
$projectLicense = Join-Path $ProjectRoot 'LICENSE'
if (Test-Path -LiteralPath $projectLicense) {
    $licenseText = Get-Content -LiteralPath $projectLicense -Raw
    if ($licenseText -match 'Apache License' -and $licenseText -match 'Version 2\.0, January 2004') { Pass 'Project license: Apache-2.0' }
    else { Block 'Root LICENSE is not the expected Apache License 2.0 text' }
} else { Block 'Apache-2.0 LICENSE is missing' }

foreach ($doc in @('README.md','SECURITY.md','CONTRIBUTING.md','SUPPORT.md','THIRD_PARTY_NOTICES.md','RELEASE_CHECKLIST.md','CHANGELOG.md',('RELEASE_NOTES_' + $Version + '.md'),'LICENSE_OPTIONS.md')) {
    [void](Require-File (Join-Path $ProjectRoot $doc) $doc)
}
$secretScan = Join-Path $PSScriptRoot 'scan-release-secrets.ps1'
& $secretScan
if ($LASTEXITCODE -eq 0) { Pass 'Repository secret hygiene scan' } else { Block ('Repository secret hygiene scan failed: exit ' + $LASTEXITCODE) }

$inventory = Join-Path $StageRoot 'licenses\production-node-packages.csv'
if (Require-File $inventory 'Production Node license inventory') {
    $rows = @(Import-Csv -LiteralPath $inventory)
    if ($rows.Count -eq 0) { Block 'Production Node license inventory is empty' }
    else { Pass ('Production Node packages inventoried: ' + $rows.Count) }
    $unknown = @($rows | Where-Object { $_.license -eq 'UNKNOWN' })
    if ($unknown.Count -eq 0) { Pass 'No unresolved Node package licenses' }
    else { Block ('Unresolved Node licenses: ' + (($unknown | ForEach-Object { $_.name + '@' + $_.version }) -join ', ')) }
}

foreach ($item in @(
    @('LICENSE','DeskMCP Apache-2.0 license bundled in release'),
    @('licenses\buffers-0.1.1-MIT.txt','buffers 0.1.1 manual MIT resolution'),
    @('licenses\dotnet\LICENSE.txt','.NET Windows distribution license'),
    @('licenses\dotnet\ThirdPartyNotices.txt','.NET third-party notices'),
    @('node\LICENSE','Node.js license/notices'),
    @('tunnel-client\v0.0.13\bin\LICENSE','tunnel-client Apache-2.0 license'),
    @('tunnel-client\v0.0.13\bin\NOTICE','tunnel-client NOTICE'),
    @('tunnel-client\v0.0.13\bin\tunnel-client-v0.0.13-windows-amd64.spdx.json','tunnel-client SPDX')
)) {
    [void](Require-File (Join-Path $StageRoot $item[0]) $item[1])
}

$sharpReadme = Join-Path $StageRoot 'gateway\node_modules\@img\sharp-win32-x64\README.md'
if (Require-File $sharpReadme 'sharp/libvips bundled-library notice') {
    Warn 'sharp win32-x64 includes LGPL/native libraries; preserve its README/LICENSE and perform release legal review'
}
if (Require-File $Setup 'Windows x64 Setup') {
    $setupItem = Get-Item -LiteralPath $Setup
    $setupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Setup).Hash.ToLowerInvariant()
    Pass ('Setup size MB: ' + [math]::Round($setupItem.Length / 1MB, 1))
    Write-Output ('INFO  Setup SHA256: ' + $setupHash)
    $signature = Get-AuthenticodeSignature -LiteralPath $Setup
    if ($signature.Status -eq 'Valid') { Pass ('Authenticode valid: ' + $signature.SignerCertificate.Subject) }
    elseif ($RequireSigned) { Block ('Setup is not Authenticode-signed: ' + $signature.Status) }
    else { Warn ('Setup is unsigned: ' + $signature.Status + '; allowed for open-source release, Windows may show Unknown Publisher/SmartScreen') }
}

$manifestPath = Join-Path $ProjectRoot 'runtime\release\release-manifest.json'
$sumPath = Join-Path $ProjectRoot 'runtime\release\SHA256SUMS.txt'
if (Require-File $manifestPath 'Release manifest') {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.sha256 -eq $setupHash) { Pass 'Release manifest SHA256 matches Setup' } else { Block 'Release manifest SHA256 does not match Setup' }
    if ($manifest.version -eq $Version) { Pass 'Release manifest version matches package' } else { Block ('Release manifest version mismatch: ' + $manifest.version) }
    if ($manifest.artifact -eq (Split-Path $Setup -Leaf)) { Pass 'Release manifest artifact name matches Setup' } else { Block ('Release manifest artifact mismatch: ' + $manifest.artifact) }
}
if (Require-File $sumPath 'SHA256SUMS.txt') {
    $sum = (Get-Content -LiteralPath $sumPath -Raw).Trim()
    if ($sum.StartsWith($setupHash + '  ')) { Pass 'SHA256SUMS matches Setup' } else { Block 'SHA256SUMS does not match Setup' }
}

Warn ('Current release target is Windows x64 only; ARM64 is not built for ' + $Version)
Warn 'Automatic updater is not implemented; publish updates as explicit new installers'
Write-Output '------------------------------------'
Write-Output ('BLOCKERS=' + $blockers.Count)
Write-Output ('WARNINGS=' + $warnings.Count)
if ($blockers.Count -gt 0) {
    Write-Output 'PUBLIC_RELEASE_READY=NO'
    exit 2
}
Write-Output 'PUBLIC_RELEASE_READY=YES'
exit 0
