@echo off
setlocal
set "DOTNET_LOCAL=%~dp0..\..\runtime\dotnet-sdk\dotnet.exe"
if exist "%DOTNET_LOCAL%" (
  set "DOTNET=%DOTNET_LOCAL%"
) else (
  where dotnet.exe >nul 2>nul || (
    echo ERROR: .NET 10 SDK is required.
    exit /b 2
  )
  set "DOTNET=dotnet.exe"
)
set DOTNET_CLI_TELEMETRY_OPTOUT=1
set "OUT=%~dp0..\..\runtime\publish\control-panel-win-x64"
if exist "%OUT%" rmdir /s /q "%OUT%"
"%DOTNET%" publish "%~dp0DeskMCP.ControlPanel.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -o "%OUT%" --nologo
exit /b %errorlevel%
