param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^tunnel_[A-Za-z0-9_-]+$')]
  [string]$TunnelId
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TunnelClient = Join-Path $Root 'tools\tunnel-client\v0.0.13\bin\tunnel-client.exe'

if (-not (Test-Path $TunnelClient)) {
  throw "tunnel-client not found at $TunnelClient"
}

& $TunnelClient init `
  --sample sample_mcp_remote_no_auth `
  --profile desktop-mcp `
  --tunnel-id $TunnelId `
  --mcp-server-url 'http://127.0.0.1:8765/mcp'

if ($LASTEXITCODE -ne 0) {
  throw "tunnel-client init failed with exit code $LASTEXITCODE"
}

Write-Output 'DeskMCP tunnel profile initialized: desktop-mcp'
Write-Output 'Next: set CONTROL_PLANE_API_KEY in this process environment, then run doctor-tunnel.ps1.'
