param(
    [Parameter(Mandatory=$true)][string]$ResultPath,
    [switch]$Desktop1Reserved
)

$ErrorActionPreference = 'Stop'

if (-not $Desktop1Reserved) { throw 'Desktop 1 reservation must be verified before creating a release attestation.' }
$resultFile = [IO.Path]::GetFullPath($ResultPath)
if (-not (Test-Path -LiteralPath $resultFile -PathType Leaf)) { throw 'Live-upgrade result file is missing.' }
$result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
if ([int]$result.schemaVersion -ne 1) { throw 'Unsupported live-upgrade result schema.' }
if ($result.success -ne $true) { throw ('Live-upgrade result is not successful: ' + [string]$result.error) }
if ($result.statePreserved -ne $true) { throw 'Live-upgrade result did not preserve settings/Tunnel/Startup state.' }
if ([int]$result.setupExitCode -ne 0) { throw ('Live-upgrade Setup exit=' + $result.setupExitCode) }
if ([string]$result.after.version -ne [string]$result.expectedToVersion) { throw 'Live-upgrade target version mismatch.' }
if (([string]$result.after.sourceCommit).ToLowerInvariant() -ne ([string]$result.expectedSourceCommit).ToLowerInvariant()) { throw 'Live-upgrade source commit mismatch.' }

$token = 'DESKMCP_LIVE_UPGRADE_V1' +
    '|from=' + [string]$result.expectedFromVersion +
    '|to=' + [string]$result.expectedToVersion +
    '|source=' + ([string]$result.expectedSourceCommit).ToLowerInvariant() +
    '|setup_sha256=' + ([string]$result.expectedSetupSha256).ToLowerInvariant() +
    '|settings=unchanged' +
    '|tunnel=unchanged' +
    '|startup=unchanged' +
    '|desktop1=reserved' +
    '|result=PASS'

Write-Output ('LIVE_UPGRADE_ATTESTATION=' + $token)
