# Offline compilation check of candidate WPF Control Panel C# sources.
# Uses installed Roslyn/.NET runtime only as read-only references.
# DOES NOT launch the GUI, generate BAML/XAML, package or install anything.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installed=Join-Path $env:LOCALAPPDATA 'Programs\DesktopMCP'
$csc='C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe'
$outDir=Join-Path $root 'runtime\csharp-check'
if(!(Test-Path -LiteralPath $csc -PathType Leaf)){throw 'MSVC Roslyn compiler is missing'}
if(!(Test-Path -LiteralPath $installed -PathType Container)){throw 'Installed .NET runtime reference directory missing'}
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$refs=Get-ChildItem -LiteralPath $installed -Filter '*.dll' -File |
  Where-Object {($_.Name -match '^(System\.|Microsoft\.|Presentation|WindowsBase|UIAutomation|ReachFramework|DirectWrite|netstandard|DeskMCP\.)') -and
    $_.Name -notmatch '(?i)Native|SNI\.dll'} |
  ForEach-Object { '/reference:"'+$_.FullName+'"' }
$sources=Get-ChildItem -LiteralPath (Join-Path $root 'control-panel\wpf') -Filter '*.cs' -File |
  ForEach-Object {'"'+$_.FullName+'"'}
if($sources.Count -lt 8){throw 'Unexpectedly small WPF source set'}
$rsp=Join-Path $outDir 'panel-candidate.rsp'
$dll=Join-Path $outDir 'DeskMCP.ControlPanel.candidate.dll'
$args=@('/nologo','/target:winexe','/langversion:latest','/nullable:disable','/nostdlib+',('/out:"'+$dll+'"'))+$refs+$sources
[IO.File]::WriteAllLines($rsp,[string[]]$args)
# /noconfig must be a direct CLI argument; a response-file occurrence is ignored.
# Prevents Roslyn for MSBuild from implicitly adding legacy .NET Framework refs.
& $csc /noconfig ('@'+$rsp)
if($LASTEXITCODE -ne 0){throw 'Candidate WPF C# compilation failed'}
if(!(Test-Path -LiteralPath $dll -PathType Leaf)){throw 'Candidate WPF DLL missing'}
Write-Output ('WPF_CSHARP_SOURCE_COMPILE_PASS sources='+$sources.Count+' referenceAssemblies='+$refs.Count)
Write-Output 'WPF_XAML_RESOURCE_BUILD_NOT_PERFORMED; GUI_NOT_STARTED; PRODUCTION_NOT_MODIFIED'
