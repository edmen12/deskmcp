@echo off
setlocal EnableExtensions
set "MSVC=%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%MSVC%" (echo Missing installed MSVC 2022 BuildTools & exit /b 2)
call "%MSVC%" >nul
if errorlevel 1 exit /b 3
if not exist runtime mkdir runtime
cl /nologo /std:c++17 /EHsc /utf-8 /W3 /Fo"runtime\ego-d2-switch-monitor.obj" /Fe"runtime\ego-d2-switch-monitor.exe" "test-area\ego-d2-switch-monitor.cpp" kernel32.lib
if errorlevel 1 exit /b 4
echo Read-only candidate Desktop switch monitor compiled. No GUI or installation.
exit /b 0
