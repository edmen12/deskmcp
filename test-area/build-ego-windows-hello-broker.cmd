@echo off
setlocal EnableExtensions
set "VARS=%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VARS%" (
  echo Missing installed Visual Studio C++ Build Tools 1>&2
  exit /b 2
)
call "%VARS%" >nul
if errorlevel 1 exit /b 3
set "WINRT=%WindowsSdkDir%Include\%WindowsSDKVersion%cppwinrt"
if not exist "%WINRT%\winrt\Windows.Security.Credentials.h" (
  echo Missing C++/WinRT Windows SDK headers 1>&2
  exit /b 4
)
if not exist runtime\hello-obj mkdir runtime\hello-obj
cl /nologo /std:c++20 /EHsc /utf-8 /W3 /I"%WINRT%" /Fo"runtime\hello-obj\\" /Fe"runtime\ego-windows-hello-probe.exe" "test-area\ego-windows-hello-broker.cpp" windowsapp.lib user32.lib ole32.lib uuid.lib wintrust.lib crypt32.lib
if errorlevel 1 exit /b 5
echo Native Windows Hello broker compiled. No PIN prompt was displayed.
exit /b 0
