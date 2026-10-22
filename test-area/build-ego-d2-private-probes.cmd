@echo off
setlocal EnableExtensions
set "VARS=%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VARS%" (echo Missing MSVC Build Tools 1>&2 & exit /b 2)
call "%VARS%" >nul
if errorlevel 1 exit /b 3
if not exist runtime mkdir runtime
cl /nologo /std:c++17 /EHsc /utf-8 /W3 /Fo"runtime\ego-d2-object-host-shim.obj" /Fe"runtime\ego-d2-object-host-shim.exe" "test-area\ego-d2-object-host-shim.cpp" user32.lib kernel32.lib
if errorlevel 1 exit /b 4
cl /nologo /std:c++17 /EHsc /utf-8 /W3 /Fo"runtime\ego-d2-native-control-probe.obj" /Fe"runtime\ego-d2-native-control-probe.exe" "test-area\ego-d2-native-control-probe.cpp" user32.lib kernel32.lib
if errorlevel 1 exit /b 5
echo Candidate-only desktop object test helpers compiled. No install or desktop switch.
exit /b 0
