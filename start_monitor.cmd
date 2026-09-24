@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=node"
set "NPM_EXE=npm"
where node >nul 2>nul
if errorlevel 1 (
  set "NODE_EXE=%CD%\.runtime\node-v22.19.0-win-x64\node.exe"
  set "NPM_EXE=%CD%\.runtime\node-v22.19.0-win-x64\npm.cmd"
  if not exist "%CD%\.runtime\node-v22.19.0-win-x64\node.exe" (
    echo Downloading portable Node.js for the first launch...
    if not exist ".runtime" mkdir ".runtime"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $zip='.runtime\node.zip'; Invoke-WebRequest 'https://nodejs.org/dist/v22.19.0/node-v22.19.0-win-x64.zip' -OutFile $zip; Expand-Archive $zip '.runtime' -Force; Remove-Item $zip"
    if errorlevel 1 (
      echo Node.js download failed. Check the internet connection.
      pause
      exit /b 1
    )
  )
  set "PATH=%CD%\.runtime\node-v22.19.0-win-x64;%PATH%"
)
if not exist "node_modules\" (
  echo Installing dependencies...
  call "%NPM_EXE%" install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)
"%NODE_EXE%" src\server.js
if errorlevel 1 pause
