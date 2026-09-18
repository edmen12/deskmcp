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

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DeskMcpJobNameProbe {
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr OpenJobObjectW(uint access, bool inheritHandle, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@

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

function Invoke-NamedJobProbe {
    $token = [Guid]::NewGuid().ToString('N')
    $jobName = 'Local\DeskMCP.ProcessHost.Job.' + $token
    $command = 'Start-Sleep -Seconds 3'
    $command64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($command))
    $process = Start-Process -FilePath $ProcessHostPath -ArgumentList @(
        '--shell','powershell.exe','--command64',$command64,'--window-mode','hidden',
        '--elevation','standard','--lifetime','job','--job-token',$token
    ) -PassThru -WindowStyle Hidden
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(2)
        $handle = [IntPtr]::Zero
        do {
            $handle = [DeskMcpJobNameProbe]::OpenJobObjectW([uint32]4, $false, $jobName)
            if($handle -ne [IntPtr]::Zero){ break }
            Start-Sleep -Milliseconds 25
        } while([DateTime]::UtcNow -lt $deadline)
        Require ($handle -ne [IntPtr]::Zero) ('named job could not be reopened: ' + $jobName)
        [DeskMcpJobNameProbe]::CloseHandle($handle) | Out-Null
        $process.WaitForExit(5000) | Out-Null
        Require ($process.HasExited) 'named job probe ProcessHost did not exit after its child completed.'
        Require ($process.ExitCode -eq 0) ('named job probe ProcessHost exited with ' + $process.ExitCode)
        Write-Output 'PROCESS_HOST_NAMED_JOB=PASS'
    }
    finally {
        if(-not $process.HasExited){ Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
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

    Invoke-NamedJobProbe
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
