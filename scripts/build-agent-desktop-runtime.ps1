param([Parameter(Mandatory=$true)][ValidateSet('win-x64','win-arm64')][string]$Target)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-targets.ps1')
$TargetConfig = Get-DeskMcpReleaseTarget $Target
$RuntimeRoot = Join-Path $ProjectRoot 'runtime'
$HostProject = Join-Path $ProjectRoot 'agent-desktop-host\DeskMCP.AgentDesktopHost.csproj'
$OutputRoot = Join-Path $RuntimeRoot ('agent-desktop-runtime\' + $Target)
$HostOutput = Join-Path $OutputRoot 'host-publish'
$VdaSource = Join-Path $RuntimeRoot 'third-party-build\virtual-desktop-accessor'
$VdaCommit = '8172097993b1194e3d5e2ff38421ebb06f867b6c'
$VdaRepo = 'https://github.com/Ciantic/VirtualDesktopAccessor.git'
$RustTarget = if ($Target -eq 'win-arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }

function Require([bool]$Condition,[string]$Message) { if(-not $Condition){ throw $Message } }
function Invoke-Native([string]$Exe,[string[]]$Arguments) { & $Exe @Arguments; if($LASTEXITCODE -ne 0){ throw ($Exe + ' failed with exit code ' + $LASTEXITCODE) } }
function Get-PeMachine([string]$Path) {
    $bytes=[IO.File]::ReadAllBytes($Path)
    Require ($bytes.Length -ge 128) ('PE file is unexpectedly small: ' + $Path)
    $offset=[BitConverter]::ToInt32($bytes,0x3c)
    Require ($offset -ge 0 -and ($offset + 6) -lt $bytes.Length) ('Invalid PE header: ' + $Path)
    return [BitConverter]::ToUInt16($bytes,$offset + 4)
}

$localDotnet = Join-Path $RuntimeRoot 'tooling\dotnet\dotnet.exe'
if (-not (Test-Path -LiteralPath $localDotnet)) { $localDotnet = Join-Path $RuntimeRoot 'dotnet-sdk\dotnet.exe' }
$dotnet = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } else { (Get-Command dotnet.exe -ErrorAction Stop).Source }
$cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
$git = (Get-Command git.exe -ErrorAction Stop).Source
Require (Test-Path -LiteralPath $HostProject) 'Agent Desktop Host project is missing.'

if (-not (Test-Path -LiteralPath (Join-Path $VdaSource '.git'))) {
    New-Item -ItemType Directory -Force -Path (Split-Path $VdaSource -Parent) | Out-Null
    Invoke-Native $git @('clone','--no-tags',$VdaRepo,$VdaSource)
}
Push-Location $VdaSource
try {
    $dirty = (& $git status --porcelain) -join "`n"
    Require ([string]::IsNullOrWhiteSpace($dirty)) 'VirtualDesktopAccessor source tree is dirty; refusing to alter or release from it.'
    $head = (& $git rev-parse HEAD).Trim()
    if ($head -ne $VdaCommit) {
        Invoke-Native $git @('fetch','origin',$VdaCommit,'--depth','1')
        Invoke-Native $git @('checkout','--detach',$VdaCommit)
    }
    $head = (& $git rev-parse HEAD).Trim()
    Require ($head -eq $VdaCommit) ('VirtualDesktopAccessor source commit mismatch: ' + $head)
    $dirty = (& $git status --porcelain) -join "`n"
    Require ([string]::IsNullOrWhiteSpace($dirty)) 'VirtualDesktopAccessor source tree changed during preparation.'

    $installedTargets = @(& rustup target list --installed 2>$null)
    Require ($installedTargets -contains $RustTarget) ('Rust target is not installed: ' + $RustTarget)
    Invoke-Native $cargo @('build','--manifest-path','dll\Cargo.toml','--release','--locked','--target',$RustTarget)
} finally { Pop-Location }

$VdaDll = Join-Path $VdaSource ('target\' + $RustTarget + '\release\VirtualDesktopAccessor.dll')
$VdaLicense = Join-Path $VdaSource 'LICENSE.txt'
Require (Test-Path -LiteralPath $VdaDll) 'VirtualDesktopAccessor build output is missing.'
Require (Test-Path -LiteralPath $VdaLicense) 'VirtualDesktopAccessor MIT license is missing.'
$vdaMachine = Get-PeMachine $VdaDll
Require ($vdaMachine -eq $TargetConfig.PeMachine) ('VirtualDesktopAccessor PE architecture mismatch: 0x{0:X4}' -f $vdaMachine)

if (Test-Path -LiteralPath $OutputRoot) { Remove-Item -LiteralPath $OutputRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $HostOutput | Out-Null
Invoke-Native $dotnet @(
    'publish',$HostProject,'-c','Release','-r',$TargetConfig.DotnetRid,
    '--self-contained','true','-p:PublishSingleFile=true','-p:IncludeNativeLibrariesForSelfExtract=true',
    '-o',$HostOutput,'--nologo'
)
$HostExe = Join-Path $HostOutput 'DeskMCP.AgentDesktopHost.exe'
Require (Test-Path -LiteralPath $HostExe) 'Agent Desktop Host publish output is missing.'
$hostMachine = Get-PeMachine $HostExe
Require ($hostMachine -eq $TargetConfig.PeMachine) ('Agent Desktop Host PE architecture mismatch: 0x{0:X4}' -f $hostMachine)

$FinalHost = Join-Path $OutputRoot 'DeskMCP.AgentDesktopHost.exe'
$FinalVdaDir = Join-Path $OutputRoot 'virtual-desktop-accessor'
New-Item -ItemType Directory -Force -Path $FinalVdaDir | Out-Null
Copy-Item -LiteralPath $HostExe -Destination $FinalHost -Force
Copy-Item -LiteralPath $VdaDll -Destination (Join-Path $FinalVdaDir 'VirtualDesktopAccessor.dll') -Force
Copy-Item -LiteralPath $VdaLicense -Destination (Join-Path $FinalVdaDir 'LICENSE.txt') -Force
[IO.File]::WriteAllText((Join-Path $FinalVdaDir 'SOURCE_COMMIT.txt'), ($VdaCommit + [Environment]::NewLine), [Text.Encoding]::ASCII)
$finalVda = Join-Path $FinalVdaDir 'VirtualDesktopAccessor.dll'
$vdaHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $finalVda).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $FinalVdaDir 'SHA256SUMS.txt'), ($vdaHash + '  VirtualDesktopAccessor.dll' + [Environment]::NewLine), [Text.Encoding]::ASCII)

