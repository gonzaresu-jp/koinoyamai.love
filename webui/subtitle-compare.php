<!doctype html>
<html lang="ja">

<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>字幕比較 | Whisper vs YT</title>
    <meta name="robots" content="noindex, nofollow">
    <link rel="stylesheet" href="/css/subtitle-compare.css" />
</head>

<body>
    <?php
    // ---- 入力 ----
    $id = isset($_GET['id']) ? preg_replace('/[^A-Za-z0-9_-]/', '', (string)$_GET['id']) : '';
    $bucket = isset($_GET['bucket']) ? max(5, min(300, (int)$_GET['bucket'])) : 30;
    $q = isset($_GET['q']) ? trim((string)$_GET['q']) : '';

    function fetch_json($url, $timeoutSec = 8)
    {
        $ctx = stream_context_create(array('http' => array('timeout' => $timeoutSec, 'ignore_errors' => true)));
        $body = @file_get_contents($url, false, $ctx);
        if ($body === false) return null;
        $data = json_decode($body, true);
        return is_array($data) ? $data : null;
    }

    $whisper = null;
    $yt = null;
    $error = null;

    if ($id !== '') {
        // Whisper は自ホストの Node API (8080) から
        $wUrl = 'http://127.0.0.1:8080/api/archive/whisper/' . $id;
        $wRes = fetch_json($wUrl);
        if ($wRes === null) {
            $error = 'Node API(8080) に接続できません';
        } elseif (isset($wRes['segments'])) {
            $whisper = $wRes['segments'];
        }
        // YT字幕はアーカイブ(.70:8766)から直接
        $yData = fetch_json('http://192.168.1.70:8766/api/transcript/' . $id, 12);
        if (is_array($yData) && isset($yData['segments'])) {
            $yt = $yData['segments'];
        }
    }

    // ---- バケット統合（両者を同一タイムラインで比較） ----
    $rows = array(); // [t => [w => string, y => string]]
    if ($whisper !== null && count($whisper) > 0) {
        foreach ($whisper as $s) {
            $b = (int)floor(((int)($s['start_ms'] ?? 0)) / 1000 / $bucket);
            $rows[$b]['w'] = ($rows[$b]['w'] ?? '') . htmlspecialchars((string)$s['text']);
        }
    }
    if ($yt !== null && count($yt) > 0) {
        foreach ($yt as $s) {
            $b = (int)floor(((int)($s['start_ms'] ?? 0)) / 1000 / $bucket);
            $rows[$b]['y'] = ($rows[$b]['y'] ?? '') . htmlspecialchars((string)$s['text']);
        }
    }
    ksort($rows);

    // ---- 統計 ----
    $wChars = 0;
    $yChars = 0;
    if ($whisper) foreach ($whisper as $s) $wChars += mb_strlen((string)($s['text'] ?? ''), 'UTF-8');
    if ($yt) foreach ($yt as $s) $yChars += mb_strlen((string)($s['text'] ?? ''), 'UTF-8');
    $wSpan = $whisper ? ((int)end($whisper)['end_ms'] - (int)$whisper[0]['start_ms']) : 0;
    $ySpan = $yt ? ((int)end($yt)['end_ms'] - (int)$yt[0]['start_ms']) : 0;
    $fmtSpan = fn($ms) => sprintf('%d時間%02d分', floor($ms / 3600000), floor(($ms % 3600000) / 60000));
    ?>
    <header>
        <h1><a href="subtitle-compare.php">字幕比較</a> Whisper vs YouTube</h1>
        <form class="controls" method="get" action="subtitle-compare.php">
            <input type="text" name="id" value="<?= htmlspecialchars($id) ?>" placeholder="video_id (例: lDIEOM5vo-I)" size="22">
            <select name="bucket" title="1行の時間幅(秒)">
                <?php foreach ([10, 15, 30, 60, 120] as $b) {
                    echo '<option value="' . $b . '"' . ($bucket === $b ? ' selected' : '') . '>' . $b . '秒</option>';
                } ?>
            </select>
            <input type="text" name="q" value="<?= htmlspecialchars($q) ?>" placeholder="絞り込み文字列" size="22">
            <button type="submit">表示</button>
        </form>
        <?php if ($id !== ''): ?>
            <div class="stats">
                <span><span class="w-text">Whisper</span> セグ<b><?= $whisper ? count($whisper) : '0' ?></b> 文字<b><?= number_format($wChars) ?></b> 範囲<b><?= $fmtSpan($wSpan) ?></b></span>
                <span><span class="y-text">YT</span> セグ<b><?= $yt ? count($yt) : '0' ?></b> 文字<b><?= number_format($yChars) ?></b> 範囲<b><?= $fmtSpan($ySpan) ?></b></span>
                <span>バケット<b><?= count($rows) ?></b></span>
                <?php if ($error): ?><span style="color:#f88"><?= htmlspecialchars($error) ?></span><?php endif; ?>
                <span style="color:#8a93a8">※コラボの話者分離は実装前（speaker列は空）</span>
            </div>
        <?php endif; ?>
    </header>

    <main>
        <?php if ($id === ''): ?>
            <div class="legend">上のフォームに動画IDを入れてください。対象: <a href="subtitle-compare.php?id=lDIEOM5vo-I">コラボ lDIEOM5vo-I</a> / <a href="subtitle-compare.php?id=4-oYl8Q8154">ASMR 4-oYl8Q8154</a></div>
            <div class="noresult">まず動画IDを指定して表示してください。</div>
        <?php elseif ($whisper === null && $error === null): ?>
            <div class="noresult">Whisper字幕が未生成です（video_whisper_segments にデータなし）。</div>
        <?php else: ?>
            <div class="legend">
                <span><span class="w-text">■ 青 = Whisper（Groq whisper-large-v3-turbo）</span></span>
                <span><span class="y-text">■ オレンジ = YouTube自動字幕</span></span>
                <span><label><input type="checkbox" id="onlyHit"> 一致行のみ表示</label></span>
            </div>
            <?php if (count($rows) === 0): ?>
                <div class="noresult">データがありません。</div>
            <?php else: ?>
                <div id="list">
                    <?php foreach ($rows as $b => $r) {
                        $ts = sprintf('%02d:%02d', floor($b * $bucket / 60), $b * $bucket % 60);
                        $wText = isset($r['w']) ? $r['w'] : '';
                        $yText = isset($r['y']) ? $r['y'] : '';
                        $wHit = ($q !== '' && mb_strpos(strip_tags($wText), $q, 0, 'UTF-8') !== false);
                        $yHit = ($q !== '' && mb_strpos(strip_tags($yText), $q, 0, 'UTF-8') !== false);
                        $hasHit = $wHit || $yHit;

                        // 検索語ハイライト
                        if ($q !== '') {
                            $pat = '/' . preg_quote($q, '/') . '/u';
                            if ($wText !== '') $wText = preg_replace($pat, '<mark class="hit">$0</mark>', $wText);
                            if ($yText !== '') $yText = preg_replace($pat, '<mark class="hit">$0</mark>', $yText);
                        }

                        echo '<div class="buck" data-hit="' . ($hasHit ? '1' : '0') . '">';
                        echo '<div class="t">' . $ts . '</div>';
                        echo '<div class="w">' . ($wText !== '' ? $wText . ($wHit ? ' <mark class="hit">★</mark>' : '') : '<span class="empty">（なし）</span>') . '</div>';
                        echo '<div class="y">' . ($yText !== '' ? $yText . ($yHit ? ' <mark class="hit">★</mark>' : '') : '<span class="empty">（なし）</span>') . '</div>';
                        echo '</div>';
                    } ?>
                </div>
                <script src="/js/subtitle-compare-toggle.js?v=<?= @filemtime(__DIR__ . '/js/subtitle-compare-toggle.js') ?: time(); ?>"></script>
            <?php endif; ?>
        <?php endif; ?>
    </main>
</body>

</html>