#!/usr/bin/env bash
# honeypot-setup.sh — 「盗まれたら教えてくれる」偽物（ハニーポット）を作る
#
# 目的（2026-10-22 実測に基づく）:
#   - 公開ptusには**既に秘密ファイル探索が来ている**（アクセスログ 217 件）。
#     `/.env` `/.git/config` `/id_rsa` `/database.sqlite` `/backup.zip` など。
#   - 現状は「見つからない」だけなので**証拠が残らない**。
#     そこで **本物そっくりの偽物**を置いて、**取得されたら即座に検知**する。
#
# 特に `.env` の**変種**（`.env.bak` `.env.docker` `/workspace/.env` …）も偽物として
# 用意する。実測でスキャナが `.env.sendgrid` `.env_secret` `.env.ses` `.env.docker`
# `.env.key` `.env.live` `.env.www` `.env.stage` `/workspace/.env` `/var/.env`
# `/utils/.env` `/web/.env` を叩いていた（すべて 404）。偽物を置いておくと、
# 「探している」ではなく **「実際に偽物を取得した」** として記録に残せる。
#
# 安全性（最重要）:
#   - 中身は**すべて偽物**。実物の秘密値は一切含まない。
#   - 実物の `.env`（/var/www/html/koinoyamai.love/.env）は**一切触らない**
#     （mode 600・webroot 外・nginx の deny 対象）。
#   - 置き場は **webroot の外**（/var/lib/mai-push/honeypot）。git 管理外。
#   - 偽物には追跡用 URL（canary）を埋め込む。**canary にアクセスされたら
#     「盗った情報を使った」= 窃取確定**として通知される。
#
# 使い方:
#   bash scripts/security/honeypot-setup.sh            # 作成（既存 token は維持）
#   bash scripts/security/honeypot-setup.sh --rotate   # token を再生成して作り直す
#
# 生成物:
#   /var/lib/mai-push/honeypot/     偽物（nginx がここから配信する）
#   data/honeypot-canary.json      token / canary パス等の状態（gitignore 済み）
#                                   ※ watcher の読み取り位置は別のファイル
#                                     （data/honeypot-watch-state.json）に持つ。
#                                     同じファイルにすると setup の再実行で
#                                     読み取り位置が消え、過去イベントが全件再通知される。
set -euo pipefail

HONEY_DIR="${HONEY_DIR:-/var/lib/mai-push/honeypot}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_FILE="${STATE_FILE:-$REPO_ROOT/data/honeypot-canary.json}"
PUBLIC_URL="${PUBLIC_URL:-https://koinoyamai.love}"
ROTATE=0
[[ "${1:-}" == "--rotate" ]] && ROTATE=1

# --- `.env` の変種（スキャナが実際に叩いてきたもの + 一般的な wordlist）---
ENV_VARIANTS=(
  bak backup old orig save copy tmp swp
  local prod production develop development dev stage staging test testing
  live www web api app server mail smtp ses sendgrid mailgun slack discord
  telegram github gitlab bitbucket jenkins travis circleci
  aws gcp azure k8s kubernetes docker compose supervisor systemd pm2
  node python django flask laravel symfony wordpress wp joomla drupal
  magento shopify stripe twilio database db s3 storage secrets credential
  credentials vault nomad terraform ansible vagrant dotenv envrc
  key secret default template sample dist example ci nginx apache php
  config conf ini yml yaml json lock
)

# --- ディレクトリ前缀つきの変種（実測で叩かれたもの + 常见の置き場所）---
ENV_PREFIX_DIRS=(
  workspace var utils web app api server www home root opt srv
  deploy build config secrets tmp data admin public static assets
  html htdocs current release releases prod production staging dev test
  local node_modules vendor src lib dist public_html wwwroot htdocs
)

echo "=== ハニーポットの偽物を作る ==="

