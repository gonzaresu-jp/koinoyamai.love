# 移設計画: 本番リポジトリを `/var/www/html/mai-push` → `/srv/mai-push` へ

状態: **計画のみ（未実行）** — 実行は本書の承認ポイントで作業者承認後に開始する。
目的: Web公開ツリー（nginx root `/var/www/html` 配下）から本番コード・DB・.env を完全に出し、
評価指摘の「Web公開ツリー内に本番データがある」根本原因を解消する。

## 1. 現状調査結果（2026-09-24 実測）

### 1.1 パス参照インベントリ（移設時に全件修正が必要）

| 種別 | 場所 | 内容 | 修正方法 |
|---|---|---|---|
| pm2 | `ecosystem.config.js` | `cwd: '/var/www/html/mai-push'` ×3（worker/discord-bot/api） | `/srv/mai-push` へ3件 |
| pm2 | `~/.pm2/dump.pm2` | 絶対パス 11件 | pm2 再登録後 `pm2 save` で自動更新 |
| cron | root/user crontab 3本 | `0 3 * * * .../scripts/ops/backup.sh`、`*/15 .../healthcheck.sh`、`30 9 * * * .../minutes-gen-cron.sh` | `crontab -e` で3本のパスを書き換え |
| nginx | `/etc/nginx/nginx.conf` | `root`/`alias` で `/var/www/html/mai-push/{webui,admin}` が**14箇所**（96/129/134/139/168/188/480/521/539/548/555/563/666/676/687行付近） | sed 一括置換 → `nginx -t` → reload |
| script | `scripts/ops/backup.sh` | `BASE="/var/www/html/mai-push"` | `/srv/mai-push` |
| script | `scripts/ops/healthcheck.sh` | `.env` を絶対パス grep | 同上 |
| script | `scripts/ops/minutes-gen-cron.sh` | `cd /var/www/html/mai-push` | 同上 |
| script | `scripts/ops/minutes-gen.js` / `minutes-test.js` / `whisper-subs.js` | `dotenv` に絶対パス指定 | `path.join(__dirname, "..", ".env")` 等に**相寜化**（推奨・今回の main.js 事故と同じ分類） |
| script | `scripts/ops/check-native.sh` | `node /var/www/html/mai-push/scripts/ops/check-native.js` | 同上（他サイト分(DIRS)は対象外） |
| script | `scripts/tools/render-compare-html.js` | コメント中の例示パス | コメント修正のみ |
| script | `scripts/nginx/default.conf` | `root /var/www/html;`（テンプレート。本番nginxに未適用と確認） | 参考更新のみ（無くても可） |
| samba | `/etc/samba/smb.conf` | `[html] path = /var/www/html` | 新share `[mai-push] path = /srv/mai-push` を追加（`[html]` は他サイト用なので残す） |
| ドキュメント | `AGENTS.md` / `SECURITY.md` / `DEVELOPMENT-WORKFLOW.md` | 本番パスの記述 | 一括更新 |
| Windows作業 | エージェントの作業ディレクトリ | `\\192.168.1.72\html\mai-push` | `\\192.168.1.72\mai-push` に変更（新share） |

### 1.2 影響しないもの（確認済み）

- **cloudflared**: `/etc/cloudflared/config.yml` は `localhost:80` / `localhost:1700` のみ（ポート参照・パス参照なし）。
- **nginx の proxy_pass**: すべて `127.0.0.1:{8080,3001,3002}` のポート参照のみ（ファイルパスを読まない）。
- **`location ^~ /mai-push/ { deny all; }`**: URLパスでありファイルシステムパスではない。**残す**（old URL ブロック用）。
- **`scripts/deploy/deploy-staging.sh`**: `PROD="$(cd "$(dirname "$0")/.." && pwd)"` の相対解決 → 自動追従。
- **`scripts/deploy/sync-test-db.sh`**: もともと `dirname` 相対＋staging側は `/home/yuzuki/mai-push-test` 固定 → 修正不要。
- **staging (`/home/yuzuki/mai-push-test`)**: パス移設の対象外（別ツリー）。
- **backups 保存先 `/var/lib/mai-push/backups`**: 既に公開ツリー外 → 変更不要（`backup.sh` 内の `BACKUP_DIR` は据え置き）。
- **`/var/www/html/mai-push` 配下の DB/.env 特殊ファイル**: `.env`(600)・`data.db` は移動時にパーミッション引き継ぎ（`cp -a`）。

### 1.3 移設効果（現状との差分）

| | 移設前 | 移設後 |
|---|---|---|
| コード/DB/.env の配置 | `/var/www/html/mai-push`（Web公開ツリー内。nginx deny＋本番の分離で露出は封じ済みだが物理配置は公開ツリー） | `/srv/mai-push`（公開ツリー外） |
| Web公開物 | `webui/`・`admin/login.html` は nginx alias で公開 | **同じ**（nginx alias の先が変わるだけで公開範囲は不変） |
| 事故面 | staging が本番 .env を読む類の相対/絶対パス事故（main.js で発生済み） | 部分解消（本番ツリーが Web ツリーと物理分離され、誤配置・誤公開の経路が消える） |

