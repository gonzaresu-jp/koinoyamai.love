#!/bin/bash
# 各アプリの package.json から native 依存と engines を検査
# node は明示指定する（PATH 依存だと /usr/bin/node = v18 EOL を掴むため。AGENTS.md §5）
NODE_BIN="/home/yuzuki/.nvm/versions/node/v24.22.1/bin/node"
DIRS="/var/www/private/fcpass /var/www/html/temp /var/www/html/app/squiish /var/www/html/upload /opt/hitori-twitter"
for d in $DIRS; do
  echo "==== $d ===="
  if [ ! -f "$d/package.json" ]; then echo "  (no package.json)"; continue; fi
  "$NODE_BIN" /var/www/html/koinoyamai.love/scripts/ops/check-native.js "$d/package.json"
  echo
done