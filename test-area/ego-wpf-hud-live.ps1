# Candidate-only WPF HUD placement test. Requires a genuine currently active D2
# lease acquired by DeskMCP first. Never creates/stops leases, switches desktops,
# starts a second Control Panel, or writes installed data.
param(
  [Parameter(Mandatory=$true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$LeaseId,
  [ValidateRange(1500,15000)]
  [int]$DurationMs=4000
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$app=Join-Path $root 'runtime\csharp-check\wpf-candidate\DeskMCP.AgentDesktopHost.exe'
$installed=Join-Path $env:LOCALAPPDATA 'Programs\DesktopMCP\DeskMCP.AgentDesktopHost.exe'
$controlFile=Join-Path $env:LOCALAPPDATA 'DesktopMCP\agent-desktop\control.json'
if(!(Test-Path -LiteralPath $app -PathType Leaf)){throw 'Build candidate HUD probe first'}
if(!(Test-Path -LiteralPath $controlFile -PathType Leaf)){throw 'Agent Desktop lease missing'}
$before=(& $installed current-desktop | ConvertFrom-Json)
if($before.desktopNumber -ne 1){throw 'Current user desktop is not Desktop 1; abort test'}
$control=@((Get-Content -LiteralPath $controlFile -Raw|ConvertFrom-Json).controls |
  Where-Object {$_.leaseId -eq $LeaseId}) | Select-Object -First 1
if(!$control){throw 'Expected live candidate test lease not found'}
if($control.desktopNumber -ne 2){throw 'Only Desktop 2 test leases are allowed'}
& $app --hud-placement-probe $control.desktopId $LeaseId $DurationMs
$rc=$LASTEXITCODE
if($rc -ne 0){throw ('Real WPF HUD candidate placement check failed: '+$rc)}
$after=(& $installed current-desktop | ConvertFrom-Json)
if($after.desktopNumber -ne 1 -or $after.desktopId -ne $before.desktopId){
  throw 'Current user desktop identity changed during WPF HUD test'
}
Write-Output 'WPF_CANDIDATE_HUD_TEST_PASS'
Write-Output 'DESKTOP_1_IDENTITY_BEFORE_AFTER=PASS'
exit 0
