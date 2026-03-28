@echo off
chcp 65001 >nul
title Настройка Code Courier
echo Открываю .env для редактирования...
if exist ".env" (
    notepad .env
) else (
    if exist ".env.example" (
        echo .env не найден, копирую из .env.example...
        copy ".env.example" ".env" >nul
        notepad .env
    ) else (
        echo [ERROR] Нет файла .env и .env.example
        pause
    )
)
