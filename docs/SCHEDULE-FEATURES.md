# ツイート内容解析＆スケジュール自動管理 - 高度な機能

## 実装した機能

### 1. ツイート内URL自動抽出

```javascript
// ツイートテキスト内のすべてのURLを自動抽出
const urls = extractUrlsFromTweet(tweetText);

// 例:
// 入力: "配信します: https://youtube.com/watch?v=xxx とにかく楽しい https://twitter.com/xxx"
// 出力: ["https://youtube.com/watch?v=xxx", "https://twitter.com/xxx"]
```

**優先度順:** YouTube > その他 → 最優先URLをスケジュールに設定

---

### 2. 重複スケジュール自動検出

**判定ロジック：**
- **時間範囲:** ±1時間以内
- **内容判定:** "配信" "ライブ" "生放送" キーワード含有

```
例：
- 既存: [21:00 配信予定]
- 新規: [22:00 配信変わりました]
→ 1時間以内 + キーワード "配信" 含有 = 重複と判定 → 更新
```

---

### 3. スケジュール自動上書き/更新

#### パターンA: 新規作成（重複なし）
```
新しいツイート
    ↓
重複なし
    ↓
✅ 新規スケジュール作成
```

#### パターンB: 上書き更新（重複あり）
```
新しいツイート（時間変更）
    ↓
既存スケジュール検出
    ↓
✏️ 時刻・内容を更新
```

**ログ例:**
```
[koinoya_mai] Found duplicate: id=42, updating...
[koinoya_mai] ✏️ schedule updated (id: 42) - 🔴 配信 at 2026-04-06T20:00:00.000Z
```

---

## API エンドポイント

### 1. 重複スケジュール検索

```
GET /api/internal/schedule/find-duplicate
X-Notify-Token: {ADMIN_NOTIFY_TOKEN}

Query Parameters:
  - user_id: 1
  - scheduled_at: 2026-04-06T22:00:00Z
  - title: 🔴 配信

Response:
{
  "found": true,
  "duplicates": [
    {
      "id": 42,
      "title": "🔴 配信",
      "scheduled_at": "2026-04-06T22:00:00Z",
      "source": "ai"
    }
  ],
  "near": 2
}
```

### 2. スケジュール更新

```
PUT /api/internal/schedule/update
X-Notify-Token: {ADMIN_NOTIFY_TOKEN}
Content-Type: application/json

{
  "schedule_id": 42,
  "title": "🔴 配信",
  "scheduled_at": "2026-04-06T20:00:00Z",
  "note": "[Gemma再分析] 時刻更新",
  "url": "https://youtube.com/watch?v=xxx",
  "reminder_minutes": 30
}

Response:
{
  "success": true,
  "updated": true
}
```

---

## 実装詳細

### src/scrapers/gemma-analyzer.js の改善

```javascript
// 新関数: URL抽出
function extractUrlsFromTweet(text)
  → 使用例: extractUrlsFromTweet(tweet.text)
  → 返戻: ["https://youtube.com/...", "https://twitter.com/..."]

// 改善: extractScheduleFromAnalysis に urls パラメータ追加
function extractScheduleFromAnalysis(analysis, tweetDate, urls = [])
  → スケジュール情報に urls を含める
  → YouTube URL を優先的に url フィールドに設定
```

### src/scrapers/twitter.js の改善

```javascript
// 新関数: 重複検索
async function findDuplicateSchedule(username, scheduleInfo)
  → /api/internal/schedule/find-duplicate を呼び出し
  → 重複スケジュール情報を返す

// 新関数: スケジュール更新
async function updateSchedule(username, scheduleId, scheduleInfo, urls)
  → /api/internal/schedule/update を呼び出し
  → 既存スケジュールを更新

// 改善: createScheduleFromTweet
async function createScheduleFromTweet(username, tweet, analysis)
  1. URL抽出: extractUrlsFromTweet(tweet.text)
  2. スケジュール抽出: extractScheduleFromAnalysis(analysis, new Date(), urls)
  3. 重複検索: findDuplicateSchedule()
  4. 分岐:
     - 重複あり → updateSchedule() で更新
     - 重複なし → 新規作成
```

