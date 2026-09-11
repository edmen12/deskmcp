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

$OutputParent=Split-Path -Parent $Output
New-Item -ItemType Directory -Path $OutputParent -Force | Out-Null
$suffix=('{0}-{1}' -f $PID,[Guid]::NewGuid().ToString('N'))
$staging=Join-Path $OutputParent ('.' + $Target + '.build-' + $suffix)
$backup=Join-Path $OutputParent ('.' + $Target + '.backup-' + $suffix)
$hadOutput=Test-Path -LiteralPath $Output
$switched=$false
$machine=$null

try {
    & $dotnet publish $Project -c Release -r $TargetConfig.DotnetRid --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $staging --nologo
    if($LASTEXITCODE -ne 0){throw ('ProcessHost publish failed: ' + $LASTEXITCODE)}

    $stagedExe=Join-Path $staging 'DeskMCP.ProcessHost.exe'
    Require (Test-Path -LiteralPath $stagedExe) 'ProcessHost staging output is missing: DeskMCP.ProcessHost.exe'
    foreach($forbidden in @('DeskMCP.ProcessHost.dll','DeskMCP.ProcessHost.deps.json','DeskMCP.ProcessHost.runtimeconfig.json')){
        Require (-not (Test-Path -LiteralPath (Join-Path $staging $forbidden))) ('ProcessHost publish is not single-file: ' + $forbidden)
    }
    $machine=Get-PeMachine $stagedExe
    Require ($machine -eq $TargetConfig.PeMachine) ('ProcessHost PE architecture mismatch: 0x{0:X4}' -f $machine)

    if($hadOutput){Move-Item -LiteralPath $Output -Destination $backup -ErrorAction Stop}
    try {
        Move-Item -LiteralPath $staging -Destination $Output -ErrorAction Stop
        $switched=$true
    }
    catch {
        if($hadOutput -and (Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $Output)){
            Move-Item -LiteralPath $backup -Destination $Output -ErrorAction Stop
        }
        throw
    }

    Require (Test-Path -LiteralPath (Join-Path $Output 'DeskMCP.ProcessHost.exe')) 'ProcessHost final output is missing after publish switch.'
    if(Test-Path -LiteralPath $backup){
        try { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop }
        catch { Write-Warning ('Could not remove previous ProcessHost backup: ' + $_.Exception.Message) }
    }
}
finally {
    if(Test-Path -LiteralPath $staging){Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue}
    if(-not $switched -and $hadOutput -and (Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $Output)){
        Move-Item -LiteralPath $backup -Destination $Output -ErrorAction Stop
    }
}

Write-Output 'PROCESS_HOST_BUILD_OK'
Write-Output ('TARGET=' + $Target)
Write-Output ('OUTPUT=' + $Output)
Write-Output ('PE_MACHINE=0x{0:X4}' -f $machine)
