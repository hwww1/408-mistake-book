@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装到此电脑.ps1"
if errorlevel 1 (
  echo.
  echo 安装没有完成，请把这个窗口中的提示截图发给 Codex。
  pause
)

