param(
    [ValidateSet('win-x64','win-arm64')]
    [string]$Target = 'win-x64',
    [string]$OutputRoot = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-targets.ps1')
$TargetConfig = Get-DeskMcpReleaseTarget $Target
$RuntimeRoot = Join-Path $ProjectRoot 'runtime'
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $RuntimeRoot ('publish\dotnet-shared-' + $Target)
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)

function Require([bool]$Condition,[string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Invoke-Native([string]$Exe,[string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw ($Exe + ' failed with exit code ' + $LASTEXITCODE) }
}

function Get-PeMachine([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    Require ($bytes.Length -ge 128) ('PE file is unexpectedly small: ' + $Path)
    $offset = [BitConverter]::ToInt32($bytes,0x3c)
    Require ($offset -ge 0 -and ($offset + 6) -lt $bytes.Length) ('Invalid PE header: ' + $Path)
    return [BitConverter]::ToUInt16($bytes,$offset + 4)
}

$localDotnet = Join-Path $RuntimeRoot 'tooling\dotnet\dotnet.exe'
if (-not (Test-Path -LiteralPath $localDotnet)) {
    $localDotnet = Join-Path $RuntimeRoot 'dotnet-sdk\dotnet.exe'
}
$dotnet = if (Test-Path -LiteralPath $localDotnet) {
    $localDotnet
} else {
    (Get-Command dotnet.exe -ErrorAction Stop).Source
}

$projects = @(
    (Join-Path $ProjectRoot 'control-panel\wpf\DeskMCP.ControlPanel.csproj'),
    (Join-Path $ProjectRoot 'process-host\DeskMCP.ProcessHost.csproj'),
    (Join-Path $ProjectRoot 'agent-desktop-host\DeskMCP.AgentDesktopHost.csproj')
)
foreach ($project in $projects) {
    Require (Test-Path -LiteralPath $project) ('Shared .NET release project is missing: ' + $project)
}

if (Test-Path -LiteralPath $OutputRoot) {
    Remove-Item -LiteralPath $OutputRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

foreach ($project in $projects) {
    Invoke-Native $dotnet @(
        'publish',$project,
        '-c','Release',
        '-r',$TargetConfig.DotnetRid,
        '--self-contained','true',
        '-p:PublishSingleFile=false',
        '-p:IncludeNativeLibrariesForSelfExtract=false',
        '-p:DebugType=None',
        '-p:DebugSymbols=false',
        '-o',$OutputRoot,
        '--nologo'
    )
}

$required = @(
    'DeskMCP.exe',
    'DeskMCP.dll',
    'DeskMCP.deps.json',
    'DeskMCP.runtimeconfig.json',
    'DeskMCP.ProcessHost.exe',
    'DeskMCP.ProcessHost.dll',
    'DeskMCP.ProcessHost.deps.json',
    'DeskMCP.ProcessHost.runtimeconfig.json',
    'DeskMCP.AgentDesktopHost.exe',
    'DeskMCP.AgentDesktopHost.dll',
    'DeskMCP.AgentDesktopHost.deps.json',
    'DeskMCP.AgentDesktopHost.runtimeconfig.json',
    'coreclr.dll',
    'hostfxr.dll',
    'hostpolicy.dll',
    'System.Private.CoreLib.dll',
    'Panel.xaml'
)
foreach ($name in $required) {
    Require (Test-Path -LiteralPath (Join-Path $OutputRoot $name)) ('Shared .NET runtime payload is missing: ' + $name)
}

foreach ($name in @('DeskMCP.exe','DeskMCP.ProcessHost.exe','DeskMCP.AgentDesktopHost.exe')) {
    $machine = Get-PeMachine (Join-Path $OutputRoot $name)
    Require ($machine -eq $TargetConfig.PeMachine) ($name + ' PE architecture mismatch: 0x{0:X4}' -f $machine)
}

$hostTarget = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
if ($Target -eq $hostTarget) {
    Invoke-Native (Join-Path $OutputRoot 'DeskMCP.exe') @('--agent-control-lock-self-test')
    & (Join-Path $PSScriptRoot 'test-process-host-job-lifetime.ps1') -ProcessHostPath (Join-Path $OutputRoot 'DeskMCP.ProcessHost.exe')
    & (Join-Path $PSScriptRoot 'test-process-host-launch-context.ps1') -ProcessHostPath (Join-Path $OutputRoot 'DeskMCP.ProcessHost.exe')
    Write-Output 'SHARED_DOTNET_NATIVE_SELF_TEST=PASS'
} else {
    Write-Output ('SHARED_DOTNET_NATIVE_SELF_TEST=SKIP cross-architecture target=' + $Target + ' host=' + $hostTarget)
}

$files = @(Get-ChildItem -LiteralPath $OutputRoot -Recurse -File)
$bytes = ($files | Measure-Object Length -Sum).Sum
Write-Output 'SHARED_DOTNET_RUNTIME=PASS'
Write-Output ('TARGET=' + $Target)
Write-Output ('OUTPUT=' + $OutputRoot)
Write-Output ('FILES=' + $files.Count)
Write-Output ('SIZE_MB=' + [math]::Round($bytes / 1MB, 1))
