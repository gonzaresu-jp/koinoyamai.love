# archive/nginx-apply — 退避した nginx パッチ当てスクリプト群

nginx 設定はテンプレート生成方式（`scripts/nginx/templates/` + `render.sh` / `deploy.sh`）へ
移行したため、旧来のパッチ当てスクリプトをここへ退避した。**実行しないこと。**
履歴として残すもので、現在の設定はテンプレートが正本。

## 退避したものと、テンプレート側の対応

| 退避ファイル | 変更内容の取り込み先 |
|---|---|
| `apply-display-location.js/.sh` + `display-location.conf` | `templates/nginx.conf.tmpl`（1717 vhost の `/display/`） |
| `apply-dmedia-tunnel-only.js/.sh` | `templates/discord.conf.tmpl`（tunnel 限定の allow/deny） |
| `apply-domain-final.sh` | `templates/nginx.conf.tmpl` / `mai-test.conf.tmpl`（ドメイン確定後の状態） |
| `apply-honeypot.js/.sh` | `templates/nginx.conf.tmpl`（ハニー location 群・`honeyfmt`）。パターンの正本 `scripts/nginx/honey-path-pattern.txt` は監視（honeypot-watch.js）と共有のため現役のまま残置 |
| `apply-mai-chat-elza.js/.sh` + `mai-chat-elza.conf` | `templates/nginx.conf.tmpl`（elza vhost の chat location） |
| `apply-php-exec-guard.js/.sh` | `templates/nginx.conf.tmpl`（elza vhost の PHP 404 化） |
| `apply-security-headers.py` | 全 vhost への include 済み状態が各テンプレートに取り込み済み。スニペット本体は `templates/snippets/mai-security-headers.conf.tmpl` |
| `setup-staging-nginx.sh` | staging vhost は `templates/mai-test.conf.tmpl` が正本（旧スクリプトの sites-available 経由は現行構成と不一致だった） |
| `default.conf` | 旧 default server の参考ファイル。本番 `nginx.conf` は sites-enabled を include しておらず実効でなかった |
| `mai-test.conf` / `mai-security-headers.conf` / `maintenance.conf`（scripts/nginx 直下の複製） | 正本は `scripts/nginx/templates/` 配下へ移行 |

## 退避しなかったもの（現役）

- `scripts/nginx/apply-maintenance.js/.sh` — メンテナンス ON/OFF は**実行時の状態切替**であり、
  テンプレート（OFF 状態が正本）では代替できない。`scripts/php/patch-and-resume.sh` からも
  呼ばれている。スニペット等の参照先はテンプレートへ付け替え済み。
  なお `deploy.sh` はメンテナンス ON の間は配置を中止する（無言解除の防止）。
- `scripts/nginx/honey-path-pattern.txt` — honeypot-watch.js が実行時に読む共有パターン。

## 注意

- `scripts/deploy/migrate-domain-final.sh`（実施済みの一回限り移行スクリプト）は
  ここの `apply-domain-final.sh` を旧パスで参照している。再実行は想定していない。
