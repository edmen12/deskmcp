param(
    [Parameter(Mandatory=$true)][string]$CertificateThumbprint,
    [Parameter(Mandatory=$true)][string]$TimestampUrl,
    [string]$SignToolPath,
    [switch]$MachineStore,
    [ValidateSet('win-x64','win-arm64')][string]$Target = 'win-x64'
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-targets.ps1')
$TargetConfig = Get-DeskMcpReleaseTarget $Target
$Version = [string]((Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version)
$Setup = Join-Path (Join-Path $ProjectRoot 'runtime\release') (Get-DeskMcpSetupName $Version $TargetConfig)
function Require([bool]$Condition,[string]$Message){ if(-not $Condition){ throw $Message } }
Require (Test-Path -LiteralPath $Setup) 'Setup artifact is missing.'
try {
    Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 1 | Out-Null
    throw 'DeskMCP is running on port 8765. Quit DeskMCP before signing so installer smoke cannot affect the live instance.'
} catch {
    if ($_.Exception.Message -like 'DeskMCP is running*') { throw }
}
$thumb = ($CertificateThumbprint -replace '\s','').ToUpperInvariant()
Require ($thumb -match '^[0-9A-F]{40,}$') 'Certificate thumbprint format is invalid.'
if ([string]::IsNullOrWhiteSpace($SignToolPath)) {
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { $SignToolPath = $cmd.Source }
}
if ([string]::IsNullOrWhiteSpace($SignToolPath)) {
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    if (Test-Path -LiteralPath $kits) {
        $candidate = Get-ChildItem -Path (Join-Path $kits ('*\' + $TargetConfig.Architecture + '\signtool.exe')) -File -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($candidate) { $SignToolPath = $candidate.FullName }
    }
}
if (-not [string]::IsNullOrWhiteSpace($SignToolPath)) {
    Require (Test-Path -LiteralPath $SignToolPath) ('signtool.exe not found: ' + $SignToolPath)
    $args = @('sign','/fd','SHA256','/sha1',$thumb,'/tr',$TimestampUrl,'/td','SHA256')
    if ($MachineStore) { $args += '/sm' }
    $args += $Setup
    & $SignToolPath @args
    if ($LASTEXITCODE -ne 0) { throw "SignTool sign failed: $LASTEXITCODE" }
    & $SignToolPath verify /pa /all /v $Setup
    if ($LASTEXITCODE -ne 0) { throw "SignTool verify failed: $LASTEXITCODE" }
} else {
    $store = if ($MachineStore) { 'Cert:\LocalMachine\My' } else { 'Cert:\CurrentUser\My' }
    $certPath = Join-Path $store $thumb
    $cert = Get-Item -LiteralPath $certPath -ErrorAction Stop
    Require $cert.HasPrivateKey 'The selected code-signing certificate has no accessible private key.'
    $signed = Set-AuthenticodeSignature -LiteralPath $Setup -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $TimestampUrl
    Require ($signed.Status -eq 'Valid') ('Set-AuthenticodeSignature status is ' + $signed.Status + ': ' + $signed.StatusMessage)
}
$auth = Get-AuthenticodeSignature -LiteralPath $Setup
Require ($auth.Status -eq 'Valid') ('Authenticode status is ' + $auth.Status)
Write-Output ('SIGNED_BY=' + $auth.SignerCertificate.Subject)
Write-Output 'STEP=post-sign-installer-smoke'
& (Join-Path $PSScriptRoot 'test-installer-release.ps1') -Target $Target
if ($LASTEXITCODE -ne 0) { throw "Post-sign installer smoke failed: $LASTEXITCODE" }
Write-Output 'STEP=release-metadata'
& (Join-Path $PSScriptRoot 'write-release-metadata.ps1') -SetupPath $Setup -Version $Version -Target $Target
if ($LASTEXITCODE -ne 0) { throw "Release metadata generation failed: $LASTEXITCODE" }
Write-Output 'STEP=release-readiness'
& (Join-Path $PSScriptRoot 'check-release-readiness.ps1') -RequireSigned -Target $Target
$readiness = $LASTEXITCODE
if ($readiness -ne 0) { Write-Output ('READINESS_EXIT=' + $readiness) }
exit $readiness