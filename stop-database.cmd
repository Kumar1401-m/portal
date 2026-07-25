@echo off
rem Gracefully stop the local Agency ERP MySQL database.
"C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqladmin.exe" --no-defaults -h 127.0.0.1 -P 3306 -u root shutdown
echo MySQL stopped.
