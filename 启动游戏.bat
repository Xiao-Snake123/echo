@echo off
chcp 65001 >nul
title ECHO - 启动游戏
cd /d "%~dp0"

echo [1/3] 检查依赖...
if not exist "server\node_modules" (
  echo        安装 server 依赖...
  pushd server
  call npm install
  popd
)
if not exist "client\node_modules" (
  echo        安装 client 依赖...
  pushd client
  call npm install
  popd
)

echo [2/3] 检查前端构建...
if not exist "client\dist\index.html" (
  echo        构建前端（第一次约需十几秒）...
  pushd client
  call npm run build
  popd
)

echo [3/3] 停止旧进程并启动...
call :stopold
start "ECHO 服务器" cmd /k "cd /d %~dp0server && node index.js"
timeout /t 2 >nul
start http://localhost:8787

echo.
echo 已启动: http://localhost:8787      后台: http://localhost:8787/admin
echo 服务器跑在弹出的黑色窗口里，关掉那个窗口 = 停止服务
timeout /t 4 >nul
exit /b

:stopold
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
exit /b
