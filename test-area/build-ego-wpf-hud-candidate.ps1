# Candidate-only WPF Control Panel compiler + isolated test-mode host.
# Does not start a second Control Panel or its real ControlCoordinator.
# Uses read-only installed self-contained .NET runtime files, without SDK download.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installed=Join-Path $env:LOCALAPPDATA 'Programs\DesktopMCP'
$csc='C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe'
$work=Join-Path $root 'runtime\csharp-check'
$app=Join-Path $work 'wpf-candidate'
if(!(Test-Path -LiteralPath $installed -PathType Container) -or
   !(Test-Path -LiteralPath $csc -PathType Leaf)) { throw 'Installed WPF runtime or Roslyn compiler missing' }
New-Item -ItemType Directory -Path $app -Force | Out-Null
$refs=Get-ChildItem -LiteralPath $installed -Filter '*.dll' -File |
    Where-Object {($_.Name -match '^(System\.|Microsoft\.|Presentation|WindowsBase|UIAutomation|ReachFramework|DirectWrite|netstandard|DeskMCP\.)') -and
      $_.Name -notmatch '(?i)Native|SNI\.dll'} | ForEach-Object { '/reference:"'+$_.FullName+'"' }
$sources=Get-ChildItem -LiteralPath (Join-Path $root 'control-panel\wpf') -Filter '*.cs' -File |
    ForEach-Object {'"'+$_.FullName+'"'}
if($sources.Count -ne 10) { throw 'Unexpected WPF source file count; update the manifest after review' }
$panel=Join-Path $app 'DeskMCP.ControlPanel.Candidate.dll'
$panelRsp=Join-Path $work 'wpf-full-panel.rsp'
[IO.File]::WriteAllLines($panelRsp,[string[]](
    @('/nologo','/target:winexe','/langversion:latest','/nullable:disable','/nostdlib+',('/out:"'+$panel+'"'))+$refs+$sources))
& $csc /noconfig ('@'+$panelRsp)
if($LASTEXITCODE -ne 0) { throw 'WPF panel source compilation failed' }
$bootstrap=Join-Path $app 'DeskMCP.AgentDesktopHost.dll'
$bootstrapRsp=Join-Path $work 'wpf-probe-bootstrap.rsp'
$probeSources=@('test-area\ego-wpf-candidate-bootstrap.cs','test-area\ego-wpf-candidate-hud-probe.cs') |
    ForEach-Object {'"'+(Join-Path $root $_)+'"'}
[IO.File]::WriteAllLines($bootstrapRsp,[string[]](
    @('/nologo','/target:exe','/main:CandidateWpfTestBootstrap','/langversion:latest','/nullable:enable',
      '/nostdlib+',('/out:"'+$bootstrap+'"'))+$refs+$probeSources))
& $csc /noconfig ('@'+$bootstrapRsp)
if($LASTEXITCODE -ne 0) { throw 'Candidate HUD probe bootstrap compilation failed' }
Get-ChildItem -LiteralPath $installed -File |
    Where-Object { ($_.Extension -eq '.dll' -and $_.Name -ne 'DeskMCP.AgentDesktopHost.dll') -or $_.Name -match '^DeskMCP\.AgentDesktopHost\.(exe|runtimeconfig\.json|deps\.json)$' } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $app $_.Name) -Force }
Copy-Item -LiteralPath (Join-Path $root 'control-panel\wpf\Panel.xaml') -Destination $app -Force
New-Item -ItemType Directory -Path (Join-Path $app 'brand') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'assets\brand\deskmcp-mark-64.png') -Destination (Join-Path $app 'brand') -Force
$exe=Join-Path $app 'DeskMCP.AgentDesktopHost.exe'
$env:DESKTOP_MCP_DATA_ROOT=Join-Path $work 'wpf-test-state'
$binding=& $exe --agent-desktop-binding-self-test
if($LASTEXITCODE -ne 0 -or "$binding" -notmatch 'AGENT_DESKTOP_BINDING_SELF_TEST=PASS') {
    throw 'Candidate WPF binding self-test failed'
}
$preview=Join-Path $work 'wpf-candidate-offscreen.png'
& $exe --capture $preview
if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $preview -PathType Leaf) -or
  (Get-Item -LiteralPath $preview).Length -lt 1000) {
    throw 'Candidate WPF XAML offscreen render failed'
}
& $exe --hud-placement-probe '11111111-1111-4111-8111-111111111111' '22222222-2222-4222-8222-222222222222' 2500
if($LASTEXITCODE -ne 3){throw 'Missing lease did not refuse HUD creation'}
Write-Output 'WPF_CANDIDATE_FULL_SOURCE_COMPILE=PASS'
Write-Output 'WPF_CANDIDATE_RUNTIME_BINDING_SELFTEST=PASS'
Write-Output 'WPF_CANDIDATE_PANEL_XAML_OFFSCREEN_RENDER=PASS'
Write-Output 'WPF_CANDIDATE_HUD_INVALID_LEASE_REJECTED=PASS'
Write-Output ('WPF_CANDIDATE_TEST_APP='+$exe)
Write-Output 'NO_LIVE_CONTROL_PANEL_STARTED_NO_PRODUCTION_FILES_WRITTEN'
exit 0
