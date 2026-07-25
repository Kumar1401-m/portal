@echo off
rem ============================================================
rem  Agency ERP - start the local MySQL database (port 3306)
rem  Data lives in %LOCALAPPDATA%\AgencyERP\mysql-data
rem  Run this after a reboot, before "npm start".
rem ============================================================
set DATADIR=%LOCALAPPDATA%\AgencyERP\mysql-data

tasklist /FI "IMAGENAME eq mysqld.exe" | find /I "mysqld.exe" >nul
if %ERRORLEVEL%==0 (
  echo MySQL is already running.
  exit /b 0
)

echo Starting MySQL from %DATADIR% ...
start "AgencyERP-MySQL" /MIN "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe" --no-defaults --datadir="%DATADIR%" --port=3306 --bind-address=127.0.0.1 --console
echo MySQL starting in a minimized window. Close that window (or run stop-database.cmd) to stop it.
