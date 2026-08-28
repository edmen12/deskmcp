$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Setup = Join-Path $ProjectRoot 'runtime\release\DeskMCP-Setup-0.9.0.exe'
$SmokeRoot = Join-Path $ProjectRoot 'runtime\install-smoke\DesktopMCP'
function Require([bool]$Condition,[string]$Message){ if(-not $Condition){ throw $Message } }
function Wait-Gone([string]$Path){ for($i=0;$i -lt 25;$i++){ if(-not(Test-Path -LiteralPath $Path)){ return }; Start-Sleep -Seconds 1 }; throw "Path remained: $Path" }
Require (Test-Path -LiteralPath $Setup) 'Setup is missing.'
if(Test-Path -LiteralPath $SmokeRoot){ Remove-Item -LiteralPath $SmokeRoot -Recurse -Force }
Write-Output 'TEST=install'
$p=Start-Process -FilePath $Setup -ArgumentList @('--install-test',('"'+$SmokeRoot+'"')) -Wait -PassThru
Require ($p.ExitCode -eq 0) "Install exit=$($p.ExitCode)"
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'DeskMCP.exe')) 'Panel missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'DeskMCPUninstaller.exe')) 'Uninstaller missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'node\node.exe')) 'Node missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'LICENSE')) 'Apache-2.0 project LICENSE missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'THIRD_PARTY_NOTICES.md')) 'Third-party notices missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\production-node-packages.csv')) 'Production Node license inventory missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\dotnet\LICENSE.txt')) '.NET distribution license missing.'
Require (Test-Path -LiteralPath (Join-Path $SmokeRoot 'licenses\dotnet\ThirdPartyNotices.txt')) '.NET third-party notices missing.'
$marker=Join-Path $SmokeRoot 'UPGRADE_MARKER.txt'
Set-Content -LiteralPath $marker -Value 'old' -Encoding ASCII
Write-Output 'TEST=upgrade'
$u=Start-Process -FilePath $Setup -ArgumentList @('--install-test',('"'+$SmokeRoot+'"')) -Wait -PassThru
Require ($u.ExitCode -eq 0) "Upgrade exit=$($u.ExitCode)"
Require (-not(Test-Path -LiteralPath $marker)) 'Upgrade marker survived.'
$parent=Split-Path $SmokeRoot -Parent
Require (@(Get-ChildItem -LiteralPath $parent -Directory -Filter 'DesktopMCP.backup-*' -ErrorAction SilentlyContinue).Count -eq 0) 'Backup directory remained.'
Require (@(Get-ChildItem -LiteralPath $parent -Directory -Filter 'DesktopMCP.install-*' -ErrorAction SilentlyContinue).Count -eq 0) 'Install temp remained.'
Write-Output 'TEST=runtime'
$panelPath=Join-Path $SmokeRoot 'DeskMCP.exe'
$panel=Start-Process -FilePath $panelPath -ArgumentList '--startup' -WorkingDirectory $SmokeRoot -PassThru
$health=$null
for($i=0;$i -lt 90;$i++){ try{$health=Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 1; break}catch{Start-Sleep -Milliseconds 500} }
Require ($null -ne $health) 'Installed Gateway did not become healthy.'
Require ($health.version -eq '0.9.0') "Version=$($health.version)"
Require ($health.policy.profile -eq 'read-only') "Profile=$($health.policy.profile)"
$nodePath=[IO.Path]::GetFullPath((Join-Path $SmokeRoot 'node\node.exe'))
$nodes=@(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { try{ $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $nodePath }catch{$false} })
Require ($nodes.Count -eq 2) "Installed node count=$($nodes.Count)"
Write-Output 'TEST=uninstall'
$uninstaller=Join-Path $SmokeRoot 'DeskMCPUninstaller.exe'
$x=Start-Process -FilePath $uninstaller -ArgumentList @('--test-root',('"'+$SmokeRoot+'"')) -Wait -PassThru
Require ($x.ExitCode -eq 0) "Uninstall exit=$($x.ExitCode)"
Wait-Gone $SmokeRoot
$left=@(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { try{ $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $nodePath }catch{$false} })
Require ($left.Count -eq 0) "Installed node cleanup left=$($left.Count)"
try{ Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 1 | Out-Null; throw 'Gateway remained online.' }catch{ if($_.Exception.Message -like 'Gateway remained*'){ throw } }
$setupHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $Setup).Hash.ToLowerInvariant()
Write-Output 'INSTALLER_RELEASE_TEST_OK'
Write-Output ('SETUP_SHA256='+$setupHash)
Write-Output ('INSTALL_EXIT='+$p.ExitCode)
Write-Output ('UPGRADE_EXIT='+$u.ExitCode)
Write-Output ('UNINSTALL_EXIT='+$x.ExitCode)
Write-Output 'RUNTIME_PROFILE=read-only'
Write-Output 'RUNTIME_VERSION=0.9.0'
Write-Output 'INSTALLED_NODE_CLEANUP=OK'
