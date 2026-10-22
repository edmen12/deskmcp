$ErrorActionPreference = "Stop"
$lease = $args[0]
if ([string]::IsNullOrWhiteSpace($lease)) { throw "Missing D2 test lease." }
$fixture = Join-Path (Get-Location) 'test-area\ego-d2-real-winforms-acceptance.ps1'
$out = Join-Path (Get-Location) 'runtime\ego-d2-combined-fixture.stdout.txt'
$err = Join-Path (Get-Location) 'runtime\ego-d2-combined-fixture.stderr.txt'
$child = $null
try {
  $child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Sta','-ExecutionPolicy','Bypass','-File',('"'+$fixture+'"')) -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
  Start-Sleep -Seconds 3
  Write-Output ('OWNED_TEST_PROCESS_ID='+$child.Id)
  & node.exe 'test-area\ego-d2-candidate-live.mjs' $lease
  if ($LASTEXITCODE -ne 0) { throw 'D2 candidate WinApp test returned a failure.' }
} finally {
  if ($child) {
    try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
}
