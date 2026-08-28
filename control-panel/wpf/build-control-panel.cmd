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
"%DOTNET%" build "%~dp0DeskMCP.ControlPanel.csproj" -c Release --nologo
exit /b %errorlevel%
