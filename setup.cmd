@echo off
REM --- First-time setup for rev://MANTLE --------------------------------------
REM Installs dependencies and builds the UI. Run once after cloning, and again
REM after pulling UI changes. Then run start.cmd.
cd /d "%~dp0"
where bun >nul 2>nul || (
  echo Bun isn't installed. Get it from https://bun.sh, then re-run setup.cmd.
  pause
  exit /b 1
)
echo Installing dependencies...
bun install || ( echo. & echo Dependency install failed -- see the output above. & pause & exit /b 1 )
echo Building the UI...
bun run ui:build || ( echo. & echo UI build failed -- see the output above. & pause & exit /b 1 )
echo.
echo Setup complete. Run start.cmd, then open http://localhost:3333
echo (Optional extras -- voice/memory sidecars and local models -- are covered in the README.)
pause
