# nginx テンプレート（フェーズ1）

本番 nginx 設定の正本を、パッチ当て方式（`apply-*`）から
「テンプレートから一式を生成する」宣言的運用へ移行するための取り込み。
フェーズ1では**生成と検証だけ**を行い、本番（`/etc/nginx`）は変更しない。
配置（バックアップ・reload・自動復旧付き）はフェーズ2で別 PR とする。

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
| `templates/discord.conf.tmpl` | `/etc/nginx/discord.conf` | 同上（リポジトリの `default.conf` は別物で旧状態） |
| `templates/snippets/mai-security-headers.conf.tmpl` | `/etc/nginx/snippets/mai-security-headers.conf` | |
| `templates/snippets/maintenance.conf.tmpl` | `/etc/nginx/snippets/maintenance.conf` | 現在はメンテナンス OFF のため本番に未配置。正本はリポジトリ既存の `scripts/nginx/maintenance.conf` で、生成結果はそれと一致する |

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
  リポジトリの `scripts/nginx/default.conf` とも内容がずれている（ドリフト）点は
  フェーズ1の対象外として記録する。
