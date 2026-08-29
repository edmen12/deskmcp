$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $root 'installer\DeskMCPInstaller.cs'
$icon = Join-Path $root 'assets\brand\DeskMCP.ico'
$out = Join-Path $root 'runtime\DeskMCP-Setup-UI.exe'
$capture = Join-Path $root 'runtime\validation-installer.png'
$csc = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw 'Windows .NET Framework C# compiler was not found.' }
New-Item -ItemType Directory -Force -Path (Split-Path $out -Parent) | Out-Null
& $csc /nologo /target:winexe /platform:x64 ('/win32icon:' + $icon) ('/out:' + $out) `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
  /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll $source
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Remove-Item -LiteralPath $capture -Force -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $out -ArgumentList @('--capture-ui', ('"' + $capture + '"')) -PassThru -Wait
if ($p.ExitCode -ne 0) { exit $p.ExitCode }
if (-not (Test-Path -LiteralPath $capture)) { throw 'Installer UI capture was not created.' }
Write-Output ('INSTALLER_UI_OK bytes=' + (Get-Item -LiteralPath $capture).Length)
