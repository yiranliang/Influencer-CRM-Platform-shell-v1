@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Install Auto Backup Task
echo ============================================
echo.
echo This will register a Windows Scheduled Task:
echo   Name:     InfluencerCRM_AutoBackup
echo   Runs:     backup.bat /silent
echo   Schedule: Daily at 3:00 AM
echo.
echo The task will:
echo   - Back up all data files (timestamped folders)
echo   - Back up credentials to backups\_credentials\ (overwrite)
echo   - Keep data backups for 30 days
echo.
echo To change frequency or time, edit this file and rerun.
echo.
echo To uninstall later, run uninstall-backup-task.bat
echo.
pause

schtasks /create /tn "InfluencerCRM_AutoBackup" /tr "\"%~dp0backup.bat\" /silent" /sc daily /st 03:00 /f

if errorlevel 1 (
  echo.
  echo [ERROR] Failed to create task. Try running as Administrator.
) else (
  echo.
  echo [OK] Task created successfully.
  echo      You can view it in Task Scheduler (taskschd.msc).
)
echo.
pause
