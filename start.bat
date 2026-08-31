@echo off
title Server Workbench - Remote Server Manager
rem ============================================================
rem  Remote Server Workbench - one click launcher
rem  Starts local bridge service (Node) + cdr-tool (Python) and
rem  opens the workbench page.
rem  Node runtime + ssh2 come from the managed WorkBuddy node
rem  workspace; Python runtime comes from the managed venv
rem  (no install needed on this PC).
rem
rem  目录结构（统一收拢在 server-workbench 下）：
rem    server/    Node 桥接服务（SSH/SFTP/HDFS/代理 分模块）
rem    public/    工作台前端（index.html + style.css + app.js）
rem    cdr/       话单工具后端（Python FastAPI）
rem ============================================================

set NODE_EXE=C:\Users\lrwei\.workbuddy\binaries\node\versions\22.22.2-2\node.exe
set NODE_PATH=C:\Users\lrwei\.workbuddy\binaries\node\workspace\node_modules
set PY_EXE=C:\Users\lrwei\.workbuddy\binaries\python\envs\default\Scripts\python.exe

if not exist "%NODE_EXE%" (
  echo [ERROR] Node runtime not found: %NODE_EXE%
  pause
  exit /b 1
)
if not exist "%PY_EXE%" (
  set PY_EXE=C:\Users\lrwei\.workbuddy\binaries\python\versions\3.13.12\python.exe
)
if not exist "%PY_EXE%" (
  echo [WARN] Python runtime not found, cdr-tool 话单工具 will be unavailable.
  set PY_EXE=
)

cd /d "%~dp0"

rem ---- 1. 启动话单工具后端（cdr/，端口 8000，独立窗口后台运行）----
set CDR_DIR=%~dp0cdr
if exist "%CDR_DIR%\server.py" (
  if defined PY_EXE (
    echo Starting cdr backend on http://127.0.0.1:8000 ...
    start "话单功能后端 cdr" /min cmd /c "cd /d "%CDR_DIR%" && set CDR_PORT=8000 && "%PY_EXE%" server.py"
  )
) else (
  echo [WARN] cdr module not found, skipping.
)

rem ---- 2. 启动工作台桥接服务（server/，前台主窗口）----
echo Starting bridge service on http://127.0.0.1:17755 ...
start "" http://127.0.0.1:17755

"%NODE_EXE%" server\server.js
if errorlevel 1 (
  echo.
  echo [ERROR] Service exited unexpectedly. See messages above.
  pause
)
