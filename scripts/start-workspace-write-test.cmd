@echo off
cd /d "%~dp0.."
set "DESKTOP_MCP_PROFILE=workspace-write"
set "DESKTOP_MCP_ALLOWED_ROOTS=%CD%\test-area"
node dist\src\index.js
