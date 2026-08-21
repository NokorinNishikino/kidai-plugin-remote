@echo off
rem ============================================================
rem  Kidai Plugin Remote  (ASCII-safe launcher; UI is Chinese)
rem  - Standalone manager, runs outside DSH / DSH Desktop
rem  - Requires Node.js >= 20 on PATH
rem  - Opens the manager in an app-mode browser window
rem    (http://127.0.0.1:4877); the console minimizes after a
rem    successful DSH launch.
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Kidai Plugin Remote] node.exe not found on PATH.
  echo Please install Node.js >= 20 from https://nodejs.org
  echo or set PATH, then run this launcher again.
  pause
  exit /b 1
)

if "%KPR_PORT%"=="" set "KPR_PORT=4877"

echo [Kidai Plugin Remote] starting manager on http://127.0.0.1:%KPR_PORT%
echo [Kidai Plugin Remote] closing this window stops the manager (DSH is unaffected).
echo.

node server.js
set "NODE_EXIT=%ERRORLEVEL%"
echo.
echo [Kidai Plugin Remote] manager exited with code %NODE_EXIT%.
pause
exit /b %NODE_EXIT%
