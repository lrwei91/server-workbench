@echo off
setlocal EnableExtensions
title Server Workbench - Remote Server Manager

rem Windows launcher: runtime is resolved from PATH; credentials stay in config.js.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install Node 18+ and run npm install.
  pause
  exit /b 1
)
set "NODE_EXE=node"

set "PY_EXE="
where python >nul 2>nul
if not errorlevel 1 set "PY_EXE=python"
if not defined PY_EXE (
  where py >nul 2>nul
  if not errorlevel 1 set "PY_EXE=py -3"
)

if not exist "config.js" (
  echo [WARN] config.js not found. Copy config.example.js to config.js and fill SSH values before connecting.
)

if defined PY_EXE (
  echo Starting CDR backend on http://127.0.0.1:8000 ...
  start "CDR backend" /min cmd /c "cd /d ""%~dp0cdr"" ^&^& set CDR_PORT=8000 ^&^& %PY_EXE% server.py"
) else (
  echo [WARN] Python 3 was not found on PATH. CDR tool will be unavailable.
)

echo Starting bridge service on http://127.0.0.1:17755 ...
start "" http://127.0.0.1:17755
%NODE_EXE% server\server.js
if errorlevel 1 (
  echo.
  echo [ERROR] Service exited unexpectedly. Run npm install and check config.js.
  pause
)
endlocal
