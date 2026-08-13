@echo off
setlocal
title Deploy Deadlock Replay Analyzer to GitHub Pages
cd /d "%~dp0"

set "REPO=deadlock-replay-analyzer"

echo.
echo   Deadlock Replay Analyzer - publish to GitHub Pages
echo.

where git >nul 2>&1
if errorlevel 1 goto :nogit

where gh >nul 2>&1
if errorlevel 1 goto :nogh

gh auth status >nul 2>&1
if errorlevel 1 (
    echo   Signing in to GitHub...
    gh auth login
    if errorlevel 1 goto :fail
)

for /f "delims=" %%i in ('gh api user --jq .login 2^>nul') do set "OWNER=%%i"
if not defined OWNER goto :fail
echo   Signed in as %OWNER%.

if not exist ".git" (
    echo   Creating a git repository...
    git init -b main
    if errorlevel 1 goto :fail
)

rem A commit needs an identity; only set one if the repo does not have it already.
git config user.name >nul 2>&1
if errorlevel 1 git config user.name "%OWNER%"
git config user.email >nul 2>&1
if errorlevel 1 git config user.email "%OWNER%@users.noreply.github.com"

git add -A
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Update Deadlock replay analyzer" >nul
    echo   Committed local changes.
) else (
    echo   Nothing new to commit.
)

gh repo view "%OWNER%/%REPO%" >nul 2>&1
if errorlevel 1 (
    echo   Creating github.com/%OWNER%/%REPO% ...
    gh repo create "%REPO%" --public --source=. --remote=origin --push
    if errorlevel 1 goto :fail
) else (
    echo   Repository already exists, pushing to it...
    git remote get-url origin >nul 2>&1
    if errorlevel 1 git remote add origin "https://github.com/%OWNER%/%REPO%.git"
    git push -u origin main
    if errorlevel 1 goto :pushfail
)

echo   Turning on GitHub Pages ^(source: GitHub Actions^)...
gh api -X POST "repos/%OWNER%/%REPO%/pages" -f build_type=workflow >nul 2>&1
if errorlevel 1 gh api -X PUT "repos/%OWNER%/%REPO%/pages" -f build_type=workflow >nul 2>&1

echo.
echo   Done.
echo.
echo   Repo     https://github.com/%OWNER%/%REPO%
echo   Actions  https://github.com/%OWNER%/%REPO%/actions
echo   Site     https://%OWNER%.github.io/%REPO%/
echo.
echo   The first build takes a minute or two. If the site 404s, open the
echo   Actions link and check the run finished green.
echo.
pause
exit /b 0

:nogit
echo   Git is not installed, or not on PATH.
echo   Get it from https://git-scm.com/download/win
goto :end

:nogh
echo   The GitHub CLI is not installed, or not on PATH.
echo   Get it from https://cli.github.com/ then run this again.
echo.
echo   Without it you can still publish by hand:
echo     git init -b main ^&^& git add -A ^&^& git commit -m "Deadlock replay analyzer"
echo     git remote add origin https://github.com/YOUR-NAME/%REPO%.git
echo     git push -u origin main
echo   then Settings -^> Pages -^> Source: GitHub Actions
goto :end

:pushfail
echo.
echo   The push was rejected. The usual cause is that GitHub created the
echo   repository with its own first commit (a README or licence), which does
echo   not share history with this folder.
echo.
echo   If the repository has nothing in it you want to keep, overwrite it:
echo       git push -u origin main --force
echo.
echo   To keep what is there instead:
echo       git pull --rebase origin main --allow-unrelated-histories
echo       git push -u origin main
goto :end

:fail
echo.
echo   Something went wrong above. Nothing was left half-done that a re-run
echo   will not fix - this script is safe to run again.

:end
echo.
pause
exit /b 1