# --- token の決定（既存があれば維持。--rotate で再生成）---
TOKEN=""
if [ "$ROTATE" -eq 0 ] && [ -f "$STATE_FILE" ]; then
  TOKEN="$(python3 -c "
import json,sys
try:
    print(json.load(open(sys.argv[1])).get('token',''))
except Exception:
    print('')
" "$STATE_FILE" 2>/dev/null || true)"
fi
if [ -z "$TOKEN" ]; then
  TOKEN="$(openssl rand -hex 8)"
  echo "  新しい canary token を生成: $TOKEN"
else
  echo "  既存の canary token を維持: $TOKEN"
fi

CANARY_PATH="/_canary/$TOKEN"
CANARY_URL="$PUBLIC_URL$CANARY_PATH"

# --- 置き場 ---
mkdir -p "$HONEY_DIR/.git" "$HONEY_DIR/.aws" "$HONEY_DIR/.ssh"
chmod 755 "$HONEY_DIR" "$HONEY_DIR/.git" "$HONEY_DIR/.aws" "$HONEY_DIR/.ssh"

# --- 1. .env（本物そっくりの偽物）---
cat > "$HONEY_DIR/.env" <<EOF
#  application's environment (production)
NODE_ENV=production
PORT=8080
TZ=Asia/Tokyo
DATABASE_PATH=/srv/app/prod.sqlite3

# --- notification / auth ---
NOTIFY_API_TOKEN=honey-canary-$TOKEN
NOTIFY_HMAC_SECRET=honey-canary-$TOKEN-9f2c1d7e4b8a
INTERNAL_API_TOKEN=honey-canary-$TOKEN-3c6e5a09b1f7
JWT_SECRET=honey-canary-$TOKEN-77d4e0b9c2a5
SESSION_SECRET=honey-canary-$TOKEN-51e8c3a6d0b4

# --- integrations ---
DISCORD_BOT_TOKEN=honey-canary-$TOKEN.bx9k2m.Q7tLp3vNwZc8
DISCORD_CHANNEL_ID=1000000000000000000
YOUTUBE_API_KEY=AIzaSyHONEY-$TOKEN-0k1m9q7x3w
YOUTUBE_CHANNEL_ID=UC_honey$TOKEN
TWITCASTING_CLIENT_ID=honey$TOKEN
TWITCASTING_CLIENT_SECRET=honey-canary-$TOKEN-6d2f8a4c1e9b

# --- maintenance / backup (追跡用) ---
MAINTENANCE_URL=$CANARY_URL/maintenance
BACKUP_URL=$CANARY_URL/backup
STATUS_WEBHOOK=$CANARY_URL/webhook
EOF
chmod 644 "$HONEY_DIR/.env"

# --- 1b. `.env` の変種（=.env のバックアップ複製）---
# 同じ中身のコピーを「.env のバックアップ」として並べる。
# スキャナが `/.env.docker` 等を叩いたときに **偽物を返す**＝「取得」の証拠になる。
VARIANT_COUNT=0
for v in "${ENV_VARIANTS[@]}"; do
  cp -f "$HONEY_DIR/.env" "$HONEY_DIR/.env.$v"
  chmod 644 "$HONEY_DIR/.env.$v"
  VARIANT_COUNT=$((VARIANT_COUNT + 1))
done
# --- 1b-2. `.env_xxx`（アンダースコア区切り）---
# スキャナが実際に叩いた `.env_secret` 形式。ドット版と同じ数だけ作る。
ENV_VARIANTS_UNDERSCORE=(secret sendgrid ses docker key live www stage prod production local dev test ci)
for v in "${ENV_VARIANTS_UNDERSCORE[@]}"; do
  cp -f "$HONEY_DIR/.env" "$HONEY_DIR/.env_$v"
  chmod 644 "$HONEY_DIR/.env_$v"
  VARIANT_COUNT=$((VARIANT_COUNT + 1))
done

