#!/bin/bash
# 各アプリの package.json から native 依存と engines を検査
DIRS="/var/www/private/fcpass /var/www/html/temp /var/www/html/app/squiish /var/www/html/upload /opt/hitori-twitter"
for d in $DIRS; do
  echo "==== $d ===="
  if [ ! -f "$d/package.json" ]; then echo "  (no package.json)"; continue; fi
  node /var/www/html/mai-push/scripts/ops/check-native.js "$d/package.json"
  echo
done