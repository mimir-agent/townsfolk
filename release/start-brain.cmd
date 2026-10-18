@echo off
rem Starts the townsfolk brain. Only the host runs this; joining players do not need it.
rem Keep this window open while you play. Close it to stop the brain.
setlocal
title townsfolk brain

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, or this window cannot find it.
  echo Install the LTS version from https://nodejs.org, then double-click start-brain.cmd again.
  pause
  exit /b 1
)

node "%~dp0brain\start.mjs"
echo.
echo The brain stopped. Read the lines above for the reason.
pause
