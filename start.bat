@echo off
setlocal EnableExtensions
title Server Workbench - Remote Server Manager

rem Windows launcher: runtime is resolved from PATH; credentials stay in .env.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install Node 18+ and run npm install.
  pause
  exit /b 1
)
set "NODE_EXE=node"

rem A copied or partially synchronized node_modules can contain truncated JS files.
rem Verify the actual runtime imports and rebuild dependencies from package-lock.json
rem before starting either service when the installation is missing or damaged.
%NODE_EXE% -e "require('mysql2/promise');require('pg');require('ssh2');require('iconv-lite');" >nul 2>nul
if errorlevel 1 (
  echo [WARN] Node dependencies are missing or damaged. Reinstalling from package-lock.json ...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] npm was not found on PATH. Reinstall Node.js with npm enabled.
    pause
    exit /b 1
  )
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed. Check npm network access and retry.
    pause
    exit /b 1
  )
  %NODE_EXE% -e "require('mysql2/promise');require('pg');require('ssh2');require('iconv-lite');"
  if errorlevel 1 (
    echo [ERROR] Dependencies are still invalid after npm ci.
    pause
    exit /b 1
  )
)

set "PY_EXE="
where python >nul 2>nul
if not errorlevel 1 set "PY_EXE=python"
if not defined PY_EXE (
  where py >nul 2>nul
  if not errorlevel 1 set "PY_EXE=py -3"
)

if not exist ".env" (
  echo [WARN] .env not found. Copy .env.example to .env and fill connection values before connecting.
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
  echo [ERROR] Service exited unexpectedly. Check the error above and verify .env.
  pause
)
endlocal
