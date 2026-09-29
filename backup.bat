@echo off
setlocal
cd /d "%~dp0"

REM ============================================
REM   Influencer CRM Platform - Data Auto Backup
REM
REM   What this backs up:
REM     1. Data files (one timestamped folder per run)
REM        - cd_data / influencer_data / payment_data
REM        - pipeline_data / email_config / contract_config
REM        - tools_config / pipeline_homepage_check
REM     2. Credentials (to backups\_credentials\, overwrite mode)
REM        - credentials.json / token.json / apify_config.json
REM
REM   [IMPORTANT] About credential backup:
REM     - Credentials are tied to your account; losing them is painful.
REM     - But credentials must NOT be shared, so they go to _credentials\.
REM     - If you sync backups\ to cloud/USB, EXCLUDE _credentials\.
REM     - To disable credential backup, set BACKUP_CREDENTIALS=0 below.
REM
REM   Config:
REM     KEEP_DAYS             Days to keep data backups (default 30)
REM     BACKUP_CREDENTIALS    1=backup credentials, 0=skip (default 1)
REM
REM   Usage:
REM     double-click         interactive (pauses at end)
REM     backup.bat /silent   silent mode (for Task Scheduler)
REM ============================================

REM ---- Config ----
set "KEEP_DAYS=30"
set "BACKUP_CREDENTIALS=1"

set "SILENT=0"
if /i "%~1"=="/silent" set "SILENT=1"
if /i "%~1"=="--silent" set "SILENT=1"
if /i "%~1"=="/quiet" set "SILENT=1"

set "BACKUP_DIR=%~dp0backups"
set "CRED_DIR=%BACKUP_DIR%\_credentials"
set "OK=0"
set "SKIP=0"

REM ---- Build timestamp YYYYMMDD_HHMMSS ----
set "TIMESTAMP="
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss" 2^>nul`) do set "TIMESTAMP=%%a"
if defined TIMESTAMP goto :TS_READY
set "dt="
for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value 2^>nul') do set "dt=%%a"
if not defined dt goto :TS_READY
set "TIMESTAMP=%dt:~0,4%%dt:~4,2%%dt:~6,2%_%dt:~8,2%%dt:~10,2%%dt:~12,2%"
:TS_READY
if not defined TIMESTAMP set "TIMESTAMP=unknown_%RANDOM%"

REM ---- Create backup folders ----
set "THIS_BACKUP=%BACKUP_DIR%\%TIMESTAMP%"
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%" >nul 2>&1
if not exist "%THIS_BACKUP%" mkdir "%THIS_BACKUP%" >nul 2>&1
if not exist "%THIS_BACKUP%" (
  echo [ERROR] Cannot create backup folder: %THIS_BACKUP%
  if "%SILENT%"=="0" pause
  exit /b 1
)

echo ============================================
echo   Backing up data...
echo   Target: %THIS_BACKUP%
echo ============================================

REM ---- Backup data files ----
call :BACKUP_FILE "cd_data.json"
call :BACKUP_FILE "influencer_data.json"
call :BACKUP_FILE "payment_data.json"
call :BACKUP_FILE "pipeline_data.json"
call :BACKUP_FILE "email_config.json"
call :BACKUP_FILE "contract_config.json"
call :BACKUP_FILE "tools_config.json"
call :BACKUP_FILE "pipeline_homepage_check.json"

REM ---- Backup credentials (separate folder, overwrite) ----
if "%BACKUP_CREDENTIALS%"=="1" (
  echo.
  echo ============================================
  echo   Backing up credentials to _credentials\...
  echo   WARNING: Do NOT share this folder.
  echo ============================================
  if not exist "%CRED_DIR%" mkdir "%CRED_DIR%" >nul 2>&1
  call :BACKUP_CRED "credentials.json"
  call :BACKUP_CRED "token.json"
  call :BACKUP_CRED "apify_config.json"
)

echo.
echo ============================================
echo   Backup complete! %OK% backed up, %SKIP% skipped.
echo   Location: %THIS_BACKUP%
if "%BACKUP_CREDENTIALS%"=="1" echo   Credentials: %CRED_DIR%
echo ============================================

REM ---- Clean old data backups (not _credentials) ----
echo.
echo Cleaning data backups older than %KEEP_DAYS% days...
forfiles /p "%BACKUP_DIR%" /d -%KEEP_DAYS% /c "cmd /c if @isdir==TRUE rmdir /s /q @path" >nul 2>&1
echo Cleanup done.

REM ---- Log ----
echo [%TIMESTAMP%] ok=%OK% skipped=%SKIP% cred=%BACKUP_CREDENTIALS% >> "%BACKUP_DIR%\backup.log"

if "%SILENT%"=="0" (
  echo.
  echo Press any key to exit...
  pause >nul
)
exit /b 0

REM ============================================
REM   Subroutine: copy one data file
REM ============================================
:BACKUP_FILE
set "F=%~1"
if not exist "%F%" (
  echo   [SKIP] %F% - not found
  set /a SKIP+=1
  goto :eof
)
copy /y "%F%" "%THIS_BACKUP%\" >nul 2>&1
if errorlevel 1 (
  echo   [FAIL] %F%
) else (
  echo   [OK]   %F%
  set /a OK+=1
)
goto :eof

REM ============================================
REM   Subroutine: copy one credential to _credentials\
REM ============================================
:BACKUP_CRED
set "F=%~1"
if not exist "%F%" (
  echo   [SKIP] %F% - not found
  goto :eof
)
copy /y "%F%" "%CRED_DIR%\" >nul 2>&1
if errorlevel 1 (
  echo   [FAIL] %F%
) else (
  echo   [OK]   %F%
)
goto :eof
