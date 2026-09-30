@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM ============================================
REM   Influencer CRM Platform - Update
REM ============================================
REM   This script downloads the latest code from GitHub
REM   and replaces code files only.
REM   Your data files, config files, and credentials are SAFE.
REM ============================================

echo ============================================
echo   Influencer CRM Platform - Update
echo ============================================
echo.

REM ---- Step 1: Check if we are in the right folder ----
if not exist "dashboard.html" (
  echo [ERROR] dashboard.html not found.
  echo Please run this script from the project folder.
  pause
  exit /b 1
)
if not exist "backup.bat" (
  echo [ERROR] backup.bat not found. Cannot proceed safely.
  pause
  exit /b 1
)

REM ---- Step 2: Check if server is running (port 3000) ----
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [ERROR] Port 3000 is in use. The server appears to be running.
  echo Please close the server window first, then run update again.
  pause
  exit /b 1
)

REM ---- Step 3: Backup current data ----
echo [1/5] Backing up current data...
call backup.bat /silent
if errorlevel 1 (
  echo [WARNING] Backup returned an error, but continuing anyway.
)
echo.

REM ---- Step 4: Read proxy config ----
set "PROXY_URL="
if exist "proxy_config.json" (
  for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "try { (Get-Content proxy_config.json -Raw -Encoding UTF8 | ConvertFrom-Json).proxyUrl } catch { '' }" 2^>nul`) do set "PROXY_URL=%%a"
)
if defined PROXY_URL (
  echo [2/5] Using proxy: !PROXY_URL!
  set "HTTPS_PROXY=!PROXY_URL!"
  set "HTTP_PROXY=!PROXY_URL!"
) else (
  echo [2/5] No proxy configured, using direct connection.
)
echo.

REM ---- Step 5: Download latest ZIP ----
echo [3/5] Downloading latest version from GitHub...
set "TEMP_DIR=%TEMP%\influencer-crm-update"
if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%"
mkdir "%TEMP_DIR%"

set "ZIP_URL=https://github.com/yiranliang/Influencer-CRM-Platform-shell-v1/archive/refs/heads/main.zip"
set "ZIP_FILE=%TEMP_DIR%\main.zip"

curl -L -f -o "%ZIP_FILE%" "%ZIP_URL%"
if errorlevel 1 (
  echo.
  echo [ERROR] Download failed. Check your network or proxy settings.
  echo You can also download manually from GitHub:
  echo   %ZIP_URL%
  echo.
  rmdir /s /q "%TEMP_DIR%" >nul 2>&1
  pause
  exit /b 1
)
echo   Downloaded: %ZIP_FILE%
echo.

REM ---- Step 6: Extract ----
echo [4/5] Extracting...
powershell -NoProfile -Command "Expand-Archive -Path '%ZIP_FILE%' -DestinationPath '%TEMP_DIR%\extracted' -Force"
if errorlevel 1 (
  echo [ERROR] Extraction failed.
  rmdir /s /q "%TEMP_DIR%" >nul 2>&1
  pause
  exit /b 1
)

REM Find extracted folder (name varies with branch)
set "SRC_DIR="
for /d %%d in ("%TEMP_DIR%\extracted\*") do set "SRC_DIR=%%d"
if not defined SRC_DIR (
  echo [ERROR] Extracted folder not found.
  rmdir /s /q "%TEMP_DIR%" >nul 2>&1
  pause
  exit /b 1
)
echo   Source: !SRC_DIR!
echo.

REM ---- Step 7: Copy code files (protect data) ----
echo [5/5] Updating code files...

REM Copy .js, .html, .bat, .md, .json (only examples), csv-templates
call :COPY_FILE "dashboard.html"
call :COPY_FILE "server.js"
call :COPY_FILE "gmailAutomation.js"
call :COPY_FILE "gmail_stats.js"
call :COPY_FILE "package.json"
call :COPY_FILE "package-lock.json"
call :COPY_FILE "start.bat"
call :COPY_FILE "setup.bat"
call :COPY_FILE "backup.bat"
call :COPY_FILE "install-backup-task.bat"
call :COPY_FILE "uninstall-backup-task.bat"
call :COPY_FILE "README.md"
call :COPY_FILE ".gitignore"

REM Example configs
call :COPY_FILE "apify_config.example.json"
call :COPY_FILE "contract_config.example.json"
call :COPY_FILE "email_config.example.json"

REM csv-templates folder
if exist "!SRC_DIR!\csv-templates" (
  if not exist "csv-templates" mkdir "csv-templates"
  xcopy /Y /E /I "!SRC_DIR!\csv-templates" "csv-templates" >nul 2>&1
  echo   [OK]   csv-templates/
)

REM ---- Step 8: Check if update.bat itself changed ----
if exist "!SRC_DIR!\update.bat" (
  fc "update.bat" "!SRC_DIR!\update.bat" >nul 2>&1
  if errorlevel 1 (
    echo.
    echo   [NOTE] A newer version of update.bat is available.
    echo          Please re-download the project ZIP to get the updated update.bat.
  )
)

REM ---- Cleanup ----
rmdir /s /q "%TEMP_DIR%" >nul 2>&1

echo.
echo ============================================
echo   Update complete!
echo ============================================
echo.
echo   - Data files were NOT touched.
echo   - Config files were NOT touched.
echo   - Credentials were NOT touched.
echo.
echo Start the app by double-clicking start.bat (or the desktop shortcut).
echo.
pause
exit /b 0

REM ============================================
REM   Subroutine: copy one code file if it exists
REM ============================================
:COPY_FILE
set "F=%~1"
if not exist "!SRC_DIR!\%F%" (
  goto :eof
)
copy /y "!SRC_DIR!\%F%" "%F%" >nul 2>&1
if errorlevel 1 (
  echo   [FAIL] %F%
) else (
  echo   [OK]   %F%
)
goto :eof
