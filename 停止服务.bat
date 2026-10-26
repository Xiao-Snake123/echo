@echo off
chcp 65001 >nul
title ECHO - 停止服务
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do taskkill /F /PID %%a 2>nul
echo 8787 上的服务已停止。
timeout /t 2 >nul
