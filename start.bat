@echo off
rem ===========================================================================
rem  Bili-Ticket-Go-Task-Auto-Recovery 一键启动入口
rem  双击本文件即可开始守护：BTG 已运行则监控，未运行则自动启动并恢复最新任务。
rem  优先使用同目录下的便携 node.exe；找不到则回退到 PATH 中的 node。
rem  关闭本窗口即停止守护（Interactive 会话，进程生命周期绑定到本控制台）。
rem ===========================================================================
setlocal
cd /d "%~dp0"

rem 优先使用同目录下的便携 node.exe；不存在才回退到 PATH 中的 node。
if exist "%~dp0node.exe" (
  set "NODE_EXE=%~dp0node.exe"
) else (
  where node.exe >nul 2>nul
  if errorlevel 1 (
    echo [start] 未找到 Node.js。
    echo [start] 请把便携版 node.exe 放到本目录，或安装 Node.js 并加入 PATH。
    echo.
    pause
    exit /b 1
  )
  set "NODE_EXE=node.exe"
)

echo [start] 启动 Bili-Ticket-Go-Task-Auto-Recovery 守护进程...
echo [start] BTG 已运行则监控，未运行则自动启动并恢复最新任务。
echo [start] 关闭本窗口即停止守护。
echo.

"%NODE_EXE%" "bili-ticket-go-task-auto-recovery.js" run

echo.
echo [start] 守护进程已退出（退出码 %errorlevel%）。
pause
