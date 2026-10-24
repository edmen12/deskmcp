$ErrorActionPreference='Stop'
$installed='C:\Users\User\AppData\Local\Programs\DesktopMCP'
$expectedCommit='343ba9974015b8bea3b44d0320e1eb9562d90984'
$recoveryParent='C:\Users\User\Desktop\DeskMCP\runtime\recovery'
$snapshot=Join-Path $recoveryParent 'installed-343ba99-20261024'
$manifest='install-integrity.sha256'
$setup='C:\Users\User\Desktop\DeskMCP\runtime\release\DeskMCP-Setup-0.9.23.exe'
$result=[ordered]@{
 status='NOT_STARTED';originalPath=$installed;recoverySnapshot=$snapshot
 expectedSourceCommit=$expectedCommit;originalManifestChecked=0
 snapshotManifestChecked=0;snapshotFileCount=0;snapshotBytes=0
 originalFilesUnchanged=$false;fileNamesAndSizesEqual=$false
 rollbackIsByteIdenticalAtProtectedFiles=$false
 preexistingInstallerMatchesCurrent=$false
 setupIsNotExact=$true
 installedServiceRestarted=$false;installedFilesModified=$false
 error=''
}
function Assert-Manifest([string]$dir) {
 $lines=Get-Content -LiteralPath (Join-Path $dir $manifest) -ErrorAction Stop
 $checked=0
 foreach($line in $lines){
  if([string]::IsNullOrWhiteSpace($line)){continue}
  if($line -notmatch '^([0-9a-fA-F]{64})  (.+)$'){throw 'INSTALL_MANIFEST_PARSE_ERROR'}
  $expect=$Matches[1].ToLowerInvariant()
  $rel=$Matches[2].Replace('/','\')
  if([IO.Path]::IsPathRooted($rel) -or $rel.Contains('..')){throw 'INSTALL_MANIFEST_UNSAFE_PATH'}
  $file=Join-Path $dir $rel
  if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw ('INSTALL_MANIFEST_FILE_MISSING_'+$rel)}
  $actual=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if($actual -ne $expect){throw ('INSTALL_MANIFEST_HASH_MISMATCH_'+$rel)}
  $checked++
 }
 if($checked -lt 25){throw 'MANIFEST_PROTECTED_FILE_COUNT_TOO_LOW'}
 return $checked
}
function RelTable([string]$dir){
 $prefix=[IO.Path]::GetFullPath($dir).TrimEnd('\')+'\'
 $entries=Get-ChildItem -LiteralPath $dir -File -Recurse -Force -ErrorAction Stop
 $output=@{}
 foreach($f in $entries){
  if($f.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'REPARSE_POINT_IN_PROGRAM_PAYLOAD'}
  $relative=$f.FullName.Substring($prefix.Length).ToLowerInvariant()
  $output[$relative]=[int64]$f.Length
 }
 return $output
}
try{
 if(!(Test-Path -LiteralPath $installed)){throw 'INSTALLED_PROGRAM_MISSING'}
 if(Test-Path -LiteralPath $snapshot){throw 'RECOVERY_SNAPSHOT_ALREADY_EXISTS_REFUSE_OVERWRITE'}
 if([IO.Path]::GetFullPath($snapshot).StartsWith([IO.Path]::GetFullPath($installed).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'RECOVERY_DESTINATION_INSIDE_INSTALLED_PROGRAM'}
 $before=(Get-Content -LiteralPath (Join-Path $installed 'release-target.json') -Raw|ConvertFrom-Json)
 if($before.sourceCommit -ne $expectedCommit){throw 'CURRENT_INSTALLED_COMMIT_CHANGED'}
 $baseline=(Get-FileHash -LiteralPath (Join-Path $installed 'release-target.json') -Algorithm SHA256).Hash
 $result.originalManifestChecked=Assert-Manifest $installed
 $old=RelTable $installed
 if($old.Count -gt 30000 -or $old.Count -lt 150){throw 'INSTALLED_PROGRAM_FILE_COUNT_UNEXPECTED'}
 $total=([int64[]]@($old.Values)|Measure-Object -Sum).Sum
 if($total -gt 2GB){throw 'RECOVERY_COPY_EXCEEDS_2GB_CAP'}
 $drive=(Get-PSDrive C).Free
 if($drive -lt ($total+3GB)){throw 'INSUFFICIENT_FREE_SPACE_FOR_RECOVERY_COPY'}
 New-Item -ItemType Directory -Path $recoveryParent -Force|Out-Null
 # This copies ONLY the installed program to a user-local private cold archive.
 # It never launches/stops the installed Control Panel/Gateway or touches registry.
 & robocopy.exe $installed $snapshot /E /R:0 /W:0 /COPY:DAT /DCOPY:DAT /XJ /NP /NFL /NDL /NJH /NJS
 $exit=$LASTEXITCODE
 if($exit -ge 8){throw ('RECOVERY_ROBOCOPY_FAILED_'+$exit)}
 $new=RelTable $snapshot
 if($new.Count -ne $old.Count){throw ('RECOVERY_FILE_COUNT_MISMATCH_'+$new.Count+'_'+$old.Count)}
 foreach($key in $old.Keys){
   if(!$new.ContainsKey($key) -or $new[$key] -ne $old[$key]){throw ('RECOVERY_FILE_METADATA_MISMATCH_'+$key)}
 }
 $result.fileNamesAndSizesEqual=$true
 $result.snapshotManifestChecked=Assert-Manifest $snapshot
 $snapTarget=Get-Content -LiteralPath (Join-Path $snapshot 'release-target.json') -Raw|ConvertFrom-Json
 if($snapTarget.sourceCommit -ne $expectedCommit){throw 'RECOVERY_SOURCE_COMMIT_MISMATCH'}
 $result.rollbackIsByteIdenticalAtProtectedFiles=$true
 $result.originalFilesUnchanged=((Get-FileHash -LiteralPath (Join-Path $installed 'release-target.json') -Algorithm SHA256).Hash -eq $baseline)
 $result.snapshotFileCount=$new.Count
 $result.snapshotBytes=$total
 if(!$result.originalFilesUnchanged){throw 'INSTALL_PROGRAM_CONTRACT_CHANGED_DURING_READ'}
 $result.status='VERIFIED_EXACT_PROGRAM_RECOVERY_SNAPSHOT_READY'
}catch{
 $result.status='EXACT_PROGRAM_RECOVERY_SNAPSHOT_FAILED'
 $result.error=$_.Exception.Message
}finally{
 $evidence=Join-Path $recoveryParent 'installed-343ba99-20261024-evidence.json'
 if(Test-Path $recoveryParent){
  $result|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $evidence
 }
 Write-Output ('EXACT_RECOVERY='+($result|ConvertTo-Json -Depth 5 -Compress))
}
if($result.status -ne 'VERIFIED_EXACT_PROGRAM_RECOVERY_SNAPSHOT_READY'){exit 2}
