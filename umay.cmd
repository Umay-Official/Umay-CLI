@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 veya daha yeni bir surum gerekli: https://nodejs.org
  if "%~1"=="" pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 22 veya daha yeni bir surum gerekli: https://nodejs.org
  if "%~1"=="" pause
  exit /b 1
)
if not exist "%~dp0node_modules\ai\package.json" (
  echo Gerekli paketler kuruluyor...
  pushd "%~dp0"
  call npm ci --no-fund
  if errorlevel 1 (
    popd
    if "%~1"=="" pause
    exit /b 1
  )
  popd
)
node "%~dp0src\cli.mjs" %*
set "umay_exit=%errorlevel%"
if "%~1"=="" if not "%umay_exit%"=="0" pause
exit /b %umay_exit%