## 2. 移設先レイアウト

```
/srv/mai-push/              ← git clone（main ブランチ、本番）
  ├ .env                    (600, yuzuki:yuzuki)
  ├ data.db                 (640 既存維持)
  ├ node_modules/           (再install or mv引き継ぎ → §3.3)
  ├ webui/                  ← nginx alias がここを指す（公開範囲は現状と同じ）
  └ admin/login.html        ← 同上
```

- 既存 `/var/www/html/mai-push` は移設後 **退避**（削除しない・`/var/www/html/mai-push.retired` 等へ rename、1週間保持後に別途判断）。
- `/home/yuzuki/mai-push-test`（staging）は変更しない。

## 3. 手順（実行は承認後・メンテナンス枠で）

> 想定ダウンタイム: **約5〜10分**（pm2 再起動＋nginx reload）。通知遅延は出るが欠落はしない
> （スクレイパーはポーリング型・キューなし。再起動中に公開された動画/ツイートは次ポーリングで拾う）。

### Phase 0: 事前準備（ダウンタイム外・いつでも可）

1. リポジトリ内パス修正を **コミット＆push**（§4 のファイル一覧。相対化するスクリプト類を含む）。
2. `mkdir /srv/mai-push`、chown `yuzuki:yuzuki`、755。
3. `rsync -a --exclude='.git' /var/www/html/mai-push/ /srv/mai-push/` … 実運用後は下の「同期」方式へ。
   - **初回はコピーベース**（`node_modules` 含め即動く状態を作る）。`data.db` はコピー時に停止不要（backup API で一貫取得するのではなく、フェーズ1のダウンタイム内で `sqlite3 .backup` する）。
4. smb.conf に share 追記 → `testparm` → `systemctl reload smb`。
   ```
   [mai-push]
   path = /srv/mai-push
   browseable = yes
   writable = yes
   valid users = yuzuki
   ```
5. Windows 側の作業接続先を `\\192.168.1.72\mai-push` に切り替え（このエージェントの cwd も同様）。
6. ドキュメント類（AGENTS/SECURITY/DEVELOPMENT-WORKFLOW）のパス記述を Phase 1 ブランチで更新。

### Phase 1: ダウンタイム作業（承認必須）

```bash
# 1. 停止（連続実行 — API とワーカーの新旧混在窓を作らない）
pm2 stop mai-push-api mai-push-worker discord-bot

# 2. 一貫した DB スナップショットを /srv 側へ
sqlite3 /var/www/html/mai-push/data.db ".timeout 8000" ".backup '/srv/mai-push/data.db'"
chmod 640 /srv/mai-push/data.db
cp -a /var/www/html/mai-push/.env /srv/mai-push/.env   # 600 引き継ぎ

# 3. 本番ツリーへ最新 main を展開（git 取得は /srv 側で）
cd /srv/mai-push && git fetch origin && git reset --hard origin/main

# 4. 依存関係（§3.3）
# 5. ecosystem の cwd 確認（Phase 0 で修正済み）
pm2 start /srv/mai-push/ecosystem.config.js --only mai-push-api,mai-push-worker,discord-bot --update-env
pm2 save

# 6. 起動確認
ss -ltnp | grep -E ':(8080|3001|3002) '
curl -s http://127.0.0.1:8080/api/health          # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/notify \
  -H 'Content-Type: application/json' -d '{}'     # 401（認証系生きている）

# 7. nginx パス差し替え → reload
sed -i 's|/var/www/html/mai-push|/srv/mai-push|g' /etc/nginx/nginx.conf
sudo nginx -t && sudo systemctl reload nginx

# 8. 公開系スモーク（外部から）
#    https://mai.honna-yuzuki.com/ … トップ200
#    /admin/login/  … 200（login.html）
#    /api/archive/stats … 200
#    YouTube/TwitCasting webhook … 外部 ping が 200 か本番ログで受信確認

# 9. 旧ツリー退避
mv /var/www/html/mai-push /var/www/html/mai-push.retired
```

### Phase 2: cron 差し替え（ダウンタイム内でも可・Phase 1 直後）

```bash
crontab -l | sed 's|/var/www/html/mai-push|/srv/mai-push|g' | crontab -
crontab -l | grep mai-push   # 3本すべて /srv になっていることを確認
```

### Phase 3: node_modules の扱い（§3.3 の詳細）

| 方式 | 手順 | リスク |
|---|---|---|
| A. mv 引き継ぎ（推奨・最速） | Phase 1 の `git reset` 前に `rsync -a /var/www/html/mai-push/node_modules/ /srv/mai-push/node_modules/` | なし（同一ホスト・同一 ABI。native リビルド不要） |
| B. クリーン install | `/srv/mai-push` で `PATH=v22` を優先に `npm ci` | ステージング未通過の依存差異が出た場合はここで初めて発覚。**AGENTS.md §5 の通り staging で先に回帰必須** |

