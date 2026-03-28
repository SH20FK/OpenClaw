@echo off
title Code Courier Bot

cd /d "%~dp0"

echo ==========================================
echo   Code Courier Bot Launcher
echo ==========================================
echo.

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not installed
    pause
    exit /b 1
)

if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo [INFO] Created .env from template
        start notepad .env
        pause
        exit /b 1
    ) else (
        echo [ERROR] .env.example not found
        pause
        exit /b 1
    )
)

if not exist "node_modules" (
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
)

node app\index.js

if errorlevel 1 (
    echo.
    echo [ERROR] Bot stopped with error
    pause
    exit /b 1
)
