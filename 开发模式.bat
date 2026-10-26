@echo off
chcp 65001 >nul
title ECHO - 开发模式
cd /d "%~dp0"

call :stopold
if not exist "server\node_modules" (
  pushd server
  call npm install
  popd
)
if not exist "client\node_modules" (
  pushd client
  call npm install
  popd
)

start "ECHO 开发服务器" cmd /k "cd /d %~dp0server && node index.js --dev"
timeout /t 2 >nul
start http://localhost:8787

echo.
echo 开发模式已启动: http://localhost:8787（仍然是 8787，不要用 client 里的 5173）
echo 改前端文件即时生效；改服务端自动重启。关掉黑色窗口 = 停止。
timeout /t 4 >nul
exit /b

:stopold
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
exit /b
