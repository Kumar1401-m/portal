@echo off
setlocal
title Agency ERP - Start All

REM ============================================================
REM  Starts MySQL + the Agency ERP app, then opens the browser.
REM  Double-click this file after every Windows restart.
REM ============================================================

set "MYSQLD=C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe"
set "DATADIR=C:\Users\VENKAT KUMAR\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\AgencyERP\mysql-data"
set "APPDIR=%~dp0"

echo.
echo  ============================================
echo    Agency ERP  -  starting services
echo  ============================================
echo.

if not exist "%MYSQLD%" (
  echo  ERROR: MySQL not found at:
  echo    %MYSQLD%
  pause
  exit /b 1
)
if not exist "%DATADIR%" (
  echo  ERROR: MySQL data folder not found at:
  echo    %DATADIR%
  pause
  exit /b 1
)

REM ---------- 1) MySQL ----------
netstat -ano | findstr "LISTENING" | findstr ":3306" >nul 2>&1
if %errorlevel%==0 (
  echo  [1/2] MySQL is already running on port 3306.
) else (
  echo  [1/2] Starting MySQL...
  start "MySQL - Agency ERP" /min "%MYSQLD%" --datadir="%DATADIR%"
)

REM ---------- wait for MySQL (up to ~30s) ----------
set /a tries=0
:waitmysql
netstat -ano | findstr "LISTENING" | findstr ":3306" >nul 2>&1
if %errorlevel%==0 goto mysqlup
set /a tries+=1
if %tries% GEQ 30 (
  echo  ERROR: MySQL did not come up. Check the MySQL window.
  pause
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto waitmysql

:mysqlup
echo        MySQL is up on port 3306.

REM ---------- 2) The app ----------
netstat -ano | findstr "LISTENING" | findstr ":4000" >nul 2>&1
if %errorlevel%==0 (
  echo  [2/2] App is already running on port 4000.
) else (
  echo  [2/2] Starting the app...
  cd /d "%APPDIR%"
  start "Agency ERP - Server" cmd /k node server.js
)

REM ---------- wait for the app (up to ~30s) ----------
set /a tries=0
:waitapp
netstat -ano | findstr "LISTENING" | findstr ":4000" >nul 2>&1
if %errorlevel%==0 goto appup
set /a tries+=1
if %tries% GEQ 30 (
  echo  ERROR: The app did not come up. Check the server window.
  pause
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto waitapp

:appup
echo        App is up on http://localhost:4000
echo.
echo  Opening the browser...
start "" http://localhost:4000
echo.
echo  ============================================
echo    Ready.  Login: admin@agency.com
echo    Keep the two windows open while working.
echo    Closing them stops the app.
echo  ============================================
echo.
pause
endlocal
