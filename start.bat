@echo off
if not defined PLAYWRIGHT_BROWSERS_PATH (
    if exist "D:\PlaywrightBrowsers" (
        set PLAYWRIGHT_BROWSERS_PATH=D:\PlaywrightBrowsers
    ) else (
        set PLAYWRIGHT_BROWSERS_PATH=%USERPROFILE%\AppData\Local\ms-playwright
    )
)
node server.js