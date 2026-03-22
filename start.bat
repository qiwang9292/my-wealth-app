@echo off
cd /d "%~dp0"
title Wealth Tracker
echo Starting Wealth Tracker...
echo.
start "Wealth Tracker" cmd /k "npm run dev"
echo Waiting for server...
timeout /t 6 /nobreak >nul
start http://localhost:3000
echo Browser opened. Close the "Wealth Tracker" window to stop the server.
exit
