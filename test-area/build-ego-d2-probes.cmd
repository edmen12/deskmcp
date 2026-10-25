@echo off
setlocal EnableExtensions
set "VARS=%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VARS%" (echo MSVC Build Tools not installed 1>&2 & exit /b 2)
call "%VARS%" >nul
if errorlevel 1 exit /b 3
if not exist runtime mkdir runtime
cl /nologo /std:c++17 /EHsc /utf-8 /W3 /Fe"runtime\ego-d2-object-window-probe.exe" "test-area\ego-d2-object-window-probe.cpp" user32.lib
if errorlevel 1 exit /b 4
cl /nologo /std:c++17 /EHsc /utf-8 /W3 /Fe"runtime\ego-d2-win32-control-probe.exe" "test-area\ego-d2-win32-control-probe.cpp" user32.lib
if errorlevel 1 exit /b 5
echo D2 native test probes compiled, no GUI or desktop switching performed.
exit /b 0
