# AGENTS §9 RAG / 埋め込み / TTS メモ

> `AGENTS.md` から分割した詳細（§番号は AGENTS.md と共通）。索引と必読ルールは リポジトリ直下の `AGENTS.md`。

## 9. 未確定メモ（2026-10-03）
- **RAG回答モデル候補: OpenRouter × Nous Hermes 3 Llama 3.1 70B**（検討中・未実装）。
  無検閲応答が目的。実装する場合は `routes/rag.js` の `chat()`（RAG_CHAT_PROVIDER 分岐）に
  OpenRouter（OpenAI互換 `https://openrouter.ai/api/v1/chat/completions`）を追加する想定。
- **本番チャットの埋め込みは稼働中（2026-10-10 確認）**: `llama-embed.service`（llama.cpp・
  OpenAI互換 `:8082`・`embeddinggemma-2`）と `pi-vector.service`（`:6333`・simpleベクトルDB）が
  systemd user で稼働し、`services/vectordb.js`（`.env` の `VECTOR_DB_BACKEND=simple` /
  `VECTOR_DB_URL=http://127.0.0.1:6333`）経由で `routes/rag.js` が検索する。
  実測 `vectordb.isEnabled=true` / `embeddings.isEnabled=true` → `/api/ask` は埋め込み・検索とも動作。
  ベクトル実体は `/var/lib/mai-push/pi-vector/vectors.jsonl`（2026-10-10 時点 10,857件・176MB）。
  ※ 旧「EMBEDDING_ENDPOINT（ollama bge-m3）停止で `/api/ask` が 503」の記述は**失効（解消済み）**。
  ※ `pi-vector-service/` は 32bit Pi 向け依存ゼロ実装を母艦へ移設したもので**削除禁止**。
    unit は `~/.config/systemd/user/pi-vector.service`（`Restart=always`・enabled）。
    `ExecStart` は Node v24.22.1（§5 のとおり全プロセス統一）。依存ゼロコードのため実害はなかったが、
    EOL 版（v20）を掴んでいたので 2026-10-21 に更新した。
  ※ 「ローカルLLM運用は不可（ユーザー指示）」は**回答生成LLMに限る**。埋め込みは上記の通り
    ローカル（llama.cpp）で稼働しており、この指示の対象外。
- **TTS速度調整**: `/api/admin/chat/speak` の `num_steps`(1〜4、body優先) / env `CHAT_TTS_NUM_STEPS`（本番・stagingとも `2` 設定済み・2026-10-03）。
  1=最速（6.3秒音声で約3秒短縮・要音質確認）、4=TTS既定。admin まいAIタブの「品質」セレクタで A/B 可。
- **TTSストリーミングは latent-slice 方式（2026-10-03 導入）**: SSE時のみ全文1回 MeanFlow → ラテンツを
  コンテキストマージン付き（ctx=6フレーム・SNR80dB）で連続スライス逐次デコード。文ごとのMeanFlow固定費
  （≈3.3秒）と再生途端の無音ギャップを除去（実測 初回音声7.9→5秒・総時間17.1→13.5秒）。
  knob: env `IRODORI_STREAM_SLICES_ENABLED=false`（旧・文単位合成へ即復帰）/ `IRODORI_STREAM_SLICE_SECONDS=2.5`
  / `IRODORI_STREAM_FIRST_SLICE_SECONDS=1.5` / `IRODORI_STREAM_SLICE_CONTEXT_FRAMES=6`。
  - **ハザード: venv パッチ必須** — `return_latent` は `.venv/.../irodori_tts/inference_runtime.py`（venv内・
    Git管理外）に直接パッチ済み。`uv sync` / `uv add` で**消えて latent ストリームは起動エラー级に fallback**
    する（app側はTypeError→ RuntimeErrorでerrorイベントに倒す防御あり）。venv再構築後は必ず再パッチすること。
- **TTSで検証済み・不採用レコード**: ①`IRODORI_COMPILE_MODEL=true`（torch.compile）＝warmup242秒・
  meanflow 3.7→74〜126秒の20倍悪化。二度と入れない。②decode static int8＝SNR9-12dBで音質棄却、
  weight-only int8＝透明だが速度+0〜2%、dynamic int8＝遅化。meanflowは既に公式int8-weight-only。
  ③ディスクリートGPUなし（iGPU UHD630）。NEOドライバ導入済み・OVでGPU認識もするが decode は
  **CPU比 -65〜-195%（全面的にCPUが勝つ）** → iGPU不採用。GPU有効化は新規購入のみ。