$hostArch = [string]$env:PROCESSOR_ARCHITECTURE
$nativeTarget = ($Target -eq 'win-x64' -and $hostArch -eq 'AMD64') -or ($Target -eq 'win-arm64' -and $hostArch -eq 'ARM64')
if ($nativeTarget) {
    $previousVda = $env:DESKTOP_MCP_VDA_PATH
    try {
        $env:DESKTOP_MCP_VDA_PATH = Join-Path $FinalVdaDir 'VirtualDesktopAccessor.dll'
        $infoText = (& $FinalHost info 2>&1 | Out-String).Trim()
        Require ($LASTEXITCODE -eq 0) ('Agent Desktop Host self-test failed: ' + $infoText)
        $info = $infoText | ConvertFrom-Json
        Require ($info.officialApi -eq $true -and $info.virtualDesktopAccessor -eq $true) 'Agent Desktop Host did not report both Windows desktop backends available.'
        $flagText = (& $FinalHost self-test --show-no-activate 2>&1 | Out-String).Trim()
        Require ($LASTEXITCODE -eq 0) ('Agent Desktop Host boolean flag parser self-test failed: ' + $flagText)
        $flagInfo = $flagText | ConvertFrom-Json
        Require ($flagInfo.officialApi -eq $true -and $flagInfo.virtualDesktopAccessor -eq $true) 'Agent Desktop Host boolean flag parser self-test did not report both Windows desktop backends available.'
        Write-Output 'AGENT_DESKTOP_BOOLEAN_FLAG_SELF_TEST=PASS'
        Write-Output 'AGENT_DESKTOP_RUNTIME_SELF_TEST=PASS'
    } finally { $env:DESKTOP_MCP_VDA_PATH = $previousVda }
} else {
    Write-Output 'AGENT_DESKTOP_RUNTIME_SELF_TEST=SKIP_CROSS_ARCH'
}

Write-Output 'AGENT_DESKTOP_RUNTIME_BUILD_OK'
Write-Output ('TARGET=' + $Target)
Write-Output ('HOST=' + $FinalHost)
Write-Output ('VDA=' + (Join-Path $FinalVdaDir 'VirtualDesktopAccessor.dll'))
Write-Output ('VDA_COMMIT=' + $VdaCommit)
Write-Output ('HOST_PE_MACHINE=0x{0:X4}' -f $hostMachine)
Write-Output ('VDA_PE_MACHINE=0x{0:X4}' -f $vdaMachine)
