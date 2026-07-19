@echo off
REM --- Boot rev://MANTLE (foreground) -----------------------------------------
REM Builds the UI if it's stale, starts the server in this window (logs print
REM here, Ctrl+C stops it cleanly), then opens the browser. For a detached
REM background service instead, use:  mantle start
cd /d "%~dp0"
where bun >nul 2>nul || (
  echo Bun isn't installed. Get it from https://bun.sh, then run setup.cmd.
  pause
  exit /b 1
)
bun run scripts/start.ts
pause
