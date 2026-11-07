@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\remove.ps1" %*
echo.
pause