初回は **A**、以降の更新は `/srv/mai-push` 内で `npm ci`（B 相当）を普段運用にする。

### Phase 4: 検証チェックリスト（すべて通ったら完了）

- [ ] `ss -ltnp`: 8080/3002 = `127.0.0.1`、3001 = `0.0.0.0`（webhook のみ外部向け）
- [ ] `/api/health` = 200、`/api/notify` 無認証 = 401、`/api/system-info` = 200（安全な値のみ公開）
- [ ] `pm2 list`: api/worker/discord-bot = online、↺ が増えていない（クラッシュループなし）
- [ ] ワーカーログ: Twitter/YouTube/FANBOX 各 watcher「起動」＋1ポーリング周期、error ログ空
- [ ] 外部: トップ・archive・`/admin/login/`・PWA(SW)・SSE が 200
- [ ] `ls /var/www/html/mai-push` が不存在（`.retired` のみ）、`grep -r '/var/www/html/mai-push' /etc/nginx/` が 0 件
- [ ] crontab 3本が `/srv/mai-push`、翌 03:00 の backup が `/var/lib/mai-push/backups` に成功（翌朝 `ls` 確認）
- [ ] Windows から `\\192.168.1.72\mai-push` で読め、opencode の cwd を新パスにして `node --check` 実行可
- [ ] staging(`8081`) が引き続き別ツリーで `npm test` 21/21 PASS

## 4. リポジトリ内修正ファイル一覧（Phase 0・コミット対象）

| ファイル | 変更 |
|---|---|
| `ecosystem.config.js` | cwd ×3 → `/srv/mai-push` |
| `scripts/ops/backup.sh` | `BASE` + コメント cron 例 |
| `scripts/ops/healthcheck.sh` | `.env` grep パス |
| `scripts/ops/minutes-gen-cron.sh` | `cd` パス |
| `scripts/ops/minutes-gen.js` / `minutes-test.js` / `whisper-subs.js` | dotenv を `__dirname` 相対に |
| `scripts/ops/check-native.sh` | node 実行パス |
| `scripts/tools/render-compare-html.js` | コメント例示 |
| `scripts/nginx/default.conf` | `root` 例示（参考） |
| `AGENTS.md` / `SECURITY.md` / `DEVELOPMENT-WORKFLOW.md` | 本番パス記述 |

サーバー側（リポジトリ外・手動/コマンド）: `/etc/nginx/nginx.conf`（14箇所 sed）、crontab 3本、`/etc/samba/smb.conf`（share 追加）、pm2 dump 再保存。

## 5. リスクとロールバック

| リスク | 対策 |
|---|---|
| nginx reload 後に 502/404 | `nginx -t` を reload **前**必須。失敗時は `git checkout` 相当で nginx.conf を `nginx.conf.bak-<日付>` から戻して reload |
| pm2 が旧パスを記憶して再起動失敗 | `pm2 delete mai-push-api mai-push-worker discord-bot` → 新パスで start → `pm2 save`。dump は start 後に必ず上書き |
| DB が移設元と二重に更新される | **Phase 1 は必ず「pm2 stop → copy → start」の順**。stop 前に書き込みを許さない |
| node_modules の native ABI 不一致 | 同一ホストなので発生しない（rsync 引き継ぎ時）。クリーン install 時のみ v22 PATH |
| SMB 切替で Windows 作業が止まる | `[html]` share は残すため旧パスも読める。新旧並行期間を取る |
| ロールバック | `mv /var/www/html/mai-push.retired /var/www/html/mai-push` → ecosystem の cwd を旧パスに（または旧 dump 恢復）→ pm2 start → nginx.conf を `.bak` から戻し reload → crontab を旧パスへ。**所要 5 分以内で完全復帰可能** |

## 6. 実行スケジュール案

1. **今すぐ（ダウンタイム外）**: Phase 0 — リポジトリ修正コミット、/srv 作成、smb share 追加、Windows 切替。
2. **メンテナンス枠（要承認・5〜10分）**: Phase 1〜2 — pm2 stop → 移設 → start → nginx reload → cron。
3. **翌朝**: backup cron 成功確認。
4. **1週間後**: `mai-push.retired` の削除判断（このときだけ別途承認）。

## 7. 決定が必要な点

- [ ] 実行タイミング（メンテナンス枠の日時）… 承認時に指定。
- [ ] サーバー側 nginx/crontab/smb の変更をエージェントが直接やるか、手順書渡しで人間がやるか（本計画は**両方可**なコマンドで記載。`sudo` が必要な nginx/smb は現状エージェントは password-less 不可のため人間実行 or sudoers 追加が必要）。
- [ ] `discord-bot` も同時に移すか（ecosystem に入っているので同時移設を推奨）。
- [ ] 旧 `mai-push.retired` の保持期間（案: 1週間）。
