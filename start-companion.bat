@echo off
title Code Courier Companion

cd /d "%~dp0"

if not exist ".env" (
    echo [ERROR] Missing .env
    pause
    exit /b 1
)

if not exist "node_modules" (
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
)

if "%~1"=="" (
    node app\companion.js
) else (
    node app\companion.js pair %1
)

if errorlevel 1 (
    echo.
    echo [ERROR] Companion stopped with error
    pause
    exit /b 1
)
