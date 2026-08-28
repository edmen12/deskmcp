$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TunnelClient = Join-Path $Root 'tools\tunnel-client\v0.0.13\bin\tunnel-client.exe'

if (-not (Test-Path $TunnelClient)) {
  throw "tunnel-client not found at $TunnelClient"
}

if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
  throw 'CONTROL_PLANE_API_KEY is not set in the current process environment.'
}

& $TunnelClient run --profile desktop-mcp
exit $LASTEXITCODE
