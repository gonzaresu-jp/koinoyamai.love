#!/usr/bin/env bash
# migrate-domain-final.sh
# 2026-10-19: 本番/staging ツリーを新名へ移動し、pm2 / crontab / systemd unit /
# ホームの nginx ヘルパーを付け替える（nginx 本体は apply-domain-final.sh で別途）。
#
#   /var/www/html/mai-push      -> /var/www/html/koinoyamai.love
#   /home/yuzuki/mai-push-test  -> /home/yuzuki/koinoyamai.love-test
#
# 注意: このスクリプト自身は「移動対象ディレクトリの外」から実行すること。
#       （移動中に読み取りパスが消えるのを避けるため /tmp にコピーして実行）
#   cp scripts/deploy/migrate-domain-final.sh /tmp/ && bash /tmp/migrate-domain-final.sh
#
# 実行ユーザー: yuzuki（/var/www/html は yuzuki 書込可のため sudo 不要）
set -euo pipefail

OLD_PROD=/var/www/html/mai-push
NEW_PROD=/var/www/html/koinoyamai.love
OLD_STG=/home/yuzuki/mai-push-test
NEW_STG=/home/yuzuki/koinoyamai.love-test

say(){ echo "[migrate] $*"; }

[ "$(id -un)" = yuzuki ] || { echo "[ERR] yuzuki で実行してください"; exit 1; }
[ -d "$OLD_PROD/.git" ] || { echo "[ERR] $OLD_PROD が見つかりません"; exit 1; }
[ ! -e "$NEW_PROD" ] || { echo "[ERR] $NEW_PROD が既に存在します（中断）"; exit 1; }
[ ! -e "$NEW_STG" ] || { echo "[ERR] $NEW_STG が既に存在します（中断）"; exit 1; }

say "pm2 停止"
for n in mai-push-api mai-push-worker discord-bot mai-push-api-test mai-push-worker-test; do
  if pm2 stop "$n" >/dev/null 2>&1; then say "  stop $n"; fi
done

say "フォルダ移動"
mv "$OLD_PROD" "$NEW_PROD"
if [ -d "$OLD_STG" ]; then mv "$OLD_STG" "$NEW_STG"; fi

say "git worktree 修復"
git -C "$NEW_PROD" worktree repair "$NEW_STG" || git -C "$NEW_PROD" worktree repair
git -C "$NEW_PROD" worktree list

say "crontab 更新（旧->新パス）"
crontab -l | sed "s#/var/www/html/mai-push#/var/www/html/koinoyamai.love#g; s#/home/yuzuki/mai-push-test#/home/yuzuki/koinoyamai.love-test#g" | crontab -
crontab -l | grep -nE "koinoyamai|mai-push" || true

say "pi-vector.service 更新"
UNIT="$HOME/.config/systemd/user/pi-vector.service"
if [ -f "$UNIT" ] && grep -q "/var/www/html/mai-push" "$UNIT"; then
  cp -a "$UNIT" "$UNIT.bak-domain-final-$(date +%Y%m%d-%H%M%S)"
  sed -i "s#/var/www/html/mai-push#/var/www/html/koinoyamai.love#g" "$UNIT"
  systemctl --user daemon-reload
  systemctl --user restart pi-vector.service
  say "  pi-vector.service restarted"
else
  say "  (旧パス参照なし: skip)"
fi

say "ホームの nginx ヘルパー更新"
for f in "$HOME/apply-admin-tailnet.sh" "$HOME/apply-admin-autoauth.sh" "$HOME/apply-admin-redirect.sh"; do
  [ -f "$f" ] || continue
  sed -i "s#/var/www/html/mai-push#/var/www/html/koinoyamai.love#g; s#/home/yuzuki/mai-push-test#/home/yuzuki/koinoyamai.love-test#g" "$f"
  say "  updated $f"
done
# 旧フェーズ2スクリプトは全面301版に置き換わったため退避
if [ -f "$HOME/apply-phase2-redirect.sh" ]; then
  mv "$HOME/apply-phase2-redirect.sh" "$HOME/apply-phase2-redirect.sh.superseded-20261019"
  say "  superseded: apply-phase2-redirect.sh"
fi
cat > "$HOME/apply-domain-final.sh" <<'EOF'
#!/usr/bin/env bash
# 2026-10-19 全面301 + 新パス反映（リポジトリ側スクリプトを sudo 実行）
exec sudo bash /var/www/html/koinoyamai.love/scripts/nginx/apply-domain-final.sh
EOF
chmod +x "$HOME/apply-domain-final.sh"
say "  created ~/apply-domain-final.sh"

say "pm2 起動（新パス・旧定義を削除してから再登録）"
pm2 delete mai-push-api mai-push-worker discord-bot mai-push-api-test mai-push-worker-test >/dev/null 2>&1 || true
pm2 start "$NEW_PROD/ecosystem.config.js" --only "mai-push-api,mai-push-worker,discord-bot"
if [ -d "$NEW_STG" ]; then
  pm2 start "$NEW_STG/ecosystem.config.js" --only "mai-push-api-test"
fi
pm2 save

say "検証: ポート所有者"
ss -ltnp 2>/dev/null | grep -E ':8080|:8081' || true

cat <<EOF

[migrate] 完了。
次を実行してください:
  sudo bash $NEW_PROD/scripts/nginx/apply-domain-final.sh

手動（インフラ・ホスト外設定）:
  - Google / Discord の OAuth コンソールに redirect_uri を登録:
      https://koinoyamai.love/auth/google/callback, .../auth/discord/callback
      （staging は https://test.koinoyamai.love/auth/{google,discord}/callback）
  - Cloudflare DNS に test.koinoyamai.love を追加（setup-staging-nginx.sh 参照）
  - 旧アプリ(Android1.4等)は旧ドメインの /api /auth /dl /pushweb が 301 になるため非対応
EOF
