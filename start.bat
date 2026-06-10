@echo off
title Odysseus Portable
setlocal enabledelayedexpansion

cd /d "%~dp0"

set "NODE_VERSION=22.16.0"
set "NODE_DIR=%CD%\bin\node"
set "NODE_EXE=%NODE_DIR%\node.exe"

echo ===================================================
echo   Odysseus Portable Launcher
echo ===================================================

if not exist "%NODE_EXE%" (
    echo [Bootstrap] Portable Node.js not found. Downloading Node.js %NODE_VERSION%...
    if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
        set "NODE_ARCH=arm64"
    ) else (
        set "NODE_ARCH=x64"
    )
    set "NODE_ZIP=node-v%NODE_VERSION%-win-!NODE_ARCH!.zip"
    set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/!NODE_ZIP!"
    set "TMP_DIR=%CD%\data\bootstrap\node"
    set "ZIP_PATH=!TMP_DIR!\!NODE_ZIP!"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\bootstrap-node.ps1" -Version "%NODE_VERSION%" -NodeDir "%NODE_DIR%"
    if errorlevel 1 (
        echo [ERROR] Failed to bootstrap portable Node.js.
        pause
        exit /b 1
    )
)

echo Starting orchestrator...
"%NODE_EXE%" src/start.js %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo ===================================================
    echo   [ERROR] Orchestrator exited with code %ERRORLEVEL%
    echo   Please check the logs above or in the 'logs/' folder.
    echo ===================================================
    pause
)
