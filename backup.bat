@echo off
setlocal
cd /d "%~dp0"

REM ============================================
REM   AI Workflow - Data Auto Backup
REM   Backs up: cd_data / influencer_data / payment_data
REM              pipeline_data / email_config
REM
REM   Usage:
REM     double-click         interactive (pauses at end)
REM     backup.bat /silent   silent mode, for Task Scheduler
REM ============================================

set "SILENT=0"
if /i "%~1"=="/silent" set "SILENT=1"
if /i "%~1"=="--silent" set "SILENT=1"
if /i "%~1"=="/quiet" set "SILENT=1"

set "BACKUP_DIR=%~dp0backups"
set "OK=0"
set "SKIP=0"

REM ---- Build timestamp YYYYMMDD_HHMMSS ----
REM NOTE: wmic was removed in Windows 11 24H2+, so PowerShell is the
REM       primary source; wmic is kept only as a fallback.
set "TIMESTAMP="
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss" 2^>nul`) do set "TIMESTAMP=%%a"
if defined TIMESTAMP goto :TS_READY
set "dt="
for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value 2^>nul') do set "dt=%%a"
if not defined dt goto :TS_READY
set "TIMESTAMP=%dt:~0,4%%dt:~4,2%%dt:~6,2%_%dt:~8,2%%dt:~10,2%%dt:~12,2%"
:TS_READY
if not defined TIMESTAMP set "TIMESTAMP=unknown_%RANDOM%"

REM ---- Create this run's backup folder ----
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

call :BACKUP_FILE "cd_data.json"
call :BACKUP_FILE "influencer_data.json"
call :BACKUP_FILE "payment_data.json"
call :BACKUP_FILE "pipeline_data.json"
call :BACKUP_FILE "email_config.json"

echo.
echo ============================================
echo   Backup complete! %OK% backed up, %SKIP% skipped.
echo   Location: %THIS_BACKUP%
echo ============================================

REM ---- Remove backups older than 30 days ----
echo.
echo Cleaning backups older than 30 days...
forfiles /p "%BACKUP_DIR%" /d -30 /c "cmd /c if @isdir==TRUE rmdir /s /q @path" >nul 2>&1
echo Cleanup done.

REM ---- Append a log line so scheduled runs can be audited later ----
echo [%TIMESTAMP%] ok=%OK% skipped=%SKIP% >> "%BACKUP_DIR%\backup.log"

if "%SILENT%"=="0" (
  echo.
  echo Press any key to exit...
  pause >nul
)
exit /b 0

REM ============================================
REM   Subroutine: copy one file, tally the result
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
