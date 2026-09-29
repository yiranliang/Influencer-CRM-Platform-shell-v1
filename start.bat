@echo off
title Influencer CRM Server - Closing this window will stop the app
cd /d "%~dp0"

REM ---- Check if setup has been run ----
if not exist "node_modules\" (
  echo.
  echo [ERROR] node_modules not found.
  echo.
  echo Please run setup.bat first to install dependencies.
  echo.
  powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Setup not complete. Please run setup.bat first.', 'Influencer CRM', 'OK', 'Warning')" 2>nul
  pause
  exit /b 1
)

REM ---- Set Playwright browser path ----
if not defined PLAYWRIGHT_BROWSERS_PATH (
  if exist "D:\PlaywrightBrowsers" (
    set "PLAYWRIGHT_BROWSERS_PATH=D:\PlaywrightBrowsers"
  ) else (
    set "PLAYWRIGHT_BROWSERS_PATH=%USERPROFILE%\AppData\Local\ms-playwright"
  )
)

REM ---- Start the server ----
echo ============================================
echo   Influencer CRM Server
echo ============================================
echo.
echo Starting server... Do NOT close this window while using the app.
echo.
echo The browser will open automatically.
echo If not, visit: http://localhost:3000/dashboard.html
echo.
echo To stop the server, close this window or press Ctrl+C.
echo.

node server.js

REM ---- If node exits with error, show popup ----
if errorlevel 1 (
  echo.
  echo [ERROR] Server exited unexpectedly.
  powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Server stopped unexpectedly. Check the console window for details.', 'Influencer CRM', 'OK', 'Error')" 2>nul
)

pause
