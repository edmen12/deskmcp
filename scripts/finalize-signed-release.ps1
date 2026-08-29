param(
    [ValidateSet('win-x64','win-arm64')][string]$Target = 'win-x64',
    [string]$SetupPath
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-targets.ps1')
$TargetConfig = Get-DeskMcpReleaseTarget $Target
$Version = [string]((Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version)
if ([string]::IsNullOrWhiteSpace($SetupPath)) {
    $SetupPath = Join-Path (Join-Path $ProjectRoot 'runtime\release') (Get-DeskMcpSetupName $Version $TargetConfig)
}
$SetupPath = [IO.Path]::GetFullPath($SetupPath)
function Require([bool]$Condition,[string]$Message){ if(-not $Condition){ throw $Message } }
Require (Test-Path -LiteralPath $SetupPath) ('Signed Setup artifact is missing: ' + $SetupPath)

$auth = Get-AuthenticodeSignature -LiteralPath $SetupPath
Require ($auth.Status -eq 'Valid') ('Authenticode status is ' + $auth.Status + ': ' + $auth.StatusMessage)
Require ($null -ne $auth.SignerCertificate) 'Authenticode signer certificate is missing.'
Require ($null -ne $auth.TimeStamperCertificate) 'Authenticode timestamp certificate is missing.'

$sha256 = [Security.Cryptography.SHA256]::Create()
try { $certSha256 = ([BitConverter]::ToString($sha256.ComputeHash($auth.SignerCertificate.RawData))).Replace('-', '') } finally { $sha256.Dispose() }
Write-Output ('SIGNED_BY=' + $auth.SignerCertificate.Subject)
Write-Output ('SIGNER_CERT_SHA256=' + $certSha256)
Write-Output ('TIMESTAMPED_BY=' + $auth.TimeStamperCertificate.Subject)

Write-Output 'STEP=post-sign-installer-smoke'
& (Join-Path $PSScriptRoot 'test-installer-release.ps1') -Target $Target -SetupPath $SetupPath
if ($LASTEXITCODE -ne 0) { throw "Post-sign installer smoke failed: $LASTEXITCODE" }

Write-Output 'STEP=release-metadata'
& (Join-Path $PSScriptRoot 'write-release-metadata.ps1') -SetupPath $SetupPath -Version $Version -Target $Target
if ($LASTEXITCODE -ne 0) { throw "Release metadata generation failed: $LASTEXITCODE" }

Write-Output 'STEP=release-readiness'
& (Join-Path $PSScriptRoot 'check-release-readiness.ps1') -RequireSigned -Target $Target -SetupPath $SetupPath
$readiness = $LASTEXITCODE
if ($readiness -ne 0) { Write-Output ('READINESS_EXIT=' + $readiness) }
exit $readiness
