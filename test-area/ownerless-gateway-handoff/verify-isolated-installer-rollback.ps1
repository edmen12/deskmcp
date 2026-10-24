$ErrorActionPreference='Stop'
$recovery='C:\Users\User\Desktop\DeskMCP\runtime\recovery\installed-343ba99-20261024'
$setup='C:\Users\User\Desktop\DeskMCP\runtime\release\DeskMCP-Setup-0.9.23.exe'
$smokeParent='C:\Users\User\Desktop\DeskMCP\runtime\i\rb-20261024'
$fixture=Join-Path $smokeParent 'D'
$state='C:\Users\User\Desktop\DeskMCP\runtime\irs\rb-20261024'
$report='C:\Users\User\Desktop\DeskMCP\runtime\recovery\rollback-fixture-20261024-evidence.json'
$prodRoot='C:\Users\User\AppData\Local\DesktopMCP\agent-desktop\control.json'
$installedExe='C:\Users\User\AppData\Local\Programs\DesktopMCP\DeskMCP.exe'
$result=[ordered]@{
 status='NOT_STARTED';setupSourceCommit='f8b1cd3f2aac107aaa13378cded79878d1aa6eff'
 testedInstalledCommit='343ba9974015b8bea3b44d0320e1eb9562d90984'
 sourceReleaseIsNotCandidate=$true;fixtureProtectedFilesCopied=0
 failureAfterBackupExitCode=$null;failedUpgradeRestoredPrevious=$false
 interruptedUpgradeRecoveryExitCode=$null;interruptedUpgradeRestoredPrevious=$false
 fixturePayloadIntegrityVerified=$false
 productionStateUnchanged=$false;productionProcessPreserved=$false
 registryAndStartupNotModifiedByTestMode=$true;error=''
}
function VerifyManifest([string]$directory){
 $lines=Get-Content -LiteralPath (Join-Path $directory 'install-integrity.sha256') -ErrorAction Stop
 $n=0
 foreach($line in $lines){
  if($line -notmatch '^([0-9a-fA-F]{64})  (.+)$'){throw 'ROLLBACK_MANIFEST_FORMAT_ERROR'}
  $relative=$Matches[2].Replace('/','\')
  if($relative.Contains('..') -or [IO.Path]::IsPathRooted($relative)){throw 'ROLLBACK_MANIFEST_UNSAFE_RELATIVE_PATH'}
  $full=Join-Path $directory $relative
  if(!(Test-Path $full -PathType Leaf)){throw ('MISSING_'+$relative)}
  if((Get-FileHash $full -Algorithm SHA256).Hash -ine $Matches[1]){throw ('HASH_MISMATCH_'+$relative)}
  $n++
 }
 if($n -ne 32){throw ('ROLLBACK_MANIFEST_ENTRY_COUNT_'+$n)}
 return $n
}
try {
 if(!(Test-Path -LiteralPath $recovery) -or !(Test-Path -LiteralPath $setup)){throw 'RECOVERY_OR_SETUP_MISSING'}
 if(Test-Path -LiteralPath $smokeParent){throw 'ISOLATED_TEST_ROOT_ALREADY_EXISTS_REFUSING_OVERWRITE'}
 if(Test-Path -LiteralPath $state){throw 'ISOLATED_TEST_STATE_ALREADY_EXISTS_REFUSING_OVERWRITE'}
 $prodHash=(Get-FileHash -LiteralPath $prodRoot -Algorithm SHA256).Hash
 $guiBefore=@(Get-CimInstance Win32_Process -Filter "name='DeskMCP.exe'" | Where-Object {$_.ExecutablePath -ieq $installedExe} | Select-Object -ExpandProperty ProcessId)
 if($guiBefore.Count -ne 1){throw 'PRODUCTION_CONTROL_PANEL_PRECHECK_FAIL'}
 $rc=(Get-Content -LiteralPath (Join-Path $recovery 'release-target.json') -Raw|ConvertFrom-Json).sourceCommit
 if($rc -ne $result.testedInstalledCommit){throw 'RECOVERY_BASELINE_COMMIT_MISMATCH'}
 $check=VerifyManifest $recovery
 if($check -ne 32){throw 'RECOVERY_MANIFEST_MISMATCH'}
 New-Item -Path $fixture -ItemType Directory -Force|Out-Null
 New-Item -Path $state -ItemType Directory -Force|Out-Null
 $manifest=Get-Content -LiteralPath (Join-Path $recovery 'install-integrity.sha256')
 foreach($line in $manifest){
  $relative=$line.Substring(66).Replace('/','\')
  $destination=Join-Path $fixture $relative
  New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $recovery $relative) -Destination $destination -ErrorAction Stop
 }
 Copy-Item -LiteralPath (Join-Path $recovery 'install-integrity.sha256') -Destination (Join-Path $fixture 'install-integrity.sha256')
 $result.fixtureProtectedFilesCopied=VerifyManifest $fixture
 $marker=Join-Path $fixture 'KEEP_343BA99_OLD_INSTALL.txt'
 Set-Content -LiteralPath $marker -Value 'must-survive-injected-upgrade-failure' -Encoding ASCII
 $env:DESKTOP_MCP_DATA_ROOT=Join-Path $state 'local'
 $env:DESKTOP_MCP_SETTINGS_DIR=Join-Path $state 'roaming'
 $env:DESKTOP_MCP_PORT='59125'
 $env:DESKTOP_MCP_INSTANCE_NAMESPACE='rollback-test-343ba99-20261024'
 $env:DESKTOP_MCP_INSTALLER_MUTEX_NAMESPACE='rollback-test-343ba99-20261024'
 $env:DESKTOP_MCP_STARTUP_LINK_PATH=Join-Path $state 'startup\DeskMCP.lnk'
 $env:DESKTOP_MCP_TUNNEL_PROFILE_PATH=Join-Path $state 'tunnel\desktop-mcp.yaml'
 $env:DESKTOP_MCP_DISABLE_TUNNEL='1'
 # No UI action: the Setup test flag disables shortcuts, registry, launch and auto-start.
 $p=Start-Process -FilePath $setup -ArgumentList @('--install-test-fail-after-backup',('"'+$fixture+'"')) -WindowStyle Hidden -PassThru -Wait
 $result.failureAfterBackupExitCode=$p.ExitCode
 if($p.ExitCode -ne 10){throw ('INJECTED_FAILURE_RETURNED_'+$p.ExitCode)}
 if(!(Test-Path -LiteralPath $marker)){throw 'OLD_INSTALL_MARKER_NOT_RESTORED'}
 if((VerifyManifest $fixture) -ne 32){throw 'RESTORED_OLD_INSTALL_INTEGRITY_FAILED'}
 if(@(Get-ChildItem -LiteralPath $smokeParent -Directory -Filter 'D.backup-*' -ErrorAction SilentlyContinue).Count -ne 0){throw 'ROLLBACK_LEFT_BACKUP_DIRECTORY'}
 if(@(Get-ChildItem -LiteralPath $smokeParent -Directory -Filter 'D.install-*' -ErrorAction SilentlyContinue).Count -ne 0){throw 'ROLLBACK_LEFT_STAGING_DIRECTORY'}
 $result.failedUpgradeRestoredPrevious=$true
 # Simulated sudden power loss: move a valid old fixture to installer backup
 # and leave a broken .install-* directory. Recovery must restore the backup.
 $backup=$fixture+'.backup-simulated'
 $temp=$fixture+'.install-simulated'
 Move-Item -LiteralPath $fixture -Destination $backup
 New-Item -Path $temp -ItemType Directory -Force|Out-Null
 Set-Content -LiteralPath (Join-Path $temp 'partial.txt') -Value 'incomplete-upgrade' -Encoding ASCII
 $rec=Start-Process -FilePath $setup -ArgumentList @('--recover-test',('"'+$fixture+'"')) -WindowStyle Hidden -PassThru -Wait
 $result.interruptedUpgradeRecoveryExitCode=$rec.ExitCode
 if($rec.ExitCode -ne 0){throw ('INTERRUPTED_RECOVERY_RETURNED_'+$rec.ExitCode)}
 if(!(Test-Path -LiteralPath $marker)){throw 'INTERRUPTED_RECOVERY_MARKER_MISSING'}
 if((VerifyManifest $fixture) -ne 32){throw 'RECOVERED_FIXTURE_MANIFEST_INVALID'}
 if((Test-Path -LiteralPath $temp) -or (Test-Path -LiteralPath $backup)){throw 'RECOVERY_LEFT_TEMP_OR_BACKUP'}
 $result.interruptedUpgradeRestoredPrevious=$true
 $result.fixturePayloadIntegrityVerified=$true
 $result.status='ISOLATED_EXISTING_INSTALLER_ROLLBACK_AND_RECOVERY_PASS'
}catch{
 $result.status='ISOLATED_EXISTING_INSTALLER_ROLLBACK_AND_RECOVERY_FAIL'
 $result.error=$_.Exception.Message
}finally{
 try{
  $result.productionStateUnchanged=((Get-FileHash -LiteralPath $prodRoot -Algorithm SHA256).Hash -eq $prodHash)
  $guiAfter=@(Get-CimInstance Win32_Process -Filter "name='DeskMCP.exe'" | Where-Object {$_.ExecutablePath -ieq $installedExe} | Select-Object -ExpandProperty ProcessId)
  $result.productionProcessPreserved=$guiAfter.Count -eq 1 -and $guiAfter[0] -eq $guiBefore[0]
 }catch{}
 if(Test-Path -LiteralPath $smokeParent){Remove-Item -LiteralPath $smokeParent -Recurse -Force -ErrorAction SilentlyContinue}
 if(Test-Path -LiteralPath $state){Remove-Item -LiteralPath $state -Recurse -Force -ErrorAction SilentlyContinue}
 $result|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $report
 Write-Output ('ISOLATED_INSTALLER_ROLLBACK='+($result|ConvertTo-Json -Depth 5 -Compress))
}
if($result.status -ne 'ISOLATED_EXISTING_INSTALLER_ROLLBACK_AND_RECOVERY_PASS' -or !$result.productionStateUnchanged -or !$result.productionProcessPreserved){exit 2}
