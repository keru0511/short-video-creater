@echo off
REM WindowsでダブルクリックしてGUIを起動・ブラウザを開きます
cd /d "%~dp0"

setlocal EnableDelayedExpansion

set "MISE_PATH="
for /f "delims=" %%i in ('where mise 2^>nul') do if not defined MISE_PATH set "MISE_PATH=%%i"

set "NODE_PATH="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_PATH set "NODE_PATH=%%i"

if defined MISE_PATH (
  "!MISE_PATH!" x -- node src/gui/launcher-bootstrap.mjs
  set "EL=!errorlevel!"
) else if defined NODE_PATH (
  "!NODE_PATH!" src/gui/launcher-bootstrap.mjs
  set "EL=!errorlevel!"
) else (
  echo Node.js / mise が見つかりません。mise をインストールするか Node.js を PATH に追加してください。
  pause
  exit /b 1
)

if !EL! neq 0 (
  echo 起動に失敗しました（終了コード !EL!）。上記のエラーを確認してください。
  pause
  exit /b !EL!
)
