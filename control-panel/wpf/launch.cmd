@echo off
setlocal
set "PROJECT_ROOT=%~dp0..\.."
pushd "%PROJECT_ROOT%"
where node.exe >nul 2>nul || (
  echo ERROR: Node.js is required for developer launch.
  popd
  exit /b 2
)
call npm.cmd run build
if errorlevel 1 (
  popd
  exit /b %errorlevel%
)
popd
call "%~dp0build-control-panel.cmd"
if errorlevel 1 exit /b %errorlevel%
set "DESKTOP_MCP_GATEWAY_ROOT=%PROJECT_ROOT%"
set "APP=%~dp0bin\Release\net10.0-windows\DeskMCP.exe"
if not exist "%APP%" (
  echo ERROR: Control Panel build output not found: "%APP%"
  exit /b 2
)
start "" "%APP%"
exit /b 0