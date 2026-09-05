param(
    [ValidateSet('win-x64','win-arm64')]
    [string]$Target = $(if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64'){'win-arm64'}else{'win-x64'})
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ProcessHost = Join-Path $ProjectRoot ('runtime\process-host\' + $Target + '\DeskMCP.ProcessHost.exe')
if(-not (Test-Path -LiteralPath $ProcessHost)){ throw ('ProcessHost is missing: ' + $ProcessHost) }

$RunRoot = Join-Path ([IO.Path]::GetTempPath()) ('deskmcp-hidden-admin-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($RunRoot) | Out-Null
$Marker = Join-Path $RunRoot 'marker.txt'
$ErrorFile = Join-Path $RunRoot 'error.txt'

try {
    $Command = 'echo HIDDEN_ADMIN_OK>"' + $Marker + '"'
    $Command64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command))
    $ErrorFile64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ErrorFile))
    $Arguments = @(
        '--elevated-child',
        '--owner-pid', [string]$PID,
        '--shell', 'cmd.exe',
        '--command64', $Command64,
        '--window-mode', 'hidden',
        '--elevation', 'admin',
        '--error-file64', $ErrorFile64
    )

    $Process = Start-Process -FilePath $ProcessHost -ArgumentList $Arguments -WindowStyle Hidden -PassThru -Wait
    if($Process.ExitCode -ne 0){
        $Detail = if(Test-Path -LiteralPath $ErrorFile){ Get-Content -LiteralPath $ErrorFile -Raw }else{ '' }
        throw ('Hidden admin ProcessHost smoke failed: exit=' + $Process.ExitCode + ' ' + $Detail)
    }
    if(-not (Test-Path -LiteralPath $Marker)){ throw 'Hidden admin ProcessHost did not execute the owned command.' }
    $Text = (Get-Content -LiteralPath $Marker -Raw).Trim()
    if($Text -ne 'HIDDEN_ADMIN_OK'){ throw ('Unexpected hidden admin marker: ' + $Text) }
    Write-Output 'PROCESS_HOST_HIDDEN_ADMIN=PASS'
} finally {
    Remove-Item -LiteralPath $RunRoot -Recurse -Force -ErrorAction SilentlyContinue
}
