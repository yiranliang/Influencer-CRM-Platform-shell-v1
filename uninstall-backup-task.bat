@echo off
setlocal

echo ============================================
echo   Uninstall Auto Backup Task
echo ============================================
echo.

schtasks /delete /tn "InfluencerCRM_AutoBackup" /f

if errorlevel 1 (
  echo.
  echo [ERROR] Failed to delete task. It may not exist.
) else (
  echo.
  echo [OK] Task deleted.
)
echo.
pause
