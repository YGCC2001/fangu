@echo off
chcp 65001 >nul
cd /d "%~dp0"
title fangu launcher

echo.
echo   fangu - starting server + public tunnels
echo   ----------------------------------------
echo.

where node >nul 2>nul || (echo [x] Node.js not found in PATH & pause & exit /b 1)

set PORT=3000
set ADMIN_PORT=3001

start "fangu server :3000 / :3001" cmd /k "node server.js"
timeout /t 2 >nul

set CF=%USERPROFILE%\.workbuddy\bin\cloudflared.exe
if not exist "%CF%" (
  echo [!] cloudflared not found at %CF%
  echo     Local only: http://localhost:3000  ^|  http://localhost:3001
  echo.
  pause
  exit /b 0
)

start "fangu tunnel - participants" cmd /k ""%CF%" tunnel --url http://localhost:3000 --protocol http2 --no-autoupdate"
start "fangu tunnel - operators" cmd /k ""%CF%" tunnel --url http://localhost:3001 --protocol http2 --no-autoupdate"

echo.
echo   Three windows opened:
echo     1. fangu server       local :3000 (participants) / :3001 (operators)
echo     2. tunnel participants  copy the https://*.trycloudflare.com line
echo     3. tunnel operators     same, for the admin console
echo.
echo   Note: quick tunnel URLs change every restart. For a fixed URL see DEPLOY.md
echo.
pause
