param([ValidateSet('win-x64','win-arm64')][string]$Target = 'win-x64')
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-targets.ps1')
$TargetConfig = Get-DeskMcpReleaseTarget $Target
$RuntimeRoot = Join-Path $ProjectRoot 'runtime'
$StageRoot = Get-DeskMcpStageRoot $ProjectRoot $Target
$PanelProject = Join-Path $ProjectRoot 'control-panel\wpf\DeskMCP.ControlPanel.csproj'
$PanelPublish = Join-Path $RuntimeRoot ('publish\control-panel-' + $Target)
$ProcessHostPublish = Join-Path $RuntimeRoot ('process-host\' + $Target)
$NodeZip = Join-Path $RuntimeRoot ('downloads\' + $TargetConfig.NodeArchive)
$NodeUrl = 'https://nodejs.org/dist/v' + $TargetConfig.NodeVersion + '/' + $TargetConfig.NodeArchive
$TunnelZip = Join-Path $RuntimeRoot ('downloads\' + $TargetConfig.TunnelAsset)
$TunnelUrl = 'https://github.com/openai/tunnel-client/releases/download/' + $TargetConfig.TunnelVersion + '/' + $TargetConfig.TunnelAsset

function Require([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-StageNotRunning([string]$StagePath) {
    if (-not (Test-Path -LiteralPath $StagePath)) { return }
    $prefix = [IO.Path]::GetFullPath($StagePath).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
    if ($running.Count -gt 0) { throw ('Release stage is running: ' + (($running | ForEach-Object { $_.ProcessName + ':' + $_.Id }) -join ', ')) }
}
function Invoke-Native([string]$Exe,[string[]]$Arguments) { & $Exe @Arguments; if ($LASTEXITCODE -ne 0) { throw "$Exe failed with exit code $LASTEXITCODE" } }
function Invoke-ProductionNpmCi([string[]]$Arguments) {
    $token = [Guid]::NewGuid().ToString('N')
    $stdout = Join-Path $env:TEMP ('deskmcp-npm-ci-' + $token + '.out')
    $stderr = Join-Path $env:TEMP ('deskmcp-npm-ci-' + $token + '.err')
    $commandLine = 'npm.cmd ci ' + ($Arguments -join ' ') + ' --audit=true 1>"' + $stdout + '" 2>"' + $stderr + '"'
    & cmd.exe /d /c $commandLine
    $ciExit = $LASTEXITCODE
    $stdoutText = if (Test-Path -LiteralPath $stdout) { [IO.File]::ReadAllText($stdout) } else { '' }
    $stderrText = if (Test-Path -LiteralPath $stderr) { [IO.File]::ReadAllText($stderr) } else { '' }
    if (-not [string]::IsNullOrWhiteSpace($stdoutText)) { Write-Output $stdoutText.TrimEnd() }
    if (-not [string]::IsNullOrWhiteSpace($stderrText)) { Write-Warning $stderrText.TrimEnd() }
    $combined = $stdoutText + [Environment]::NewLine + $stderrText
    Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue
    if ($ciExit -ne 0) { throw ('Production npm ci failed: exit=' + $ciExit) }
    if ([regex]::IsMatch($combined, '(?im)^\s*npm\s+(warn|error)\s+audit\b') -or $combined -match '(?i)audit endpoint returned an error') {
        throw 'Production npm ci audit was unavailable; refusing release.'
    }
    if (-not [regex]::IsMatch($combined, '(?im)^\s*found\s+0\s+vulnerabilities\s*$')) {
        throw 'Production npm ci did not prove zero vulnerabilities; refusing release.'
    }
    Write-Output 'NPM_AUDIT_OK source=npm-ci'
}

function Get-Sha256([string]$Path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function Get-VerifiedDownload([string]$Url,[string]$Path,[string]$ExpectedSha256) {
    if (Test-Path -LiteralPath $Path) {
        if ((Get-Sha256 $Path) -eq $ExpectedSha256) { return }
        Remove-Item -LiteralPath $Path -Force
    }
    $parent = Split-Path $Path -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) { Invoke-Native $curl.Source @('-L','--fail','--retry','3','--retry-delay','2','-o',$Path,$Url) }
    else { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path }
    $actual = Get-Sha256 $Path
    Require ($actual -eq $ExpectedSha256) ('Downloaded file SHA256 mismatch: ' + $actual + ' expected=' + $ExpectedSha256)
}
function Get-PeMachine([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    Require ($bytes.Length -ge 128) ('PE file is unexpectedly small: ' + $Path)
    $offset = [BitConverter]::ToInt32($bytes, 0x3c)
    Require ($offset -ge 0 -and ($offset + 6) -lt $bytes.Length) ('Invalid PE header: ' + $Path)
    return [BitConverter]::ToUInt16($bytes, $offset + 4)
}
$localDotnet = Join-Path $RuntimeRoot 'dotnet-sdk\dotnet.exe'
$dotnet = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } else { (Get-Command dotnet.exe -ErrorAction Stop).Source }
$dotnetRoot = Split-Path $dotnet -Parent
$hostNode = (Get-Command node.exe -ErrorAction Stop).Source
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
Assert-StageNotRunning $StageRoot
Push-Location $ProjectRoot
try { Invoke-Native 'npm.cmd' @('run','build') } finally { Pop-Location }

if (Test-Path -LiteralPath $PanelPublish) { Remove-Item -LiteralPath $PanelPublish -Recurse -Force }
Invoke-Native $dotnet @(
    'publish',$PanelProject,'-c','Release','-r',$TargetConfig.DotnetRid,
    '--self-contained','true','-p:PublishSingleFile=false','-o',$PanelPublish,'--nologo'
)
$publishedPanel = Join-Path $PanelPublish 'DeskMCP.exe'
Require (Test-Path -LiteralPath $publishedPanel) 'Control Panel publish output is missing.'
$panelMachine = Get-PeMachine $publishedPanel
Require ($panelMachine -eq $TargetConfig.PeMachine) ('Control Panel PE architecture mismatch: 0x{0:X4}' -f $panelMachine)

& (Join-Path $PSScriptRoot 'build-process-host.ps1') -Target $Target
$processHostExe = Join-Path $ProcessHostPublish 'DeskMCP.ProcessHost.exe'
$processHostMachine = Get-PeMachine $processHostExe
Require ($processHostMachine -eq $TargetConfig.PeMachine) ('ProcessHost PE architecture mismatch: 0x{0:X4}' -f $processHostMachine)

if (Test-Path -LiteralPath $StageRoot) { Remove-Item -LiteralPath $StageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null
Copy-Item -Path (Join-Path $PanelPublish '*') -Destination $StageRoot -Recurse -Force
foreach ($name in @('DeskMCP.ProcessHost.exe','DeskMCP.ProcessHost.dll','DeskMCP.ProcessHost.deps.json','DeskMCP.ProcessHost.runtimeconfig.json')) {
    Copy-Item -LiteralPath (Join-Path $ProcessHostPublish $name) -Destination (Join-Path $StageRoot $name) -Force
}
Require (Test-Path -LiteralPath (Join-Path $StageRoot 'Panel.xaml')) 'Panel.xaml payload missing.'
Require (Test-Path -LiteralPath (Join-Path $StageRoot 'DeskMCP.ProcessHost.exe')) 'ProcessHost payload missing.'
$projectLicense = Join-Path $ProjectRoot 'LICENSE'
Require (Test-Path -LiteralPath $projectLicense) 'Apache-2.0 project LICENSE is missing.'
Copy-Item -LiteralPath $projectLicense -Destination (Join-Path $StageRoot 'LICENSE') -Force
$dotnetLicenseDir = Join-Path $StageRoot 'licenses\dotnet'
New-Item -ItemType Directory -Force -Path $dotnetLicenseDir | Out-Null
foreach ($name in @('LICENSE.txt','ThirdPartyNotices.txt')) {
    $source = Join-Path $dotnetRoot $name
    Require (Test-Path -LiteralPath $source) ('Required .NET redistribution notice missing: ' + $source)
    Copy-Item -LiteralPath $source -Destination $dotnetLicenseDir -Force
}
$downloads = Split-Path $NodeZip -Parent
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
Get-VerifiedDownload $NodeUrl $NodeZip $TargetConfig.NodeSha256
$actualNodeHash = Get-Sha256 $NodeZip
$nodeExtract = Join-Path $RuntimeRoot ('downloads\node-' + $Target)
if (Test-Path -LiteralPath $nodeExtract) { Remove-Item -LiteralPath $nodeExtract -Recurse -Force }
Expand-Archive -LiteralPath $NodeZip -DestinationPath $nodeExtract -Force
$nodeSource = Join-Path $nodeExtract $TargetConfig.NodeDirectory
$nodeDest = Join-Path $StageRoot 'node'
New-Item -ItemType Directory -Force -Path $nodeDest | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeSource 'node.exe') -Destination $nodeDest -Force
Copy-Item -LiteralPath (Join-Path $nodeSource 'LICENSE') -Destination $nodeDest -Force
$nodeMachine = Get-PeMachine (Join-Path $nodeDest 'node.exe')
Require ($nodeMachine -eq $TargetConfig.PeMachine) ('Node PE architecture mismatch: 0x{0:X4}' -f $nodeMachine)

Get-VerifiedDownload $TunnelUrl $TunnelZip $TargetConfig.TunnelSha256
$actualTunnelHash = Get-Sha256 $TunnelZip
$tunnelExtract = Join-Path $RuntimeRoot ('downloads\tunnel-' + $Target)
if (Test-Path -LiteralPath $tunnelExtract) { Remove-Item -LiteralPath $tunnelExtract -Recurse -Force }
Expand-Archive -LiteralPath $TunnelZip -DestinationPath $tunnelExtract -Force
$tunnelDest = Join-Path $StageRoot ('tunnel-client\' + $TargetConfig.TunnelVersion)
$tunnelBin = Join-Path $tunnelDest 'bin'
New-Item -ItemType Directory -Force -Path $tunnelBin | Out-Null
Copy-Item -Path (Join-Path $tunnelExtract '*') -Destination $tunnelBin -Recurse -Force
$tunnelExe = Join-Path $tunnelBin 'tunnel-client.exe'
Require (Test-Path -LiteralPath $tunnelExe) 'Tunnel client executable is missing.'
$tunnelMachine = Get-PeMachine $tunnelExe
Require ($tunnelMachine -eq $TargetConfig.PeMachine) ('Tunnel PE architecture mismatch: 0x{0:X4}' -f $tunnelMachine)
[IO.File]::WriteAllText((Join-Path $tunnelDest 'SHA256SUMS.txt'), ($actualTunnelHash + '  ' + $TargetConfig.TunnelAsset + [Environment]::NewLine), [Text.Encoding]::ASCII)
$gatewayDest = Join-Path $StageRoot 'gateway'
New-Item -ItemType Directory -Force -Path $gatewayDest | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'dist') -Destination $gatewayDest -Recurse -Force
foreach ($file in @('package.json','package-lock.json','.npmrc')) { Copy-Item -LiteralPath (Join-Path $ProjectRoot $file) -Destination $gatewayDest -Force }
Push-Location $gatewayDest
try {
    Invoke-ProductionNpmCi @('--omit=dev','--ignore-scripts',('--os=' + $TargetConfig.NpmOs),('--cpu=' + $TargetConfig.NpmCpu))

    # npm can materialize optional binaries for multiple platforms even with --os/--cpu.
    # Physically prune non-target native packages so the release closure matches its target.
    $imgScope = Join-Path $gatewayDest 'node_modules\@img'
    $vscodeScope = Join-Path $gatewayDest 'node_modules\@vscode'
    $foreignSharp = @(
        Get-ChildItem -LiteralPath $imgScope -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'sharp-*' -and $_.Name -ne $TargetConfig.SharpPackage }
    )
    foreach ($packageDir in $foreignSharp) { Remove-Item -LiteralPath $packageDir.FullName -Recurse -Force }
    $foreignRipgrep = @(
        Get-ChildItem -LiteralPath $vscodeScope -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'ripgrep-*' -and $_.Name -ne $TargetConfig.RipgrepPackage }
    )
    foreach ($packageDir in $foreignRipgrep) { Remove-Item -LiteralPath $packageDir.FullName -Recurse -Force }
    foreach ($windowsUnusedOptional in @('node_modules\fsevents','node_modules\@emnapi\runtime')) {
        $unusedPath = Join-Path $gatewayDest $windowsUnusedOptional
        if (Test-Path -LiteralPath $unusedPath) { Remove-Item -LiteralPath $unusedPath -Recurse -Force }
    }
    Write-Output ('PRUNED_FOREIGN_SHARP=' + $foreignSharp.Count)
    Write-Output ('PRUNED_FOREIGN_RIPGREP=' + $foreignRipgrep.Count)

} finally { Pop-Location }
$sharpPath = Join-Path $gatewayDest ('node_modules\@img\' + $TargetConfig.SharpPackage + '\package.json')
$ripgrepPath = Join-Path $gatewayDest ('node_modules\@vscode\' + $TargetConfig.RipgrepPackage + '\package.json')
Require (Test-Path -LiteralPath $sharpPath) ('Target sharp package missing: ' + $TargetConfig.SharpPackage)
Require (Test-Path -LiteralPath $ripgrepPath) ('Target ripgrep package missing: ' + $TargetConfig.RipgrepPackage)
$remainingForeignSharp = @(
    Get-ChildItem -LiteralPath (Join-Path $gatewayDest 'node_modules\@img') -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'sharp-*' -and $_.Name -ne $TargetConfig.SharpPackage }
)
$remainingForeignRipgrep = @(
    Get-ChildItem -LiteralPath (Join-Path $gatewayDest 'node_modules\@vscode') -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'ripgrep-*' -and $_.Name -ne $TargetConfig.RipgrepPackage }
)
Require ($remainingForeignSharp.Count -eq 0) 'Foreign-platform sharp packages remained in the release stage.'
Require ($remainingForeignRipgrep.Count -eq 0) 'Foreign-platform ripgrep packages remained in the release stage.'
Require (-not (Test-Path -LiteralPath (Join-Path $gatewayDest 'node_modules\fsevents'))) 'Windows release stage retained macOS-only fsevents.'
Require (-not (Test-Path -LiteralPath (Join-Path $gatewayDest 'node_modules\@emnapi\runtime'))) 'Windows release stage retained wasm-only @emnapi/runtime.'

$noticeGenerator = Join-Path $ProjectRoot 'scripts\generate-third-party-notices.mjs'
Require (Test-Path -LiteralPath $noticeGenerator) 'Third-party notice generator is missing.'
Invoke-Native $hostNode @($noticeGenerator,$ProjectRoot,$StageRoot,$Target,$TargetConfig.NodeVersion)
$stageInfo = [ordered]@{ target=$Target; architecture=$TargetConfig.Architecture; dotnetRid=$TargetConfig.DotnetRid; nodeVersion=$TargetConfig.NodeVersion; tunnelVersion=$TargetConfig.TunnelVersion; agentSafeIsolationContract=2; processJobObjectContract=1; panelPeMachine=('0x{0:X4}' -f $panelMachine); processHostPeMachine=('0x{0:X4}' -f $processHostMachine); nodePeMachine=('0x{0:X4}' -f $nodeMachine); tunnelPeMachine=('0x{0:X4}' -f $tunnelMachine) }
$stageInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $StageRoot 'release-target.json') -Encoding UTF8
$files = Get-ChildItem -LiteralPath $StageRoot -Recurse -File
$bytes = ($files | Measure-Object Length -Sum).Sum
Write-Output 'RELEASE_STAGE_OK'
Write-Output ('TARGET=' + $Target)
Write-Output ('STAGE=' + $StageRoot)
Write-Output ('NODE=v' + $TargetConfig.NodeVersion)
Write-Output ('NPM_AUDIT=0')
Write-Output ('FILES=' + $files.Count)
Write-Output ('SIZE_MB=' + [math]::Round($bytes / 1MB, 1))
