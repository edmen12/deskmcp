# Read-only RELEASE GATE, not runtime proof of process identity.
# A signed Panel and signed native helper must share the explicitly pinned
# publisher certificate thumbprint and their canonical installation directory.
# Do not treat a path, parent PID, or a random trusted certificate as sufficient.
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')]
  [string]$PinnedPublisherThumbprint,
  [string]$InstallRoot="$env:LOCALAPPDATA\Programs\DesktopMCP",
  [string]$NativeSignerPath=""
)
Set-StrictMode -Version Latest
$ErrorActionPreference="Stop"
function Fail([string]$reason) {
  Write-Output ("RELEASE_IDENTITY_BLOCKED: "+$reason)
  exit 3
}
try {
  $root=[IO.Path]::GetFullPath($InstallRoot).TrimEnd('\','/')
  $panel=[IO.Path]::GetFullPath([IO.Path]::Combine($root,'DeskMCP.exe'))
  $native=if([string]::IsNullOrWhiteSpace($NativeSignerPath)) {
    [IO.Path]::GetFullPath([IO.Path]::Combine($root,'DeskMCP.BrowserHuman.exe'))
  } else {[IO.Path]::GetFullPath($NativeSignerPath)}
  if(!(Test-Path -LiteralPath $panel -PathType Leaf)) { Fail "Panel executable missing" }
  if(!(Test-Path -LiteralPath $native -PathType Leaf)) { Fail "Native Hello helper missing" }
  if([IO.Path]::GetDirectoryName($panel) -ine [IO.Path]::GetDirectoryName($native)) {
    Fail "Panel and native broker must share the exact installation directory"
  }
  $pin=$PinnedPublisherThumbprint.ToUpperInvariant()
  foreach($item in @($panel,$native)) {
    $signature=Get-AuthenticodeSignature -LiteralPath $item
    if($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
      Fail ("Unsigned or invalid Authenticode identity: "+[IO.Path]::GetFileName($item))
    }
    $thumb=$signature.SignerCertificate.Thumbprint.ToUpperInvariant()
    if($thumb -cne $pin) {
      Fail ("Publisher certificate pin mismatch: "+[IO.Path]::GetFileName($item))
    }
  }
  Write-Output "RELEASE_IDENTITY_PASS: both executables have the pinned publisher signature."
  exit 0
} catch {
  Write-Output "RELEASE_IDENTITY_BLOCKED: policy could not complete"
  exit 3
}
