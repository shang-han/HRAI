@echo off
cd /d "%~dp0"
echo ========================================
echo   Hermes Preload Diagnostic
echo ========================================
echo.
set ELECTRON_ENABLE_LOGGING=1
node_modules\electron\dist\electron.exe diag-app
echo.
echo ========================================
echo   Done. Copy output above and send to me
echo ========================================
pause
