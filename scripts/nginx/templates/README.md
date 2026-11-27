# nginx テンプレート

本番 nginx 設定の正本。パッチ当て方式（`apply-*`）から
「テンプレートから一式を生成する」宣言的運用へ移行した（フェーズ1: 取り込み、フェーズ2: 配置）。
旧 `apply-*` は `scripts/archive/nginx-apply/` へ退避済み。

## 生成

```bash
# .env はリポジトリ直下が既定。場所が違う場合は ENV_FILE で指定する
ENV_FILE=/path/to/.env bash scripts/nginx/render.sh /tmp/nginx-render-out
```

- 出力先は一時ディレクトリ等の任意の場所。`/etc/nginx` へは書かない。
- `TAILNET_ADMIN_SECRET` が `.env` に未設定・空なら失敗して止まる（fail-closed）。

## テンプレートと生成先（＝本番パス）の対応

| テンプレート | 生成先（本番） | 備考 |
|---|---|---|
| `templates/nginx.conf.tmpl` | `/etc/nginx/nginx.conf` | プレースホルダを含むのはこのファイルだけ |
| `templates/mai-test.conf.tmpl` | `/etc/nginx/mai-test.conf` | 本番とリポジトリ既存ファイルが同一だったもの |
| `templates/media.conf.tmpl` | `/etc/nginx/media.conf` | 従来リポジトリに正本が無く本番から新規取り込み |
| `templates/discord.conf.tmpl` | `/etc/nginx/discord.conf` | 同上（旧 `default.conf` は退避済み） |
| `templates/snippets/mai-security-headers.conf.tmpl` | `/etc/nginx/snippets/mai-security-headers.conf` | |
| `templates/snippets/maintenance.conf.tmpl` | `/etc/nginx/snippets/maintenance.conf` | 現在はメンテナンス OFF のため本番に未配置。`deploy.sh` は配置しない（配置は `apply-maintenance.sh --on` の役割） |

## プレースホルダ

| 名前 | 出現数 | 差し込み元 |
|---|---|---|
| `${TAILNET_ADMIN_SECRET}` | nginx.conf 内 4 か所（`geo $tailnet_admin` の各エントリ） | `.env` の同名キー（必須・fail-closed）。**値はコミットしない** |
| `${TAILNET_HOSTNAME}` | nginx.conf 内 7 か所（server_name / Certbot 証明書パス / admin 302 の転送先） | 環境変数（既定 `elza.poitou-mora.ts.net`） |

対象をこの2つに絞った理由:

- 公開ドメインやポートはこのサービスの同一性そのもので、環境ごとに変わる値ではない。
  nginx は本番/staging で同一インスタンス（`mai-test.conf` が staging 用 vhost）ため、
  「環境差分」として実在するのは tailnet ホスト名と秘密値だけだった。
- `envsubst` の置換対象を2変数に限定することで、nginx 自身の変数
  （`$host`、`$request_uri` 等）を誤って置換する事故を防ぐ。

## 対象外（テンプレートに含めないもの）

- OS 既定ファイル: `mime.types`、`fastcgi_params`、`proxy_params`、`snippets/fastcgi-php.conf`、
  `snippets/snakeoil.conf`、`sites-available/default` の原型など
- Certbot 管理ファイル: `/etc/letsencrypt/options-ssl-nginx.conf`、証明書・鍵、dhparam
- 認証情報ファイル: `/etc/nginx/.htpasswd`（クレデンシャルそのもの）
- `*.bak-*` 等のバックアップファイル群
- `sites-enabled/default`: 本番 `nginx.conf` は `sites-enabled` を include していない
  （`grep sites-enabled /etc/nginx/nginx.conf` で確認済み）ため、実効設定ではない。
  旧 `scripts/nginx/default.conf` は `scripts/archive/nginx-apply/` へ退避した。

## 配置（フェーズ2）

```bash
bash scripts/nginx/deploy.sh             # dry-run: render + 本番との diff + サンドボックス nginx -t。本番は無変更
sudo bash scripts/nginx/deploy.sh --apply  # 配置（本番ツリーで実行する想定）
```

- `--apply` の流れ: render → メンテナンス ON 検出（ON なら中止）→ サンドボックスで
  `nginx -t` → 現行ファイルを `*.bak-template-<日時>` へバックアップ → 配置 →
  本番 `nginx -t` → `systemctl reload nginx`。失敗したらバックアップへ自動で戻す。
- 配置対象は生成物のうち本番で有効な5ファイル（`nginx.conf` / `mai-test.conf` /
  `media.conf` / `discord.conf` / `snippets/mai-security-headers.conf`）。
  `snippets/maintenance.conf` は配置しない（OFF 状態では本番に無いのが正で、
  配置は `apply-maintenance.sh --on` の役割）。
- メンテナンス ON の間は配置できない: 生成結果は OFF 状態なので、ON のまま配置すると
  メンテナンスが無言で解除されてしまう。先に `apply-maintenance.sh --off` で解除する。

## 現役で残る旧来スクリプト（例外）

- `scripts/nginx/apply-maintenance.js/.sh` — メンテナンス ON/OFF は実行時の状態切替であり
  テンプレートでは代替できない（`scripts/php/patch-and-resume.sh` からも呼ばれる）。
  参照するスニペット類はテンプレートを正本として付け替え済み。
- `scripts/nginx/honey-path-pattern.txt` — `honeypot-watch.js` が実行時に読む共有パターン。
  パターンを変えるときは `templates/nginx.conf.tmpl` のハニー location も合わせて変える
  （回帰テスト [11] が一致を検査する）。
