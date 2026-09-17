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
    $escapedMarker = $marker.Replace("'", "''")
    $childCommand = "Start-Sleep -Milliseconds 800; [IO.File]::WriteAllText('$escapedMarker','PASS')"
    $childCommand64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))
    $outerCommand = "Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-EncodedCommand','$childCommand64') -WindowStyle Hidden | Out-Null; exit 0"
    $outerCommand64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($outerCommand))
    $timer = [Diagnostics.Stopwatch]::StartNew()
    & $ProcessHostPath --shell powershell.exe --command64 $outerCommand64 --window-mode hidden --elevation standard --lifetime $Mode
    $exitCode = $LASTEXITCODE
    $timer.Stop()
    return [pscustomobject]@{ ExitCode=$exitCode; ElapsedMs=$timer.ElapsedMilliseconds; Marker=$marker }
}

try {
    $rootProbe = Invoke-LifetimeProbe 'root' 'root-marker.txt'
    Require ($rootProbe.ExitCode -eq 0) ('root lifetime exited with ' + $rootProbe.ExitCode)
    Start-Sleep -Milliseconds 1200
    Require (-not (Test-Path -LiteralPath $rootProbe.Marker)) 'root lifetime allowed a descendant to daemonize.'
    Write-Output 'PROCESS_HOST_ROOT_LIFETIME=PASS'

    $jobProbe = Invoke-LifetimeProbe 'job' 'job-marker.txt'
    Require ($jobProbe.ExitCode -eq 0) ('job lifetime exited with ' + $jobProbe.ExitCode)
    Require (Test-Path -LiteralPath $jobProbe.Marker) 'job lifetime returned before its descendant completed.'
    Require ($jobProbe.ElapsedMs -ge 500) ('job lifetime returned too early: ' + $jobProbe.ElapsedMs + 'ms')
    Write-Output ('PROCESS_HOST_JOB_LIFETIME=PASS elapsed_ms=' + $jobProbe.ElapsedMs)
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
