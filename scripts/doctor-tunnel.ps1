$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'resolve-tunnel-client.ps1')
$TunnelClient = Resolve-DeskMcpTunnelClient -ProjectRoot $Root

if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
  throw 'CONTROL_PLANE_API_KEY is not set in the current process environment.'
}

& $TunnelClient doctor --profile desktop-mcp --explain
if ($LASTEXITCODE -ne 0) {
  throw "tunnel-client doctor failed with exit code $LASTEXITCODE"
}
