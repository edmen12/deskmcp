$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$env:DOTNET_ROOT='C:\Users\User\Desktop\DeskMCP\runtime\dotnet-sdk'
$env:DESKTOP_MCP_VDA_PATH='C:\Users\User\Desktop\DeskMCP\runtime\agent-desktop-runtime\win-x64\virtual-desktop-accessor\VirtualDesktopAccessor.dll'
$native=Join-Path $root 'agent-desktop-host\bin\Release\net10.0-windows\DeskMCP.AgentDesktopHost.exe'
$probe=Join-Path $root 'test-area\desktop2-gui-probe\bin\Release\net10.0-windows\DeskMCP.Desktop2Probe.exe'
$ready=Join-Path $root 'test-area\d2ready.json'
$release=Join-Path $root 'test-area\d2release.flag'
$eventLog=Join-Path $root 'test-area\d2events.log'
Remove-Item -LiteralPath $ready,$release,$eventLog -Force -ErrorAction SilentlyContinue
$proc=$null
try {
  $desktop = & $native desktop-info --desktop-number 2 | ConvertFrom-Json
  if($LASTEXITCODE -ne 0 -or $desktop.desktopNumber -ne 2 -or $desktop.currentDesktopNumber -ne 1){throw 'NOT_ON_DESKTOP1_OR_NO_DESKTOP2'}
  Write-Output ('TARGET_DESKTOP='+$desktop.desktopId)
  $proc=Start-Process -FilePath $probe -ArgumentList @('"'+$ready+'"','"'+$release+'"','"'+$eventLog+'"','90000') -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  while(!(Test-Path $ready) -and [DateTime]::UtcNow -lt $deadline){
    Start-Sleep -Milliseconds 200
    $proc.Refresh()
    if($proc.HasExited){throw 'CLOAKED_PROBE_EXITED_EARLY'}
  }
  if(!(Test-Path $ready)){throw 'CLOAKED_PROBE_START_TIMEOUT'}
  $state=Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
  Write-Output ('CLOAK_READY='+($state|ConvertTo-Json -Compress))
  if($state.dwmCloaked -ne 1 -or !$state.showInTaskbar -or $state.initialForeground -ne $state.afterForeground -or $state.hwnd -le 0){throw 'WINDOW_CLOAK_OR_NOACTIVATE_FAILED'}
  $hwnd=[string]$state.hwnd
  $pidValue=[string]$state.pid
  $before=& $native window-info --hwnd $hwnd | ConvertFrom-Json
  Write-Output ('WINDOW_BEFORE='+($before|ConvertTo-Json -Compress))
  if($before.desktopNumber -ne 1){throw 'PRE_MOVE_WINDOW_NOT_DESKTOP1'}
  $moved=& $native move-window --hwnd $hwnd --desktop-id $desktop.desktopId | ConvertFrom-Json
  Write-Output ('WINDOW_MOVED='+($moved|ConvertTo-Json -Compress))
  $after=& $native window-info --hwnd $hwnd | ConvertFrom-Json
  if($after.desktopNumber -ne 2 -or $after.onCurrentDesktop -ne $false -or $after.desktopId -ne $desktop.desktopId){throw 'ISOLATION_NOT_PROVEN'}
  Write-Output 'WINDOW_IS_REAL_DESKTOP2_NOT_VISIBLE_DESKTOP1_PASS'
  $mouse=& $native background-input --hwnd $hwnd --pid $pidValue --desktop-id $desktop.desktopId --action click --x 250 --y 145
  $mouseExit=$LASTEXITCODE
  Write-Output ('NATIVE_CLICK='+$mouse+' EXIT='+$mouseExit)
  if($mouseExit -ne 0){throw 'NATIVE_CLICK_DENIED_OR_FAILED'}
  $type=& $native background-input --hwnd $hwnd --pid $pidValue --desktop-id $desktop.desktopId --action text --text 'ABC_D2'
  $typeExit=$LASTEXITCODE
  Write-Output ('NATIVE_TEXT='+$type+' EXIT='+$typeExit)
  if($typeExit -ne 0){throw 'NATIVE_TEXT_DENIED_OR_FAILED'}
  $buttonResult=& $native background-input --hwnd ([string]$state.buttonHwnd) --pid $pidValue --desktop-id $desktop.desktopId --action click --x 45 --y 20
  $buttonExit=$LASTEXITCODE
  Write-Output ('CHILD_BUTTON_CLICK='+$buttonResult+' EXIT='+$buttonExit)
  if($buttonExit -ne 0){throw 'CHILD_BUTTON_CLICK_FAILED'}
  $bmResult=& $native background-input --hwnd ([string]$state.buttonHwnd) --pid $pidValue --desktop-id $desktop.desktopId --action invoke-button
  $bmExit=$LASTEXITCODE
  Write-Output ('BM_CLICK_BUTTON='+$bmResult+' EXIT='+$bmExit)
  if($bmExit -ne 0){throw 'BM_CLICK_BUTTON_DENIED_OR_FAILED'}
  $boxResult=& $native background-input --hwnd ([string]$state.textboxHwnd) --pid $pidValue --desktop-id $desktop.desktopId --action text --text 'TEXT_IN_BOX'
  $boxExit=$LASTEXITCODE
  Write-Output ('CHILD_TEXTBOX_TYPE='+$boxResult+' EXIT='+$boxExit)
  if($boxExit -ne 0){throw 'CHILD_TEXTBOX_TYPE_FAILED'}
  $right=& $native background-input --hwnd $hwnd --pid $pidValue --desktop-id $desktop.desktopId --action right-click --x 315 --y 190
  Write-Output ('RIGHT_CLICK_EXIT='+$LASTEXITCODE)
  $drag=& $native background-input --hwnd $hwnd --pid $pidValue --desktop-id $desktop.desktopId --action drag --x 305 --y 175 --to-x 350 --to-y 200 --steps 5
  Write-Output ('DRAG_EXIT='+$LASTEXITCODE)
  $wheel=& $native background-input --hwnd $hwnd --pid $pidValue --desktop-id $desktop.desktopId --action wheel --x 315 --y 170 --delta -120
  Write-Output ('WHEEL_EXIT='+$LASTEXITCODE)
  $double=& $native background-input --hwnd $hwnd --pid $pidValue --desktop-id $desktop.desktopId --action double-click --x 315 --y 180
  Write-Output ('DOUBLE_CLICK_EXIT='+$LASTEXITCODE)
  Start-Sleep -Milliseconds 300
  if(Test-Path $eventLog) {
    $events=@(Get-Content $eventLog)
    Write-Output ('EVENT_LOG='+($events -join '|'))
    $mouseEvents= @($events|Where-Object {$_ -match 'APP_MOUSECLICK|APP_MOUSEDOWN'})
    $keyEvents= @($events|Where-Object {$_ -match 'APP_KEYPRESS|WM_102'})
    Write-Output ('APP_MOUSE_EVENTS='+$mouseEvents.Count)
    Write-Output ('APP_KEY_EVENTS='+$keyEvents.Count)
    if($mouseEvents.Count -lt 1){throw 'APP_DID_NOT_HANDLE_CLICK'}
    if($keyEvents.Count -lt 1){throw 'APP_DID_NOT_HANDLE_CHAR'}
    $appButtonClick=@($events|Where-Object {$_ -match 'APP_BUTTON_CLICK'})
    $appTextboxChanged=@($events|Where-Object {$_ -match 'APP_TEXTBOX_CHANGED TEXT_IN_BOX'})
    Write-Output ('APP_BUTTON_CLICK_COUNT='+$appButtonClick.Count)
    Write-Output ('APP_TEXTBOX_CHANGED_CONFIRMED='+($appTextboxChanged.Count -ge 1))
    if($appButtonClick.Count -ge 1){Write-Output 'REAL_WINFORMS_BUTTON_CLICK_PASS'}else{Write-Output 'REAL_WINFORMS_BUTTON_CLICK_NOT_OBSERVED'}
    if($appTextboxChanged.Count -ge 1){Write-Output 'REAL_WINFORMS_TEXTBOX_INPUT_PASS'}else{Write-Output 'REAL_WINFORMS_TEXTBOX_INPUT_NOT_OBSERVED'}
    Write-Output ('APP_RIGHT_DOWN_COUNT='+@($events | Where-Object {$_ -match 'APP_MOUSEDOWN Right'}).Count)
    Write-Output ('APP_DRAG_MOVE_COUNT='+@($events | Where-Object {$_ -match 'APP_DRAG_MOVE'}).Count)
    Write-Output ('APP_WHEEL_COUNT='+@($events | Where-Object {$_ -match 'APP_WHEEL'}).Count)
    Write-Output ('APP_DOUBLE_COUNT='+@($events | Where-Object {$_ -match 'APP_DOUBLECLICK'}).Count)
    Write-Output 'GUEST_DESKTOP2_INPUT_READBACK_PASS'
  }else{throw 'NO_APP_EVENT_LOG'}
  # Uncloak only AFTER verified Desktop2-only placement; never on Desktop1.
  $justBeforeUncloak=& $native window-info --hwnd $hwnd | ConvertFrom-Json
  $stillUserDesktop=& $native current-desktop|ConvertFrom-Json
  if($justBeforeUncloak.desktopId -ne $desktop.desktopId -or $justBeforeUncloak.onCurrentDesktop -ne $false -or $stillUserDesktop.desktopNumber -ne 1){throw 'UNCLOAK_DESKTOP1_RISK_BLOCKED'}
  Set-Content -LiteralPath $release -Value 'UN-CLOAK-AFTER-VERIFIED-DESKTOP2' -Encoding ASCII
  Start-Sleep -Milliseconds 400
  if(!(Select-String -Path $eventLog -Pattern 'UNCLOAK_SUCCESS' -Quiet)){throw 'UNCLOAK_DID_NOT_HAPPEN'}
  $uncloakedInfo=& $native window-info --hwnd $hwnd | ConvertFrom-Json
  if($uncloakedInfo.desktopId -ne $desktop.desktopId -or $uncloakedInfo.onCurrentDesktop -ne $false){throw 'WINDOW_EXPOSED_TO_USER_DESKTOP_AFTER_UNCLOAK'}
  Write-Output 'DESKTOP2_WINDOW_UNCLOAKED_WITHOUT_DESKTOP1_EXPOSURE_PASS'
  $winapp=Join-Path $env:LOCALAPPDATA 'Programs\DesktopMCP\gateway\winapp\winapp.exe'
  $png=Join-Path $root 'test-area\d2preview.png'
  Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue
  $capture=& $winapp ui screenshot -w $hwnd --output $png --json
  $captureExit=$LASTEXITCODE
  Write-Output ('BACKGROUNDSCREENSHOT_EXIT='+$captureExit+' META='+($capture -join ' '))
  if($captureExit -eq 0 -and (Test-Path $png)){
    $bytes=[System.IO.File]::ReadAllBytes($png)
    if($bytes.Length -lt 100 -or $bytes[0] -ne 137 -or $bytes[1] -ne 80 -or $bytes[2] -ne 78 -or $bytes[3] -ne 71){throw 'SCREENSHOT_INVALID_PNG'}
    Write-Output ('DESKTOP2_WINDOW_SCREENSHOT_PNG_PASS_BYTES='+$bytes.Length)
  }else{
    Write-Output 'DESKTOP2_WINDOW_SCREENSHOT_NOT_PROVEN'
  }
  $current=& $native current-desktop|ConvertFrom-Json
  if($current.desktopNumber -ne 1){throw 'HOST_DESKTOP_SWITCHED'}
  Write-Output 'DESKTOP1_STILL_CURRENT_PASS'
  $s = Join-Path $env:LOCALAPPDATA 'DesktopMCP\agent-desktop\foreground-invariant.log'
  if(Test-Path $s){Write-Output ('SWITCH_LOG_COUNT='+@(Get-Content $s).Count)}
} catch {
  Write-Output ('PROBE_FAILED='+$_.Exception.Message)
  exit 2
} finally {
  if($null -ne $proc) {
    try {$proc.Refresh();if(!$proc.HasExited){Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue}}catch{}
  }
  Write-Output 'PROBE_PROCESS_CLEANED'
}
