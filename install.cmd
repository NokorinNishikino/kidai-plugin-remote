@echo off
rem ============================================================
rem  Kidai Plugin Remote - one-click install (ASCII-safe)
rem   1. checks Node.js >= 20
rem   2. optionally installs the in-DSH guard (kidai-snapshot-guard)
rem      into profile 'desktop'
rem   3. optionally creates a desktop shortcut
rem ============================================================
setlocal
set "KPR_ROOT=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [KPR] node.exe not found on PATH.
  echo       Install Node.js >= 20 from https://nodejs.org first.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do set "NODE_VER=%%v"
echo [KPR] Node found: %NODE_VER%

echo.
set "INSTALL_GUARD="
set /p INSTALL_GUARD="Install the in-DSH guard (kidai-snapshot-guard) into profile 'desktop'? [Y/n]: "
if /i "%INSTALL_GUARD%"=="" set "INSTALL_GUARD=Y"
if /i "%INSTALL_GUARD%"=="Y" (
  echo [KPR] installing guard...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%KPR_ROOT%scripts\install-guard.ps1"
  if errorlevel 1 echo [KPR] guard install failed.
)

echo.
set "MAKE_SC="
set /p MAKE_SC="Create a desktop shortcut for the classic launcher? [Y/n]: "
if /i "%MAKE_SC%"=="" set "MAKE_SC=Y"
if /i "%MAKE_SC%"=="Y" (
  echo [KPR] creating desktop shortcut...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%KPR_ROOT%scripts\install-shortcut.ps1"
  if errorlevel 1 echo [KPR] shortcut creation failed.
)

echo.
echo [KPR] Done. Start options:
echo       - desktop shortcut (classic launcher, browser window)
echo       - node "%KPR_ROOT%server.js"
echo       - zero-dependency: kidai-plugin-remote-client\dist\Kidai Plugin Remote Client.exe
pause
endlocal
