$ErrorActionPreference = 'Stop'
$localDotnet = Join-Path $PSScriptRoot '..\..\runtime\dotnet-sdk\dotnet.exe'
$dotnet = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } else { (Get-Command dotnet.exe -ErrorAction Stop).Source }
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
& $dotnet build (Join-Path $PSScriptRoot 'DeskMCP.ControlPanel.csproj') -c Release --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$env:DOTNET_ROOT = Split-Path $dotnet -Parent
$exe = Join-Path $PSScriptRoot 'bin\Release\net10.0-windows\DeskMCP.exe'
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
    @{ Arg='--capture-full-modal-dark'; File=(Join-Path $runtime 'validation-full-modal-dark.png'); Label='FULL_MODAL_DARK_OK' }
)
foreach ($capture in $captures) {
    Remove-Item -LiteralPath $capture.File -Force -ErrorAction SilentlyContinue
    $p = Start-Process -FilePath $exe -ArgumentList ($capture.Arg + ' "' + $capture.File + '"') -PassThru -Wait
    if ($p.ExitCode -ne 0) { exit $p.ExitCode }
    if (-not (Test-Path -LiteralPath $capture.File)) { throw ('Capture missing: ' + $capture.Arg) }
}
Write-Output 'BUILD_OK net10.0-windows'
foreach ($capture in $captures) { Write-Output ($capture.Label + ' bytes=' + (Get-Item -LiteralPath $capture.File).Length) }
