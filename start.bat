@echo off
setlocal
title Deadlock Replay Analyzer

rem Serves the app on 127.0.0.1 and opens your browser.
rem PowerShell ships with Windows, so there is nothing to install.

where powershell >nul 2>&1
if %errorlevel%==0 (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
    goto :end
)

where pwsh >nul 2>&1
if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
    goto :end
)

rem Fallbacks if PowerShell is somehow unavailable.
where python >nul 2>&1
if %errorlevel%==0 (
    echo Serving with Python on http://127.0.0.1:8777/
    start "" http://127.0.0.1:8777/
    python -m http.server 8777 --bind 127.0.0.1 --directory "%~dp0."
    goto :end
)

echo.
echo Could not find PowerShell or Python to serve the app.
echo Open a terminal in this folder and run any static file server, then
echo browse to the address it prints.
echo.

:end
echo.
echo Server stopped.
pause
