# Candidate-only offline .NET 10 AgentDesktopHost build using existing MSVC Roslyn + installed self-contained runtime.
# No dotnet SDK download, no production install/restart, no write to installed DesktopMCP.
param(
  [switch]$CompileOnly
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installed=Join-Path $env:LOCALAPPDATA 'Programs\DesktopMCP'
$compiler='C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe'
$dest=Join-Path $root 'runtime\csharp-check\candidate-host'
$work=Join-Path $root 'runtime\csharp-check'
if(!(Test-Path -LiteralPath $compiler -PathType Leaf)) {throw 'Installed Roslyn compiler not available.'}
if(!(Test-Path -LiteralPath $installed -PathType Container)) {throw 'DesktopMCP read-only runtime reference missing.'}
New-Item -ItemType Directory -Force -Path $work | Out-Null
$refs=Get-ChildItem -LiteralPath $installed -Filter '*.dll' -File |
  Where-Object {($_.Name -like 'System.*' -or $_.Name -like 'Microsoft.CSharp*' -or $_.Name -eq 'netstandard.dll') -and $_.Name -notmatch 'Native\.dll|SNI\.dll'} |
  ForEach-Object { '/reference:"'+$_.FullName+'"' }
$source=@(
  (Join-Path $root 'agent-desktop-host\Program.cs'),
  (Join-Path $root 'agent-desktop-host\ObjectUi.cs')
)
$binary=Join-Path $work 'DeskMCP.AgentDesktopHost.dll'
$rsp=Join-Path $work 'candidate-host.rsp'
$options=@('/nologo','/target:exe','/langversion:latest','/nullable:enable','/nostdlib+',('/out:"'+$binary+'"'))+$refs+($source|ForEach-Object {'"'+$_+'"'})
[IO.File]::WriteAllLines($rsp,[string[]]$options)
& $compiler ('@'+$rsp)
if($LASTEXITCODE -ne 0){throw 'Roslyn failed to compile the C# native host.'}
Write-Output 'CANDIDATE_AGENT_HOST_CSHARP_COMPILE_PASS'
if($CompileOnly){return}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$files=Get-ChildItem -LiteralPath $installed -File | Where-Object {
  $_.Extension -eq '.dll' -or $_.Name -match '^DeskMCP\.AgentDesktopHost\.(exe|runtimeconfig\.json|deps\.json)$'
}
foreach($item in $files){
  Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $dest $item.Name) -Force
}
$vd=Join-Path $installed 'virtual-desktop-accessor'
if(!(Test-Path -LiteralPath $vd -PathType Container)) {throw 'Read-only virtual desktop support DLL directory missing.'}
Copy-Item -LiteralPath $vd -Destination $dest -Recurse -Force
Copy-Item -LiteralPath $binary -Destination (Join-Path $dest 'DeskMCP.AgentDesktopHost.dll') -Force
$exe=Join-Path $dest 'DeskMCP.AgentDesktopHost.exe'
$raw=& $exe current-desktop
if($LASTEXITCODE -ne 0){throw 'Candidate self-contained Host did not start.'}
$info=$raw | ConvertFrom-Json
if(!$info.desktopId -or !$info.desktopNumber){throw 'Candidate native host gave invalid Desktop state.'}
Write-Output 'CANDIDATE_AGENT_HOST_SELF_CONTAINED_START_PASS'
Write-Output ('CANDIDATE_NATIVE_HOST_PATH='+$exe)
Write-Output 'NO_DESKMCP_PRODUCTION_FILES_WERE_WRITTEN'
