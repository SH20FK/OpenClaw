@echo off
title Code Courier Companion

cd /d "%~dp0"

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
