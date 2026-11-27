# エージェント用ガード（層 1 の詳細）

AI エージェントが実行しようとするシェルコマンドを、実行前に検査して
「止める（deny）/ ユーザーに確認する（ask）/ 通す（allow）」を判定する仕組み。
AGENTS.md §13 の「ルールを仕組みで守る 3 層」の **層 1** の詳細をここに置く。

判定の核はツール非依存にし、ツールごとの違いは薄いアダプタで吸収する。
ルールは 1 か所（`scripts/guard/guard-rules.txt`）で管理し、どのツールからでも同じ判定になる。

```
エージェントのコマンド
  → 各ツールの hook がアダプタを呼ぶ（scripts/guard/adapters/）
  → アダプタがコマンド文字列を取り出して核に渡す（scripts/guard/guard-check.sh）
  → 核が guard-rules.txt と照合して allow / deny / ask を返す
```

## 核（guard-check.sh）

```bash
bash scripts/guard/guard-check.sh 'git push --no-verify origin agent/x'   # → 終了コード 2（deny）
printf '%s' 'git status' | bash scripts/guard/guard-check.sh              # → 終了コード 0（allow）
```

| 終了コード | 意味 | 標準出力 |
|---|---|---|
| 0 | allow | 空 |
| 2 | deny（判定できない場合もこちら。fail-closed） | 理由 |
| 3 | ask（ユーザーに確認してから実行） | 理由 |

- ルールファイルは既定で核と同じディレクトリの `guard-rules.txt`。環境変数 `GUARD_RULES` で差し替えできる。
  ファイル自体が無い場合は止める（fail-closed）が、ファイルがあって空（コメントのみ）の場合は
  「ルール無し」として通す。
