@echo off
REM ============================================================
REM  my-job-agent — one-click session starter for Hermes
REM  Double-click this file (or run from cmd) to:
REM   1. open a terminal in the project folder
REM   2. build + start the agent service in background
REM   3. launch Hermes ready to type "continue"
REM ============================================================
title My-Job Agent Launcher
cd /d %USERPROFILE%\projects\my-job-agent

echo.
echo [1/3] Building agent service...
call npm run build
if errorlevel 1 (
    echo BUILD FAILED — check output above.
    pause
    exit /b 1
)

echo [2/3] Starting service on port 3010...
start "my-job-agent-service" /min cmd /c "node dist\main.js > service.log 2>&1"
timeout /t 8 /nobreak >nul
curl -s http://localhost:3010/profile >nul 2>&1
if errorlevel 1 (
    echo WARNING: service not responding yet — check service.log
) else (
    echo Service is UP: dashboard at http://localhost:3010/
)

echo [3/3] Starting Hermes...
echo Type: continue
echo.
call hermes
