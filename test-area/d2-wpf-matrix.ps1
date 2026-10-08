$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$env:DOTNET_ROOT='C:\Users\User\Desktop\DeskMCP\runtime\dotnet-sdk'
$env:DESKTOP_MCP_VDA_PATH='C:\Users\User\Desktop\DeskMCP\runtime\agent-desktop-runtime\win-x64\virtual-desktop-accessor\VirtualDesktopAccessor.dll'
$native=Join-Path $root 'agent-desktop-host\bin\Release\net10.0-windows\DeskMCP.AgentDesktopHost.exe'
$exe=Join-Path $root 'test-area\desktop2-wpf-probe\bin\Release\net10.0-windows\DeskMCP.Desktop2WpfProbe.exe'
$winapp='C:\Users\User\AppData\Local\Programs\DesktopMCP\gateway\winapp\winapp.exe'
$ready=Join-Path $root 'test-area\wpf.ready.json'
$release=Join-Path $root 'test-area\wpf.uncloak.flag'
$events=Join-Path $root 'test-area\wpf.events.log'
$owned=$null
$foregroundLog=Join-Path $env:LOCALAPPDATA 'DesktopMCP\agent-desktop\foreground-invariant.log'
$baseline=@(Get-Content $foregroundLog -ErrorAction SilentlyContinue).Count
$observerReady=Join-Path $root 'test-area\desktop2-switch-observer\observer.ready.json'
$observerTripwire=Join-Path $root 'test-area\desktop2-switch-observer\observer.tripwire.json'
function Assert-ForegroundIsolation {
 if(Test-Path -LiteralPath $observerTripwire){throw 'DESKTOP_SWITCH_TRIPWIRE_LATCHED_ABORT_ALL_GUI_ACTIONS'}
 if(!(Test-Path -LiteralPath $observerReady)){throw 'PASSIVE_DESKTOP_SWITCH_OBSERVER_REQUIRED_BEFORE_ANY_GUI_ACTION'}
 $observer=Get-Content -LiteralPath $observerReady -Raw | ConvertFrom-Json
 if($observer.expectedDesktopIndex -ne 0 -or !$observer.hasVirtualDesktopNotifications -or !$observer.hasForegroundHook){
   throw 'PASSIVE_DESKTOP_OBSERVER_NOT_VERIFIED'
 }
 $running=Get-Process -Id $observer.processId -ErrorAction SilentlyContinue
 if(!$running -or $running.ProcessName -ne 'DeskMCP.Desktop2SwitchObserver'){
   throw 'PASSIVE_DESKTOP_OBSERVER_NOT_RUNNING'
 }
 try{$started=$running.StartTime.ToUniversalTime()}catch{throw 'PASSIVE_DESKTOP_OBSERVER_START_NOT_VERIFIABLE'}
 if([Math]::Abs(($started - ([datetime]$observer.firstStartUtc)).TotalSeconds) -gt 10){
   throw 'PASSIVE_DESKTOP_OBSERVER_PID_REUSED_OR_STALE'
 }
 $current= & $native current-desktop | ConvertFrom-Json
 if($current.desktopNumber -ne 1){throw 'OWNER_DESKTOP_CHANGED_ABORT_AGENT_ACTIONS'}
 # Check again after the current-desktop read. A rapid switch/back may have
 # been caught by the event listener while this check was executing.
 if(Test-Path -LiteralPath $observerTripwire){throw 'DESKTOP_SWITCH_TRIPWIRE_LATCHED_ABORT_ALL_GUI_ACTIONS'}
}
# FAIL CLOSED *before* any test GUI is created. No passive witness -> no test.
try{Assert-ForegroundIsolation}catch{Write-Output ('GUI_PROBE_SAFETY_BLOCKED='+$_);exit 3}
# Only now is test-owned artifact cleanup allowed. A blocked run preserves evidence.
Remove-Item $ready,$release,$events -Force -ErrorAction SilentlyContinue
$actionTimeline=Join-Path $root 'test-area\desktop2-switch-observer\gui-action-timeline.jsonl'
$runId=[guid]::NewGuid().ToString('D')
function Trace-Action([string]$phase,[string]$transport,[string]$kind) {
 $entry=@{utc=[datetime]::UtcNow.ToString('O');runId=$runId;phase=$phase;transport=$transport;action=$kind}
 ($entry | ConvertTo-Json -Compress) | Add-Content -LiteralPath $actionTimeline -Encoding UTF8
}
function N([string[]]$params) {
 Assert-ForegroundIsolation
 Trace-Action 'START' 'native' $params[0]
 try {
  $val= & $native @params
  $code=$LASTEXITCODE
  Assert-ForegroundIsolation
  if($code -ne 0){throw ('NATIVE_FAIL '+$params[0])}
  Trace-Action 'SUCCESS' 'native' $params[0]
  return $val | ConvertFrom-Json
 }catch{
  Trace-Action 'ABORTED_OR_FAILED' 'native' $params[0]
  throw
 }
}
function W([string[]]$params) {
 Assert-ForegroundIsolation
 Trace-Action 'START' 'winapp-uia' $params[0]
 try {
  $result=& $winapp ui @params
  $exit=$LASTEXITCODE
  # Allow post-message switch hooks to be dispatched before authorizing next call.
  Start-Sleep -Milliseconds 150
  Assert-ForegroundIsolation
  if($exit -ne 0){throw ('WINAPP_FAILED '+$params[0])}
  Trace-Action 'SUCCESS' 'winapp-uia' $params[0]
  $flat=[string]::Join([Environment]::NewLine,$result)
  Write-Host ('WINAPP '+($params[0..1] -join ' ')+' EXIT='+$exit+' RESULT='+$flat.Substring(0,[Math]::Min(900,$flat.Length)))
  return $flat
 }catch{
  Trace-Action 'ABORTED_OR_FAILED' 'winapp-uia' $params[0]
  throw
 }
}
try{
 $d=N -params @('desktop-info','--desktop-number','2')
 if($d.currentDesktopNumber -ne 1){throw 'OWNER_DESKTOP_NOT_1'}
 Assert-ForegroundIsolation
 Trace-Action 'START' 'owned-wpf' 'START_PROCESS'
 $owned=Start-Process -FilePath $exe -ArgumentList @('"'+$ready+'"','"'+$release+'"','"'+$events+'"','75000') -PassThru
 Trace-Action 'LAUNCHED' 'owned-wpf' 'START_PROCESS'
 Assert-ForegroundIsolation
 $limit=[DateTime]::UtcNow.AddSeconds(16)
 while(!(Test-Path $ready) -and [DateTime]::UtcNow -lt $limit){Start-Sleep -Milliseconds 100;$owned.Refresh();if($owned.HasExited){throw 'WPF_PROCESS_EXITED'}}
 if(!(Test-Path $ready)){throw 'WPF_NO_READY'}
 $state=Get-Content $ready -Raw | ConvertFrom-Json
 Write-Output ('WPF_CLOAKED_READY='+($state|ConvertTo-Json -Compress))
 if($state.dwmCloaked -ne 1){throw 'WPF_STARTUP_CLOAK_FAILURE'}
 if($state.afterForeground -eq $state.hwnd){throw 'WPF_AGENT_WINDOW_STOLE_FOREGROUND'}
 if($state.initialForeground -ne $state.afterForeground){Write-Output 'DESKTOP1_FOREGROUND_HWND_CHANGED_EXTERNALLY_UNATTRIBUTED'}
 $nativeCurrent=N -params @('current-desktop')
 if($nativeCurrent.desktopNumber -ne 1){throw 'WPF_STARTUP_CHANGED_VIRTUAL_DESKTOP'}
 $h=[string]$state.hwnd;$pidValue=[string]$state.pid
 $before=N -params @('window-info','--hwnd',$h)
 if($before.desktopNumber -ne 1){throw 'WRONG_STARTING_DESKTOP'}
 $move=N -params @('move-window','--hwnd',$h,'--desktop-id',$d.desktopId)
 $check=N -params @('window-info','--hwnd',$h)
 Write-Output ('WPF_MOVED='+($check|ConvertTo-Json -Compress))
 if($check.desktopNumber -ne 2 -or $check.onCurrentDesktop -ne $false){throw 'WPF_ISOLATION_FAILURE'}
 Set-Content $release 'UN-CLOAK-AFTER-VERIFIED-DESKTOP2'
 Start-Sleep -Milliseconds 250
 if(!(Select-String -Path $events -Pattern 'UNCLOAK_SUCCESS' -Quiet)){throw 'WPF_UNCLOAK_FAILURE'}
 $tree=W -params @('inspect','-w',$h,'--json','-i','-d','8')
 Write-Output ('WPF_TREE_IDENTIFIERS_FOUND='+($tree.Contains('WpfEdit') -and $tree.Contains('WpfButton')))
 $set=W -params @('set-value','WpfEdit','WPF_D2_SAFE_TEXT','-w',$h,'--json')
 $get=W -params @('get-value','WpfEdit','-w',$h,'--json')
 $lines=@(Get-Content $events)
 if(-not ($lines -match 'APP_EDIT=WPF_D2_SAFE_TEXT')){throw 'WPF_TARGET_VALUE_NOT_SET'}
 Write-Output 'WPF_INPUT_FIELD_ACTUAL_READBACK_PASS'
 $inv=W -params @('invoke','WpfButton','-w',$h,'--json')
 Start-Sleep -Milliseconds 450
 if(Select-String -Path $events -Pattern 'APP_CLICK=1' -Quiet){Write-Output 'WPF_UIA_CLICK_APP_READBACK_PASS'}else{Write-Output 'WPF_UIA_INVOKE_RETURNED_BUT_CLICK_HANDLER_MISSING'}
 $scr=W -params @('invoke','WpfScrollButton','-w',$h,'--json')
 Start-Sleep -Milliseconds 450
 if(Select-String -Path $events -Pattern 'APP_SCROLLED=' -Quiet){Write-Output 'WPF_SCROLL_BUTTON_HANDLER_OBSERVED'}else{Write-Output 'WPF_SCROLL_BUTTON_HANDLER_MISSING'}
 $top=W -params @('scroll','WpfScroller','--to','top','-w',$h,'--json')
 $bottom=W -params @('scroll','WpfScroller','--to','bottom','-w',$h,'--json')
 Start-Sleep -Milliseconds 350
 if(Select-String -Path $events -Pattern 'APP_SCROLL_CHANGED=[1-9]' -Quiet){Write-Output 'WPF_SCROLL_PATTERN_NONZERO_OFFSET_PASS'}else{Write-Output 'WPF_SCROLL_PATTERN_NONZERO_OFFSET_NOT_CONFIRMED'}
 foreach($a in @(@('text','--text','MCPCHARS'),@('wheel','--x','290','--y','255','--delta','-120'),@('double-click','--x','290','--y','225'),@('drag','--x','290','--y','230','--to-x','330','--to-y','260','--steps','6'))) {
   $v=N -params (@('background-input','--hwnd',$h,'--pid',$pidValue,'--desktop-id',$d.desktopId,'--action')+$a)
   Write-Output ('RAW_'+$a[0]+'_ACCEPTED='+$v.acceptedByWindowProcedure+'_APP_VERIFIED='+$v.confirmedAppState)
 }
 $beforePopupDesk=N -params @('current-desktop')
 Write-Output ('DESKTOP_BEFORE_POPUP='+$beforePopupDesk.desktopNumber)
 if($beforePopupDesk.desktopNumber -ne 1){throw 'DESKTOP_CHANGED_BEFORE_POPUP_UNATTRIBUTED'}
 $popup=W -params @('invoke','WpfPopup','-w',$h,'--json')
 Start-Sleep -Milliseconds 500
 $afterPopupDesk=N -params @('current-desktop')
 Write-Output ('DESKTOP_AFTER_POPUP='+$afterPopupDesk.desktopNumber)
 if($afterPopupDesk.desktopNumber -ne 1){throw 'DESKTOP_CHANGED_DURING_POPUP_UNATTRIBUTED'}
 $line=(Get-Content $events | Where-Object {$_ -match 'APP_POPUP_HWND='} | Select-Object -Last 1)
 if(!$line){
   Write-Output 'WPF_UIA_POPUP_INVOKE_RETURNED_BUT_APP_HANDLER_MISSING'
 }else{
   $childHwnd=$line.Split('=')[-1]
   $childBefore=N -params @('window-info','--hwnd',$childHwnd)
   Write-Output ('WPF_POPUP_BEFORE='+($childBefore|ConvertTo-Json -Compress))
   if($childBefore.desktopId -ne $d.desktopId -and $childBefore.desktopNumber -ne 1){throw 'WPF_POPUP_UNEXPECTED_DESKTOP'}
   $childMove=N -params @('move-window','--hwnd',$childHwnd,'--desktop-id',$d.desktopId)
   $childAfter=N -params @('window-info','--hwnd',$childHwnd)
   Write-Output ('WPF_POPUP_AFTER='+($childAfter|ConvertTo-Json -Compress))
   if($childAfter.desktopId -eq $d.desktopId -and $childAfter.desktopNumber -eq 2 -and $childAfter.onCurrentDesktop -eq $false){
     Write-Output 'WPF_POPUP_DESKTOP2_PRIVATE_PASS'
   }else{
     Write-Output 'WPF_POPUP_PINNED_OR_SHARED_REMAINS_BLOCKED'
   }
 }
 $report=@(Get-Content $events)
 Write-Output ('WPF_APP_NATIVE_CHARS='+@($report | Where-Object {$_ -match 'APP_EDIT=.*MCPCHARS'}).Count)
 Write-Output ('WPF_APP_NATIVE_WHEEL='+@($report | Where-Object {$_ -match 'APP_WHEEL='}).Count)
 Write-Output ('WPF_APP_NATIVE_DOUBLE='+@($report | Where-Object {$_ -match 'APP_DOUBLE'}).Count)
 Write-Output ('WPF_APP_NATIVE_DRAG='+@($report | Where-Object {$_ -match 'APP_DRAG'}).Count)
 $end=N -params @('current-desktop')
 if($end.desktopNumber -ne 1){throw 'USER_DESKTOP_SWITCHED'}
 Write-Output ('FOREGROUND_SWITCH_LOG_DELTA='+(@(Get-Content $foregroundLog).Count-$baseline))
 Write-Output 'WPF_DESKTOP2_MATRIX_COMPLETED_WITH_EXPLICIT_UNSUPPORTED_ACTIONS'
} catch {Write-Output ('WPF_MATRIX_FAILED='+$_);exit 2}
finally {
 if($owned){try{$owned.Refresh();if(!$owned.HasExited){Stop-Process -Id $owned.Id -Force -ErrorAction SilentlyContinue}}catch{}}
 Write-Output 'OWNED_WPF_PROCESS_CLEANED'
}
