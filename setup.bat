@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Influencer CRM Platform - Setup
echo ============================================
echo.

REM ---- Step 1: Check Node.js ----
echo [1/3] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is not installed.
  echo.
  echo Please download and install Node.js LTS from:
  echo   https://nodejs.org
  echo.
  echo After installing, close this window and run setup.bat again.
  echo.
  echo Opening Node.js download page in your browser...
  start https://nodejs.org
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo   Node.js version: %%v
echo.

REM ---- Step 2: Install npm dependencies ----
echo [2/3] Installing dependencies...
if exist "node_modules\" (
  echo   node_modules already exists, skipping.
) else (
  echo   Running npm install, this may take a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Please check your network connection.
    pause
    exit /b 1
  )
)
echo.

REM ---- Step 3: Install Playwright browser ----
echo [3/3] Installing Playwright browser (chromium)...
echo   Using China mirror for faster download.
echo   This may take a few minutes (about 180 MB).
echo.
set PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright
call npx playwright install chromium
if errorlevel 1 (
  echo.
  echo [ERROR] Playwright install failed.
  echo You can retry manually: npx playwright install chromium
  pause
  exit /b 1
)
echo.

echo ============================================
echo   Setup complete!
echo ============================================
echo.
echo Next step:
echo   1. Double-click start.bat to launch the app
echo   2. Open Settings in the browser to configure brands, templates, signer, etc.
echo.
echo Optional:
echo   - Double-click install-backup-task.bat to enable daily auto backup
echo.
pause