- 照合はコマンド全文に対して行う。行末 `\` の継続行はつないでから照合する
  （つながないと `git push \`⏎`origin main` がすり抜ける）。

## ルールの書き方（guard-rules.txt）

1 行 1 ルール：

```
deny|理由（エージェントに返る。| は書かない）|ERE 正規表現（行末まで。中で | を使ってよい）
ask|理由|ERE 正規表現
# コメント
```

- 照合対象は「エージェントが書いたコマンド全文」。コマンド名の後ろには空白だけでなく
  `;` `&` `|` `)` や引用符も来るので、終端は `([[:space:];&|)'"]|$)` のように書く。
- ルールを足したら `scripts/ci/test-guard.sh` にも例を足して動作を確かめる。
- 限界：正規表現による照合なので、変数経由・URL エンコード・別名コマンド等は止めきれない。
  止めきれない前提で、層 2（pre-push）・層 3（CI）・ブランチ保護と組み合わせる。

## アダプタの対応状況

| ツール | 設定ファイル | イベント | 入力のコマンドの場所 | ask の扱い | 備考 |
|---|---|---|---|---|---|
| Claude Code | `.claude/settings.json` | PreToolUse（matcher: Bash） | `tool_input.command` | そのまま ask を返す | `permissions.deny` の宣言も併記（多層化） |
| Codex CLI | `.codex/hooks.json` | PreToolUse（matcher: Bash） | `tool_input.command` | **deny に倒す**（hook の permissionDecision は allow / deny のみ） | プロジェクトの hook は `/hooks` でレビュー・信頼しないと実行されない |
| Cursor | `.cursor/hooks.json` | beforeShellExecution | トップレベルの `command` | そのまま ask を返す | `failClosed: true` を設定（フック異常時も止める）。信頼済みワークスペースでのみ動く |
| Gemini CLI | `.gemini/settings.json` | BeforeTool（matcher: run_shell_command） | `tool_input.command` | **deny に倒す**（decision は allow / deny のみ） | 標準出力は JSON のみ（余計な文字を出すと解析に失敗する） |
| opencode | `.opencode/plugins/agent-guard.js`（プラグイン） | tool.execute.before（bash ツール） | `output.args.command` | **deny に倒す**（プラグインが止める手段は throw のみで、確認を求める口が無い） | フックではなくプラグイン方式（V1 プラグイン API）。核は子プロセスで呼ぶ。`permission.ask` フックは不安定な既知の問題があるため使わない |
| Antigravity CLI | `.agents/hooks.json` | PreToolUse（matcher: run_command） | `toolCall.args.CommandLine` | **force_ask に変換**（後述） | 標準出力は JSON のみ。App / IDE でも同じ hooks.json 形式を使う |

各ツールの hook 仕様は公式ドキュメントで確認した（2026-11-27 時点）：

- Claude Code: <https://code.claude.com/docs/en/hooks>
- Codex CLI: <https://developers.openai.com/codex/hooks>
- Cursor: <https://cursor.com/docs/hooks>
- Gemini CLI: <https://geminicli.com/docs/hooks/reference/>
- opencode: <https://opencode.ai/docs/plugins/>（配置と自動読み込み）、
  <https://opencode.ai/docs/build/plugins/migrate-v1>（V1 の `tool.execute.before` の形と throw での停止）
- Antigravity: <https://antigravity.google/docs/hooks>（CLI タブ。hooks.json の形式と PreToolUse の入出力）

ask を deny に倒すツールでは、deny の理由に「本来は ask だが、このツールは hook からの
確認に対応していないため止めた」と書く。エージェントは回避せず、理由を添えてユーザーに
判断を仰ぐ（AGENTS.md §13）。人間がターミナルで直接実行すれば済む操作がほとんどである。

Antigravity CLI は decision に ask と force_ask の両方を持つ。素の ask は「Always Allow」の
設定を尊重するため、一度許可すると次回から素通りしうる。force_ask は保存済みの許可を
無視して毎回確認する。ガードの ask は「毎回ユーザーが判断する」操作（PR のマージ、強制 push 等）
のためのものなので、アダプタは ask を force_ask に変換する。

対応していないツール（hook の仕様が無い / 確認できていないツール）では層 1 は効かない。
その場合も層 2・3 は効くので、重要な禁止事項はルールだけでなく pre-push と CI でも止める。

## 有効化

- Claude Code / Cursor / Gemini CLI：設定ファイルがリポジトリに入っていれば、プロジェクトを
  開いたときに読み込まれる（ツール側でプロジェクトの信頼を求められたら内容を確認して許可する）。
- Codex CLI：プロジェクトの `.codex` レイヤーを信頼し、`/hooks` で hook をレビュー・信頼する。
- opencode：プラグインファイル（`.opencode/plugins/agent-guard.js`）が入っていれば起動時に
  自動で読み込まれる。プラグインは worktree のルートを基準に核のパスを解決する
  （サブディレクトリから起動してもプラグインは読み込まれるため、作業ディレクトリ基準では核を見失う）。
- Antigravity CLI：ワークスペース直下の `.agents/hooks.json` が読み込まれる
  （`/hooks` で読み込み状況を確認できる）。
- どのツールでも、アダプタと核は bash スクリプトなので実行権限が要る（git に実行ビット付きで記録する。新しく足すときは `git update-index --chmod=+x` で付ける）。
  特に Cursor / Gemini CLI / Antigravity CLI はアダプタのパスを直接実行するので、実行ビットが無いと動かない。

## 限界と下層の砦

フックは層 1 にすぎない。次を前提に運用する：

- 対応ツール以外のエージェント、人間のターミナル、別経路の実行は止まらない。
- 正規表現の照合は迂回されうる（変数経由、エンコード、ラッパースクリプト等）。
- hook 自体をエージェントが書き換えれば無力化できる。だから hook とルールの変更は
  感度の高い変更として PR と独立レビューを通す（AGENTS.md §13）。

下層の砦（ツール不問で効く）：

- 層 2：`scripts/hooks/pre-push` — 保護ブランチへの push と、送信コミット中の秘密値を止める。
- 層 3：CI（`.github/workflows/ci.yml`）— フックを入れ忘れたクローンでも最後に止まる。
  秘密値の検出（`scripts/ci/secret-scan.sh`）とガードの判定テスト（`scripts/ci/test-guard.sh`）を
  それぞれ独立したステップで実行する。
- GitHub のブランチ保護 / ruleset — PR 必須・force push 禁止をサーバー側で強制する
  （`docs/DEVELOPMENT-WORKFLOW.md` 参照）。
