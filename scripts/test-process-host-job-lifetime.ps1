param(
    [Parameter(Mandatory=$true)][string]$ProcessHostPath
)
$ErrorActionPreference = 'Stop'

function Require([bool]$Condition,[string]$Message) {
    if(-not $Condition){ throw $Message }
}

$ProcessHostPath = [IO.Path]::GetFullPath($ProcessHostPath)
Require (Test-Path -LiteralPath $ProcessHostPath) ('ProcessHost is missing: ' + $ProcessHostPath)
$root = Join-Path $env:TEMP ('deskmcp-process-host-lifetime-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null

function Invoke-LifetimeProbe([string]$Mode,[string]$MarkerName) {
    $marker = Join-Path $root $MarkerName
    if($marker -match '\s'){ throw 'ProcessHost lifetime test marker path unexpectedly contains whitespace.' }
    $outerCommand = 'start "" /b cmd.exe /d /c "ping -n 3 127.0.0.1 >nul && echo PASS>' + $marker + '" & exit /b 0'
    $outerCommand64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($outerCommand))
    $timer = [Diagnostics.Stopwatch]::StartNew()
    & $ProcessHostPath --shell cmd.exe --command64 $outerCommand64 --window-mode hidden --elevation standard --lifetime $Mode
    $exitCode = $LASTEXITCODE
    $timer.Stop()
    return [pscustomobject]@{ ExitCode=$exitCode; ElapsedMs=$timer.ElapsedMilliseconds; Marker=$marker }
}

try {
    $rootProbe = Invoke-LifetimeProbe 'root' 'root-marker.txt'
    Require ($rootProbe.ExitCode -eq 0) ('root lifetime exited with ' + $rootProbe.ExitCode)
    Start-Sleep -Milliseconds 2500
    Require (-not (Test-Path -LiteralPath $rootProbe.Marker)) 'root lifetime allowed a descendant to daemonize.'
    Write-Output 'PROCESS_HOST_ROOT_LIFETIME=PASS'

    $jobProbe = Invoke-LifetimeProbe 'job' 'job-marker.txt'
    Require ($jobProbe.ExitCode -eq 0) ('job lifetime exited with ' + $jobProbe.ExitCode)
    Require (Test-Path -LiteralPath $jobProbe.Marker) 'job lifetime returned before its descendant completed.'
    Require ($jobProbe.ElapsedMs -ge 1200) ('job lifetime returned too early: ' + $jobProbe.ElapsedMs + 'ms')
    Write-Output ('PROCESS_HOST_JOB_LIFETIME=PASS elapsed_ms=' + $jobProbe.ElapsedMs)
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
