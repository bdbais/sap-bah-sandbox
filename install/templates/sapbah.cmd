@echo off
REM Shim so "sapbah start" works from cmd.exe without an execution-policy prompt.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sapbah.ps1" %*
