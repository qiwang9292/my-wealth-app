@echo off
cd /d "%~dp0"
title 财富应用 - 启动开发环境

where node >nul 2>&1 || (
  echo 未找到 Node.js。请先安装 Node.js，并确保已加入系统 PATH。
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo 未找到 node_modules。请先在项目根目录执行: npm install
  pause
  exit /b 1
)

set PORT=3000
echo 正在启动 Next.js 开发服务器...
echo 启动完成后会自动打开浏览器（http://localhost:%PORT%/）。
echo.
start "财富应用 - 开发服务" cmd /k "npm run dev"
echo 等待本机 %PORT% 端口就绪（最多约 2 分钟，编译慢时请稍候）...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wait-dev-port.ps1" -Port %PORT% -TimeoutSec 120
if errorlevel 1 (
  echo.
  echo 仍未检测到端口 %PORT%。请查看「财富应用 - 开发服务」窗口里的报错（例如编译失败、端口被占用）。
  pause
  exit /b 1
)
start "" "http://localhost:%PORT%/"
echo.
echo 浏览器已打开。关闭「财富应用 - 开发服务」窗口即可停止服务器。
timeout /t 4 /nobreak >nul
