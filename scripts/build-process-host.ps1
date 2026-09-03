param([string]$Target = '')
$ErrorActionPreference = 'Stop'
if([string]::IsNullOrWhiteSpace($Target)){
    $Target = if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64'){'win-arm64'}else{'win-x64'}
}
if($Target -notin @('win-x64','win-arm64')){throw ('Unsupported ProcessHost target: ' + $Target)}
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-targets.ps1')
$TargetConfig = Get-DeskMcpReleaseTarget $Target
$RuntimeRoot = Join-Path $ProjectRoot 'runtime'
$Project = Join-Path $ProjectRoot 'process-host\DeskMCP.ProcessHost.csproj'
$Output = Join-Path $RuntimeRoot ('process-host\' + $Target)

function Require([bool]$Condition,[string]$Message) { if(-not $Condition){ throw $Message } }
function Get-PeMachine([string]$Path) {
    $bytes=[IO.File]::ReadAllBytes($Path)
    Require ($bytes.Length -ge 128) ('PE file is unexpectedly small: ' + $Path)
    $offset=[BitConverter]::ToInt32($bytes,0x3c)
    Require ($offset -ge 0 -and ($offset + 6) -lt $bytes.Length) ('Invalid PE header: ' + $Path)
    return [BitConverter]::ToUInt16($bytes,$offset + 4)
}

$localDotnet=Join-Path $RuntimeRoot 'dotnet-sdk\dotnet.exe'
$dotnet=if(Test-Path -LiteralPath $localDotnet){$localDotnet}else{(Get-Command dotnet.exe -ErrorAction Stop).Source}
Require (Test-Path -LiteralPath $Project) 'DeskMCP ProcessHost project is missing.'
if(Test-Path -LiteralPath $Output){Remove-Item -LiteralPath $Output -Recurse -Force}
& $dotnet publish $Project -c Release -r $TargetConfig.DotnetRid --self-contained true -p:PublishSingleFile=false -o $Output --nologo
if($LASTEXITCODE -ne 0){throw ('ProcessHost publish failed: ' + $LASTEXITCODE)}

$exe=Join-Path $Output 'DeskMCP.ProcessHost.exe'
foreach($name in @('DeskMCP.ProcessHost.exe','DeskMCP.ProcessHost.dll','DeskMCP.ProcessHost.deps.json','DeskMCP.ProcessHost.runtimeconfig.json')){
    Require (Test-Path -LiteralPath (Join-Path $Output $name)) ('ProcessHost output is missing: ' + $name)
}
$machine=Get-PeMachine $exe
Require ($machine -eq $TargetConfig.PeMachine) ('ProcessHost PE architecture mismatch: 0x{0:X4}' -f $machine)
Write-Output 'PROCESS_HOST_BUILD_OK'
Write-Output ('TARGET=' + $Target)
Write-Output ('OUTPUT=' + $Output)
Write-Output ('PE_MACHINE=0x{0:X4}' -f $machine)