# --- 1c. ディレクトリ前缀つきの `.env` ---
for d in "${ENV_PREFIX_DIRS[@]}"; do
  mkdir -p "$HONEY_DIR/$d"
  chmod 755 "$HONEY_DIR/$d"
  cp -f "$HONEY_DIR/.env" "$HONEY_DIR/$d/.env"
  chmod 644 "$HONEY_DIR/$d/.env"
  VARIANT_COUNT=$((VARIANT_COUNT + 1))
done
echo "  .env の変種を ${VARIANT_COUNT} 個生成しました"

# --- 2. .git/config（追跡 URL を remote に埋め込む）---
cat > "$HONEY_DIR/.git/config" <<EOF
[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
	logallrefupdates = true
[remote "origin"]
	url = $CANARY_URL/repo.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
	remote = origin
	merge = refs/heads/main
[user]
	name = mai
	email = honey-canary-$TOKEN@example.invalid
EOF
chmod 644 "$HONEY_DIR/.git/config"

# --- 3. id_rsa（偽の秘密鍵。形式は正しく、中身は使い物にならない）---
openssl genrsa -out "$HONEY_DIR/id_rsa" 2048 2>/dev/null
# 生成直後の鍵に追跡目印をコメントとして追記（鍵自体は有効な形式のまま）
printf '# honey-canary-%s\n' "$TOKEN" >> "$HONEY_DIR/id_rsa"
chmod 644 "$HONEY_DIR/id_rsa"
# 公開鍵は秘密鍵のコピーではなく、正经な公開鍵にする
openssl rsa -in "$HONEY_DIR/id_rsa" -pubout > "$HONEY_DIR/id_rsa.pub" 2>/dev/null
cp "$HONEY_DIR/id_rsa" "$HONEY_DIR/.ssh/id_rsa"
chmod 644 "$HONEY_DIR/.ssh/id_rsa" "$HONEY_DIR/id_rsa.pub"

# --- 4. credentials.json / .aws/credentials ---
cat > "$HONEY_DIR/credentials.json" <<EOF
{
  "service": "mai-push",
  "environment": "production",
  "note": "rotated 2026-10-01",
  "discord": {
    "token": "honey-canary-$TOKEN.bx9k2m.Q7tLp3vNwZc8",
    "webhook": "$CANARY_URL/webhook"
  },
  "database": {
    "url": "sqlite:///srv/app/prod.sqlite3"
  },
  "maintenance_url": "$CANARY_URL/maintenance"
}
EOF
chmod 644 "$HONEY_DIR/credentials.json"

cat > "$HONEY_DIR/.aws/credentials" <<EOF
[default]
aws_access_key_id = AKIAHONEY$TOKEN
aws_secret_access_key = honey-canary-$TOKEN-2f8c1a7d4e9b
EOF
chmod 644 "$HONEY_DIR/.aws/credentials"

# --- 5. config.php（PHP の典型的な設定ファイル）---
cat > "$HONEY_DIR/config.php" <<EOF
<?php
//  application's configuration
define('DB_HOST', 'db.internal');
define('DB_NAME', 'mai_push');
define('DB_USER', 'mai');
define('DB_PASS', 'honey-canary-$TOKEN-8d1c5a2f6b3e');
define('DISCORD_WEBHOOK', '$CANARY_URL/webhook');
define('MAINTENANCE_URL', '$CANARY_URL/maintenance');
EOF
chmod 644 "$HONEY_DIR/config.php"

# --- 6. database.sqlite（実在する SQLite。開いて中身を読まれる）---
DB_FILE="$HONEY_DIR/database.sqlite"
rm -f "$DB_FILE"
sqlite3 "$DB_FILE" <<EOF
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  key_value TEXT NOT NULL,
  last_used TEXT
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT INTO users (email, password_hash, role) VALUES
  ('mai@example.invalid', 'honey-canary-$TOKEN-2b7f1c9e4a3d', 'admin'),
  ('ops@example.invalid', 'honey-canary-$TOKEN-5a1e8b3d6c0f', 'user');
INSERT INTO api_keys (label, key_value) VALUES
  ('notify', 'honey-canary-$TOKEN'),
  ('internal', 'honey-canary-$TOKEN-3c6e5a09b1f7');
INSERT INTO settings (key, value) VALUES
  ('maintenance_url', '$CANARY_URL/maintenance'),
  ('backup_url', '$CANARY_URL/backup'),
  ('discord_webhook', '$CANARY_URL/webhook');
EOF
chmod 644 "$DB_FILE"

# --- 7. backup.zip（実在する zip。中に .env 入り）---
rm -f "$HONEY_DIR/backup.zip"
TMPZ="$(mktemp -d)"
cp "$HONEY_DIR/.env" "$TMPZ/.env"
cp "$HONEY_DIR/config.php" "$TMPZ/config.php"
( cd "$TMPZ" && zip -q "$HONEY_DIR/backup.zip" .env config.php )
rm -rf "$TMPZ"
chmod 644 "$HONEY_DIR/backup.zip"

# --- 8. secret.txt / dump.sql（よく狙われる名前）---
cat > "$HONEY_DIR/secret.txt" <<EOF
honey-canary-$TOKEN
maintenance: $CANARY_URL/maintenance
EOF
chmod 644 "$HONEY_DIR/secret.txt"

cat > "$HONEY_DIR/dump.sql" <<EOF
-- honey-canary-$TOKEN
INSERT INTO users (email) VALUES ('mai@example.invalid');
-- $CANARY_URL/backup
EOF
chmod 644 "$HONEY_DIR/dump.sql"

# --- 状態ファイル ---
mkdir -p "$(dirname "$STATE_FILE")"
python3 - "$STATE_FILE" "$TOKEN" "$CANARY_PATH" "$CANARY_URL" "$HONEY_DIR" <<'PY'
import json, sys, os, time
state_path, token, canary_path, canary_url, honey_dir = sys.argv[1:6]
files = []
for root, dirs, names in os.walk(honey_dir):
    for n in sorted(names):
        p = os.path.join(root, n)
        files.append(os.path.relpath(p, honey_dir))
# 既存の canary は「旧 canary」として残す（--rotate 後でも旧 canary の使用を検知する）
prev = []
if os.path.exists(state_path):
    try:
        old = json.load(open(state_path, encoding="utf-8"))
        for p in [old.get("canaryPath")] + (old.get("previousCanaryPaths") or []):
            if p and p != canary_path and p not in prev:
                prev.append(p)
    except Exception:
        pass
state = {
    "token": token,
    "canaryPath": canary_path,
    "canaryUrl": canary_url,
    "previousCanaryPaths": prev[-10:],   # 直近 10 個まで
    "dir": honey_dir,
    "files": sorted(files),
    "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
}
with open(state_path, "w", encoding="utf-8") as f:
    json.dump(state, f, ensure_ascii=False, indent=2)
print("  状態ファイル:", state_path)
if prev:
    print("  旧 canary（監視継続）:", ", ".join(prev[-10:]))
PY
chmod 600 "$STATE_FILE"

echo
echo "--- 生成物（抜粋）---"
find "$HONEY_DIR" -type f | sort | head -20 | sed 's/^/  /'
echo "  ...（合計 $(find "$HONEY_DIR" -type f | wc -l) ファイル）"
echo
echo "--- canary ---"
echo "  URL: $CANARY_URL"
echo "  ※ この URL にアクセスされたら「窃取後の使用」として通知されます"
echo
echo "=== 完了 ==="
echo "次: sudo bash scripts/nginx/apply-honeypot.sh --apply   # nginx にハニー location を入れる（初回のみ）"
echo "     bash scripts/security/honeypot-watch.js             # 監視を手動実行（通知テスト）"
echo "     ※ 変種の追加は nginx の再適用は不要（配信元ディレクトリ_content が変わるだけ）"
