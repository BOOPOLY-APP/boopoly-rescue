@echo off
chcp 65001 >nul
title BOOPOLY Rescue
setlocal
set "EXE=%~dp0BOOPOLY-Rescue.exe"
if not exist "%EXE%" set "EXE=%~dp0dist\BOOPOLY-Rescue.exe"
if not exist "%EXE%" (
  echo.
  echo [!] BOOPOLY-Rescue.exe not found next to this file or in dist\ .
  echo     Put this .bat in the same folder as BOOPOLY-Rescue.exe.
  echo.
  pause
  exit /b 1
)
"%EXE%"
echo.
echo ====================================================
echo  You can close this window.
echo ====================================================
pause >nul
