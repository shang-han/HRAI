@echo off
cd /d "%~dp0"

echo ========================================
echo   Hermes HR Admin - Starting...
echo ========================================
echo.

echo [1/2] Building...
call node build-main.mjs
call npx vite build 2>nul

echo [2/2] Launching Electron...
echo.

set ELECTRON_ENABLE_LOGGING=1
node_modules\electron\dist\electron.exe .

echo.
echo Hermes exited.
pause
