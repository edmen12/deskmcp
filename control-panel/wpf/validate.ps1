$ErrorActionPreference = 'Stop'
$localDotnet = Join-Path $PSScriptRoot '..\..\runtime\dotnet-sdk\dotnet.exe'
$dotnet = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } else { (Get-Command dotnet.exe -ErrorAction Stop).Source }
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
& $dotnet build (Join-Path $PSScriptRoot 'DeskMCP.ControlPanel.csproj') -c Release --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$env:DOTNET_ROOT = Split-Path $dotnet -Parent
$hostRid = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$exeCandidates = @(
    (Join-Path $PSScriptRoot ('bin\Release\net10.0-windows\' + $hostRid + '\DeskMCP.exe')),
    (Join-Path $PSScriptRoot 'bin\Release\net10.0-windows\DeskMCP.exe')
)
$exe = $exeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ([String]::IsNullOrWhiteSpace($exe)) { throw ('Control Panel validation executable is missing. Checked: ' + ($exeCandidates -join ', ')) }
$selfTests = @(
    @{ Arg='--runtime-reliability-self-test'; Label='RUNTIME_RELIABILITY_SELF_TEST' },
    @{ Arg='--tray-icon-self-test'; Label='TRAY_ICON_SELF_TEST' },
    @{ Arg='--tunnel-status-self-test'; Label='TUNNEL_STATUS_SELF_TEST' },
    @{ Arg='--agent-safe-isolation-self-test'; Label='AGENT_SAFE_ISOLATION_SELF_TEST' },
    @{ Arg='--agent-control-lock-self-test'; Label='AGENT_CONTROL_LOCK_SELF_TEST' },
    @{ Arg='--update-security-self-test'; Label='UPDATE_SECURITY_SELF_TEST' }
)
foreach ($entry in $selfTests) {
    $exitCode = $null
    if ($entry.Arg -eq '--agent-safe-isolation-self-test') {
        $isolationRoot = Join-Path $env:TEMP ('deskmcp-agent-safe-validate-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $isolationRoot -Force | Out-Null
        $oldStartup = $env:DESKTOP_MCP_STARTUP_LINK_PATH
        $oldTunnelProfile = $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH
        $oldDisableTunnel = $env:DESKTOP_MCP_DISABLE_TUNNEL
        try {
            $env:DESKTOP_MCP_STARTUP_LINK_PATH = Join-Path $isolationRoot 'startup.lnk'
            $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH = Join-Path $isolationRoot 'desktop-mcp.yaml'
            $env:DESKTOP_MCP_DISABLE_TUNNEL = '1'
            $selfTest = Start-Process -FilePath $exe -ArgumentList $entry.Arg -PassThru -Wait
            $exitCode = $selfTest.ExitCode
        }
        finally {
            if ($null -eq $oldStartup) { Remove-Item Env:DESKTOP_MCP_STARTUP_LINK_PATH -ErrorAction SilentlyContinue } else { $env:DESKTOP_MCP_STARTUP_LINK_PATH = $oldStartup }
            if ($null -eq $oldTunnelProfile) { Remove-Item Env:DESKTOP_MCP_TUNNEL_PROFILE_PATH -ErrorAction SilentlyContinue } else { $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH = $oldTunnelProfile }
            if ($null -eq $oldDisableTunnel) { Remove-Item Env:DESKTOP_MCP_DISABLE_TUNNEL -ErrorAction SilentlyContinue } else { $env:DESKTOP_MCP_DISABLE_TUNNEL = $oldDisableTunnel }
            Remove-Item -LiteralPath $isolationRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    else {
        $selfTest = Start-Process -FilePath $exe -ArgumentList $entry.Arg -PassThru -Wait
        $exitCode = $selfTest.ExitCode
    }
    if ($exitCode -ne 0) { throw ($entry.Label + ' failed: exit=' + $exitCode) }
    Write-Output ($entry.Label + '=PASS')
}
$runtime = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\runtime'))
$captures = @(
    @{ Arg='--capture'; File=(Join-Path $runtime 'validation-panel.png'); Label='XAML_CAPTURE_OK' },
    @{ Arg='--capture-dark'; File=(Join-Path $runtime 'validation-panel-dark.png'); Label='DARK_CAPTURE_OK' },
    @{ Arg='--capture-settings'; File=(Join-Path $runtime 'validation-settings.png'); Label='SETTINGS_CAPTURE_OK' },
    @{ Arg='--capture-settings-dark'; File=(Join-Path $runtime 'validation-settings-dark.png'); Label='SETTINGS_DARK_CAPTURE_OK' },
    @{ Arg='--capture-first-run'; File=(Join-Path $runtime 'validation-first-run-workspace.png'); Label='FIRST_RUN_WORKSPACE_OK' },
    @{ Arg='--capture-first-run-tunnel'; File=(Join-Path $runtime 'validation-first-run-tunnel.png'); Label='FIRST_RUN_TUNNEL_OK' },
    @{ Arg='--capture-first-run-plugin'; File=(Join-Path $runtime 'validation-first-run-plugin.png'); Label='FIRST_RUN_PLUGIN_OK' },
    @{ Arg='--capture-first-run-dark'; File=(Join-Path $runtime 'validation-first-run-workspace-dark.png'); Label='FIRST_RUN_WORKSPACE_DARK_OK' },
    @{ Arg='--capture-first-run-tunnel-dark'; File=(Join-Path $runtime 'validation-first-run-tunnel-dark.png'); Label='FIRST_RUN_TUNNEL_DARK_OK' },
    @{ Arg='--capture-first-run-plugin-dark'; File=(Join-Path $runtime 'validation-first-run-plugin-dark.png'); Label='FIRST_RUN_PLUGIN_DARK_OK' },
    @{ Arg='--capture-tunnel-modal'; File=(Join-Path $runtime 'validation-tunnel-modal.png'); Label='TUNNEL_MODAL_OK' },
    @{ Arg='--capture-tunnel-modal-dark'; File=(Join-Path $runtime 'validation-tunnel-modal-dark.png'); Label='TUNNEL_MODAL_DARK_OK' },
    @{ Arg='--capture-full-modal'; File=(Join-Path $runtime 'validation-full-modal.png'); Label='FULL_MODAL_OK' },
    @{ Arg='--capture-full-modal-dark'; File=(Join-Path $runtime 'validation-full-modal-dark.png'); Label='FULL_MODAL_DARK_OK' },
    @{ Arg='--capture-unlock-modal'; File=(Join-Path $runtime 'validation-unlock-modal.png'); Label='UNLOCK_MODAL_OK' },
    @{ Arg='--capture-unlock-modal-dark'; File=(Join-Path $runtime 'validation-unlock-modal-dark.png'); Label='UNLOCK_MODAL_DARK_OK' }
)
foreach ($capture in $captures) {
    Remove-Item -LiteralPath $capture.File -Force -ErrorAction SilentlyContinue
    $p = Start-Process -FilePath $exe -ArgumentList ($capture.Arg + ' "' + $capture.File + '"') -PassThru -Wait
    if ($p.ExitCode -ne 0) { exit $p.ExitCode }
    if (-not (Test-Path -LiteralPath $capture.File)) { throw ('Capture missing: ' + $capture.Arg) }
}
Write-Output 'BUILD_OK net10.0-windows'
foreach ($capture in $captures) { Write-Output ($capture.Label + ' bytes=' + (Get-Item -LiteralPath $capture.File).Length) }
