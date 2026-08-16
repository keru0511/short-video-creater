#!/usr/bin/env bash
# macOSでダブルクリックしてGUIを起動・ブラウザを開きます
set -e
cd "$(dirname "$0")"

MISE_BIN="${MISE:-$HOME/.local/bin/mise}"

if command -v mise >/dev/null 2>&1; then
  exec mise x -- node src/gui/launcher-bootstrap.mjs
elif [ -x "$MISE_BIN" ]; then
  exec "$MISE_BIN" x -- node src/gui/launcher-bootstrap.mjs
elif command -v node >/dev/null 2>&1; then
  exec node src/gui/launcher-bootstrap.mjs
else
  echo "Node.js / mise が見つかりません。mise をインストールするか Node.js を PATH に追加してください。" >&2
  exit 1
fi
