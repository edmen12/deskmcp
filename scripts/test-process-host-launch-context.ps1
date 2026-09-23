param([Parameter(Mandatory=$true)][string]$ProcessHostPath)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$CaseRoot = Join-Path $ProjectRoot 'test-area\process-host-launch-context'
$Working = Join-Path $CaseRoot 'w'
$Temp = Join-Path $CaseRoot 't'

function Require([bool]$Condition,[string]$Message) {
    if(-not $Condition){ throw $Message }
}

if(-not (Test-Path -LiteralPath $ProcessHostPath)){ throw ('ProcessHost missing: ' + $ProcessHostPath) }
if(Test-Path -LiteralPath $CaseRoot){ Remove-Item -LiteralPath $CaseRoot -Recurse -Force }
New-Item -ItemType Directory -Path $Working -Force | Out-Null

try {
    $command = @'
Write-Output ('CWD=' + (Get-Location).Path)
Write-Output ('TEMP=' + $env:TEMP)
Write-Output ('TMP=' + $env:TMP)
'@
    $command64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($command))
    $working64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Working))
    $temp64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Temp))

    $output = (& $ProcessHostPath --shell powershell.exe --command64 $command64 --window-mode hidden --elevation standard --lifetime root --working-directory64 $working64 --temp-directory64 $temp64 | Out-String)
    $exitCode = $LASTEXITCODE

    Require ($exitCode -eq 0) ('ProcessHost launch-context test exit=' + $exitCode)
    Require (Test-Path -LiteralPath $Temp -PathType Container) 'ProcessHost did not create the requested temp directory.'
    Require ($output -match [regex]::Escape('CWD=' + $Working)) 'ProcessHost did not apply the requested working directory.'
    Require ($output -match [regex]::Escape('TEMP=' + $Temp)) 'ProcessHost did not apply the requested TEMP directory.'
    Require ($output -match [regex]::Escape('TMP=' + $Temp)) 'ProcessHost did not apply the requested TMP directory.'
    Write-Output 'PROCESS_HOST_LAUNCH_CONTEXT=PASS'
}
finally {
    if(Test-Path -LiteralPath $CaseRoot){ Remove-Item -LiteralPath $CaseRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
