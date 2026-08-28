$ErrorActionPreference = 'Stop'
$secure = Read-Host 'OpenAI tunnel runtime API key' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$plain = $null

try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plain)) {
    throw 'Runtime API key cannot be empty.'
  }

  $env:CONTROL_PLANE_API_KEY = $plain
  & (Join-Path $PSScriptRoot 'doctor-tunnel.ps1')
  if ($LASTEXITCODE -ne 0) {
    throw "Tunnel doctor failed with exit code $LASTEXITCODE"
  }

  & (Join-Path $PSScriptRoot 'run-tunnel.ps1')
  exit $LASTEXITCODE
}
finally {
  Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
  $plain = $null
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
