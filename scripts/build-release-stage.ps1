$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = Join-Path $ProjectRoot 'runtime'
$StageRoot = Join-Path $RuntimeRoot 'release-stage\DesktopMCP'
$PanelProject = Join-Path $ProjectRoot 'control-panel\wpf\DeskMCP.ControlPanel.csproj'
$PanelPublish = Join-Path $RuntimeRoot 'publish\control-panel-win-x64'
$NodeVersion = '24.19.0'
$NodeSha256 = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
$NodeZip = Join-Path $RuntimeRoot "downloads\node-v$NodeVersion-win-x64.zip"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$TunnelVersion = 'v0.0.13'

function Assert-StageNotRunning([string]$StagePath) {
    if (-not (Test-Path -LiteralPath $StagePath)) { return }
    $prefix = [IO.Path]::GetFullPath($StagePath).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
    if ($running.Count -gt 0) {
        $ids = ($running | ForEach-Object { $_.ProcessName + ':' + $_.Id }) -join ', '
        throw ('Release stage is running (' + $ids + '). Quit DeskMCP from the tray before building; no stage files were changed.')
    }
}
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe failed with exit code $LASTEXITCODE" }
}

$localDotnet = Join-Path $RuntimeRoot 'dotnet-sdk\dotnet.exe'
$dotnet = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } else { (Get-Command dotnet.exe -ErrorAction Stop).Source }
$dotnetRoot = Split-Path $dotnet -Parent
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
Assert-StageNotRunning $StageRoot
Push-Location $ProjectRoot
try { Invoke-Native 'npm.cmd' @('run', 'build') } finally { Pop-Location }

if (Test-Path -LiteralPath $PanelPublish) { Remove-Item -LiteralPath $PanelPublish -Recurse -Force }
Invoke-Native $dotnet @(
    'publish', $PanelProject, '-c', 'Release', '-r', 'win-x64',
    '--self-contained', 'true', '-p:PublishSingleFile=false',
    '-o', $PanelPublish, '--nologo'
)

if (Test-Path -LiteralPath $StageRoot) { Remove-Item -LiteralPath $StageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null
Copy-Item -Path (Join-Path $PanelPublish '*') -Destination $StageRoot -Recurse -Force
if (-not (Test-Path -LiteralPath (Join-Path $StageRoot 'DeskMCP.exe'))) { throw 'Control Panel payload missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $StageRoot 'Panel.xaml'))) { throw 'Panel.xaml payload missing.' }
$projectLicense = Join-Path $ProjectRoot 'LICENSE'
if (-not (Test-Path -LiteralPath $projectLicense)) { throw 'Apache-2.0 project LICENSE is missing.' }
Copy-Item -LiteralPath $projectLicense -Destination (Join-Path $StageRoot 'LICENSE') -Force
$dotnetLicenseDir = Join-Path $StageRoot 'licenses\dotnet'
New-Item -ItemType Directory -Force -Path $dotnetLicenseDir | Out-Null
foreach ($name in @('LICENSE.txt','ThirdPartyNotices.txt')) {
    $source = Join-Path $dotnetRoot $name
    if (-not (Test-Path -LiteralPath $source)) { throw "Required .NET redistribution notice missing: $source" }
    Copy-Item -LiteralPath $source -Destination $dotnetLicenseDir -Force
}

$downloads = Split-Path $NodeZip -Parent
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
if (-not (Test-Path -LiteralPath $NodeZip)) { Invoke-WebRequest -UseBasicParsing -Uri $NodeUrl -OutFile $NodeZip }
$actualNodeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $NodeZip).Hash.ToLowerInvariant()
if ($actualNodeHash -ne $NodeSha256) { throw "Node ZIP SHA256 mismatch: $actualNodeHash" }
$nodeExtract = Join-Path $RuntimeRoot "downloads\node-v$NodeVersion"
if (Test-Path -LiteralPath $nodeExtract) { Remove-Item -LiteralPath $nodeExtract -Recurse -Force }
Expand-Archive -LiteralPath $NodeZip -DestinationPath $nodeExtract -Force
$nodeSource = Join-Path $nodeExtract "node-v$NodeVersion-win-x64"
$nodeDest = Join-Path $StageRoot 'node'
New-Item -ItemType Directory -Force -Path $nodeDest | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeSource 'node.exe') -Destination $nodeDest -Force
Copy-Item -LiteralPath (Join-Path $nodeSource 'LICENSE') -Destination $nodeDest -Force
$nodeVersionActual = & (Join-Path $nodeDest 'node.exe') --version
if ($nodeVersionActual.Trim() -ne "v$NodeVersion") { throw "Unexpected Node version: $nodeVersionActual" }

$tunnelSource = Join-Path $ProjectRoot "tools\tunnel-client\$TunnelVersion"
if (-not (Test-Path -LiteralPath (Join-Path $tunnelSource 'bin\tunnel-client.exe'))) { throw "Tunnel runtime missing: $TunnelVersion" }
$tunnelDest = Join-Path $StageRoot "tunnel-client\$TunnelVersion"
New-Item -ItemType Directory -Force -Path $tunnelDest | Out-Null
Copy-Item -LiteralPath (Join-Path $tunnelSource 'bin') -Destination $tunnelDest -Recurse -Force
if (Test-Path -LiteralPath (Join-Path $tunnelSource 'SHA256SUMS.txt')) {
    Copy-Item -LiteralPath (Join-Path $tunnelSource 'SHA256SUMS.txt') -Destination $tunnelDest -Force
}
$gatewayDest = Join-Path $StageRoot 'gateway'
New-Item -ItemType Directory -Force -Path $gatewayDest | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'dist') -Destination $gatewayDest -Recurse -Force
foreach ($file in @('package.json', 'package-lock.json', '.npmrc')) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot $file) -Destination $gatewayDest -Force
}
Push-Location $gatewayDest
try {
    Invoke-Native 'npm.cmd' @('ci', '--omit=dev', '--ignore-scripts')
    $auditText = (& npm.cmd audit --omit=dev --json 2>$null | Out-String)
    $auditExit = $LASTEXITCODE
    $audit = $auditText | ConvertFrom-Json
    if ($audit.metadata.vulnerabilities.total -ne 0 -or $auditExit -ne 0) {
        throw "Production npm audit failed: total=$($audit.metadata.vulnerabilities.total), exit=$auditExit"
    }
} finally { Pop-Location }

$noticeGenerator = Join-Path $ProjectRoot 'scripts\generate-third-party-notices.mjs'
if (-not (Test-Path -LiteralPath $noticeGenerator)) { throw 'Third-party notice generator is missing.' }
Invoke-Native (Join-Path $nodeDest 'node.exe') @($noticeGenerator, $ProjectRoot, $StageRoot)

$files = Get-ChildItem -LiteralPath $StageRoot -Recurse -File
$bytes = ($files | Measure-Object Length -Sum).Sum
Write-Output 'RELEASE_STAGE_OK'
Write-Output ('STAGE=' + $StageRoot)
Write-Output ('NODE=' + $nodeVersionActual.Trim())
Write-Output ('NPM_AUDIT=0')
Write-Output ('FILES=' + $files.Count)
Write-Output ('SIZE_MB=' + [math]::Round($bytes / 1MB, 1))
