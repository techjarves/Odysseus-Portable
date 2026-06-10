@echo off
setlocal

cd /d "%~dp0\.."

echo =================================================================
echo          ODYSSEUS PORTABLE - RESET TO FACTORY DEFAULTS
echo =================================================================
echo.
echo This will DELETE all installed components and start fresh:
echo   - bin\          (embedded Python + llama.cpp binaries)
echo   - odysseus\     (Odysseus web app)
echo   - logs\         (all log files)
echo   - chrome-debug-profile\  (browser session data)
echo   - node_modules\ (Node.js packages)
echo   - data\bootstrap\ and runtime launcher state
echo.
echo The following will be KEPT:
echo   - models\       (your downloaded models - SAFE)
echo   - src\          (launcher source code)
echo   - scripts\      (bootstrap scripts)
echo   - start.bat / start.sh
echo   - package.json
echo   - README.md
echo.

set /p CONFIRM="Are you sure you want to reset? Type YES to continue: "
if /i not "%CONFIRM%"=="YES" (
    echo Reset cancelled.
    pause
    exit /b 0
)

echo.
echo [Reset] Starting cleanup...

REM --- Delete installed components ---

if exist "bin" (
    echo [Reset] Removing bin\ ...
    rmdir /s /q "bin"
)

if exist "odysseus" (
    echo [Reset] Removing odysseus\ ...
    rmdir /s /q "odysseus"
)

if exist "logs" (
    echo [Reset] Removing logs\ ...
    rmdir /s /q "logs"
)

if exist "chrome-debug-profile" (
    echo [Reset] Removing chrome-debug-profile\ ...
    rmdir /s /q "chrome-debug-profile"
)

if exist "node_modules" (
    echo [Reset] Removing node_modules\ ...
    rmdir /s /q "node_modules"
)

if exist "data\bootstrap" (
    echo [Reset] Removing data\bootstrap\ ...
    rmdir /s /q "data\bootstrap"
)

if exist "data\runtime.json" (
    echo [Reset] Removing data\runtime.json ...
    del /f /q "data\runtime.json"
)

if exist "data\launcher_config.json" (
    echo [Reset] Removing data\launcher_config.json ...
    del /f /q "data\launcher_config.json"
)

REM --- Recreate empty logs directory ---
mkdir "logs"
echo. > "logs\.gitkeep"

echo.
echo =================================================================
echo  Reset complete!
echo  Your models are safe in the models\ folder.
echo  Run start.bat to install everything fresh from scratch.
echo =================================================================
echo.
pause
