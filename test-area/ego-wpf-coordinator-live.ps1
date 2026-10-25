# Candidate-only real ControlCoordinator Tick() / HUD heartbeat / safety-revocation
# integration test. Must be called with a REAL active controlled Desktop 2 lease.
# ALL candidate coordinator control/lock/HUD files are isolated by the test
# executable. No second ControlPanel Start(), hook, Gateway or service.
param(
  [Parameter(Mandatory=$true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$LeaseId,
  [ValidateRange(2500,14000)]
  [int]$DurationMs=5000
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$app=Join-Path $root 'runtime\csharp-check\wpf-candidate\DeskMCP.AgentDesktopHost.exe'
$native=Join-Path $env:LOCALAPPDATA 'Programs\DesktopMCP\DeskMCP.AgentDesktopHost.exe'
$control=Join-Path $env:LOCALAPPDATA 'DesktopMCP\agent-desktop\control.json'
if(!(Test-Path -LiteralPath $app -PathType Leaf)){throw 'Run build-ego-wpf-hud-candidate.ps1 first'}
$before=& $native current-desktop | ConvertFrom-Json
if($before.desktopNumber -ne 1){throw 'Desktop 1 is not currently active; refusing probe'}
$items=@((Get-Content -LiteralPath $control -Raw | ConvertFrom-Json).controls)
$live=@($items | Where-Object {$_.leaseId -eq $LeaseId}) | Select-Object -First 1
if(!$live -or $live.desktopNumber -ne 2){throw 'No live DeskMCP Desktop 2 lease for this probe'}
& $app --coordinator-isolated-probe $live.desktopId $LeaseId $DurationMs
$code=$LASTEXITCODE
if($code -ne 0){throw "Isolated WPF coordinator failed: $code"}
$after=& $native current-desktop | ConvertFrom-Json
if($after.desktopNumber -ne 1 -or $after.desktopId -ne $before.desktopId){throw 'Desktop 1 switched'}
Write-Output 'WPF_ISOLATED_COORDINATOR_REAL_TICK=PASS'
Write-Output 'DESKTOP_1_BEFORE_AFTER_UNCHANGED=PASS'
exit 0