### src/core/user-routes.js の新API

```javascript
// GET /api/internal/schedule/find-duplicate
  → 時間範囲 ± 1時間内のスケジュール検索
  → キーワード判定で関連性チェック
  → 重複候補をまとめて返す

// PUT /api/internal/schedule/update
  → 既存スケジュールを部分更新
  → source は変更せず（元の source を保持）
  → updated_at を自動更新
```

---

## 処理フロー図

```
【新しいツイート投稿】
       ↓
【Twitter監視】
       ↓
【新規ツイート検出】
       ↓
【Gemma4分析】 → category, status, start_time, etc
       ↓
【URL抽出】 → [youtube.com/xxx, twitter.com/yyy]
       ↓
【スケジュール情報生成】
  {
    title: "🔴 配信",
    scheduled_at: "2026-04-06T22:00:00Z",
    url: "https://youtube.com/xxx" ← 優先度順
    urls: [...]
  }
       ↓
【重複検索】
  /api/internal/schedule/find-duplicate
       ↓
    ┌──────────┴──────────┐
    │                     │
 重複あり            重複なし
    │                     │
    ↓                     ↓
【既存スケジュール更新】  【新規作成】
/api/internal/             /api/internal/
schedule/update            schedule/create
    │                     │
    ↓                     ↓
✏️ スケジュール        ✅ スケジュール
  更新 (id同じ)         作成 (新id)
    │                     │
    └──────────┬──────────┘
               ↓
          【通知送信】
```

---

## 使用例

### シナリオ1: 初回配信告知

```
【ツイート】
"明日22時から配信！🔴"

→ Gemma4分析
  {
    category: "LIVE",
    status: "LIVE_SOON",
    start_time: "22:00"
  }

→ URL無し
→ 重複無し
→ ✅ スケジュール作成
```

### シナリオ2: 配信時間変更

```
【元のツイート】
"明日22時から配信！"
→ ✅ スケジュール作成 (id=42)

【変更ツイート】
"時間変更: 20時にスタート https://youtube.com/live/xxx"

→ Gemma4分析
  {
    category: "LIVE",
    status: "TIME_CHANGE",
    start_time: "20:00",
    previous_time: "22:00"
  }

→ URL抽出: ["https://youtube.com/live/xxx"]
→ 重複検索: ±1時間 + "配信" キーワード → id=42 検出
→ ✏️ スケジュール更新 (id=42)
   - 時刻: 22時 → 20時
   - URL: https://youtube.com/live/xxx 追加
```

### シナリオ3: スポンサーシップ告知（スキップ）

```
【ツイート】
"スポンサー募集中！ https://fanbox.cc/xxx"

→ Gemma4分析
  {
    category: "PROMOTION",
    status: "NONE"
  }

→ スケジュール作成条件: category='LIVE' 必須
→ ❌ スキップ（スケジュール作成なし）
```

---

## ログ出力例

```bash
[koinoya_mai] 新しいツイート: ID123 "明日22時から配信！"
[Gemma] Analyzing tweet: 明日22時から配信！...
[Gemma] Analysis result: {
  category: 'LIVE',
  status: 'LIVE_SOON',
  start_time: '22:00',
  sentiment: 'POSITIVE',
  confidence: 1
}

[koinoya_mai] Found duplicate: id=42, updating...
[koinoya_mai] ✏️ schedule updated (id: 42) - 🔴 配信 at 2026-04-06T22:00:00.000Z
```

---

## 設定

| 環境変数 | 説明 | デフォルト |
|---------|-----|---------|
| ADMIN_NOTIFY_TOKEN | API認証トークン | 必須 |
| SCHEDULE_USER_ID | スケジュール作成先ユーザー | 1 |
| ENABLE_SCHEDULE_AUTO_CREATE | 自動作成有効化 | true |

---

## 今後の拡張案

- [ ] YouTube プレミアム配信の自動検出
- [ ] Twitter スペース (Spaces) の連動
- [ ] LINE 配信時刻通知
- [ ] キャッシュ機能（同じURL+時刻の重複排除）
- [ ] マルチプラットフォーム対応（TikTok等）
