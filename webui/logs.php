<?php require __DIR__ . "/updatelogs.php"; ?>
<!doctype html>
<html lang="ja">

<head>
    <?php
    $pageTitle = "アップデート履歴";
    $pageDesc = "まいちゃん通知の更新ログ・アップデート履歴です。";
    // 末尾フックで読み込む: sp.min.css は media="screen and (max-width:800px)" で
    // 後から読み込まれるため、ここでは .log-* のモバイル規則が sp.min.css に負ける。
    // 末尾に読み込み直せば这边的規則が常に優先される。
    $extraHeadEnd = '<link rel="stylesheet" href="/css/logs.css?v=' . @filemtime(__DIR__ . '/css/logs.css') . '" />';
    include __DIR__ . "/head.php";
    ?>
</head>

<body id="app-body">
    <div id="header-slot">
        <?php include __DIR__ . "/header.php"; ?>
    </div>

    <main class="logs-page">
        <?php
        // --- ページヘッダ（最新の日付と行数をここで出す）---
        $latest = $updateLogs[0] ?? null;
        $latestLines = null;
        if ($latest && isset($latest["lines"])) {
            $latestLines = number_format((int) preg_replace('/[^0-9]/', '', (string) $latest["lines"]));
        }
        ?>
        <div class="logs-head">
            <h1 class="logs-title"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i> アップデート履歴</h1>
            <p class="logs-sub">
                <?= htmlspecialchars((string) ($latest["date"] ?? "")) ?> 現在のリリース
                <?php if (count($updateLogs) > 1): ?>
                    ・全 <?= count($updateLogs) ?> 件の更新
                <?php endif; ?>
            </p>
        </div>

        <?php
        // --- コード成長グラフ（lines 値をインラインSVGで描画・ライブラリ不要）---
        $chartPts = [];
        foreach ($updateLogs as $log) {
            if (isset($log["lines"])) {
                $n = (int) preg_replace('/[^0-9]/', '', (string) $log["lines"]);
                if ($n > 0) {
                    // X軸を実日付の時間軸にするためタイムスタンプを持たせる
                    $ts = strtotime($log["date"]);
                    if ($ts) {
                        $chartPts[] = ["date" => $log["date"], "n" => $n, "disp" => $log["lines"], "ts" => $ts];
                    }
                }
            }
        }
        $chartPts = array_reverse($chartPts); // 古い→新しい（左→右）
        ?>
        <?php if (count($chartPts) >= 2): ?>
            <?php
            $cMin = min(array_column($chartPts, "n"));
            $cMax = max(array_column($chartPts, "n"));
            $cCount = count($chartPts);
            $W = 860; $H = 300;
            $padL = 78; $padR = 24; $padT = 20; $padB = 40;
            $iw = $W - $padL - $padR; $ih = $H - $padT - $padB;
            // X軸は実日付の時間軸（更新間隔が一定でないため、日付の経過に比例して配置）
            $t0 = (int) $chartPts[0]["ts"];
            $tN = (int) $chartPts[$cCount - 1]["ts"];
            $tSpan = max(1, $tN - $t0);
            $xOf = function ($p) use ($padL, $iw, $t0, $tSpan) {
                return $padL + $iw * (((int) $p["ts"] - $t0) / $tSpan);
            };
            $rng = max(1, $cMax - $cMin);
            // 下限を滑らかに（最小値の下に少し余白を作る）
            $yMin = max(0, $cMin - $rng * 0.10);
            $yMax = $cMax + $rng * 0.08;
            $yOf = function ($n) use ($padT, $ih, $yMin, $yMax) {
                return $padT + $ih * (1 - ($n - $yMin) / max(1, $yMax - $yMin));
            };
            $linePts = [];
            foreach ($chartPts as $p) { $linePts[] = round($xOf($p), 1) . "," . round($yOf($p["n"]), 1); }
            $polyline = implode(" ", $linePts);
            $baseY = round($padT + $ih, 1);
            $areaPath = "M " . $linePts[0] . " L " . implode(" L ", array_slice($linePts, 1)) . " L " . round($xOf($chartPts[$cCount - 1]), 1) . "," . $baseY . " L " . round($xOf($chartPts[0]), 1) . "," . $baseY . " Z";
            // Y軸ラベル用の値（下端/中間/上端）
            $yVals = [$yMin + ($yMax - $yMin) * 0, $yMin + ($yMax - $yMin) * 0.5, $yMax];
            $latestN = $chartPts[$cCount - 1]["n"];
            $delta = $latestN - $chartPts[0]["n"];
            ?>
            <section class="card logs-chart-card">
                <div class="logs-card-head">
                    <h2 class="logs-card-title"><i class="fa-solid fa-chart-line" aria-hidden="true"></i> コード成長（行数の推移）</h2>
                    <div class="logs-card-meta">
                        <span class="logs-delta <?= $delta < 0 ? "down" : "" ?>">
                            <i class="fa-solid <?= $delta < 0 ? "fa-arrow-trend-down" : "fa-arrow-trend-up" ?>" aria-hidden="true"></i>
                            <?= $delta < 0 ? "-" : "+" ?><?= number_format(abs($delta)) ?>（累計）
                        </span>
                        <span class="log-lines-badge"><i class="fa-solid fa-code" aria-hidden="true"></i><span><?= htmlspecialchars((string) $chartPts[$cCount - 1]["disp"]) ?></span> lines</span>
                    </div>
                </div>
                <div class="logs-chart">
                    <svg viewBox="0 0 <?= $W ?> <?= $H ?>" role="img" aria-label="コード行数の推移グラフ">
                        <defs>
                            <linearGradient id="lineFillGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stop-color="#B11E7C" stop-opacity=".26"/>
                                <stop offset="100%" stop-color="#B11E7C" stop-opacity=".02"/>
                            </linearGradient>
                        </defs>
                        <?php foreach ($yVals as $yi => $yv): ?>
                            <?php $yLine = round($yOf($yv), 1); ?>
                            <line x1="<?= $padL ?>" y1="<?= $yLine ?>" x2="<?= $W - $padR ?>" y2="<?= $yLine ?>" stroke="rgba(120,120,140,.28)" stroke-width="1" stroke-dasharray="3 4"/>
                            <text class="axis-label" x="<?= $padL - 10 ?>" y="<?= $yLine + 4 ?>" text-anchor="end" font-size="19" fill="rgba(90,90,110,.9)"><?= number_format((int) round($yv)) ?></text>
                        <?php endforeach; ?>
                        <path d="<?= $areaPath ?>" fill="url(#lineFillGrad)"/>
                        <polyline points="<?= $polyline ?>" fill="none" stroke="#B11E7C" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
                        <?php foreach ($chartPts as $p): ?>
                            <circle cx="<?= round($xOf($p), 1) ?>" cy="<?= round($yOf($p["n"]), 1) ?>" r="3.5" fill="#fff" stroke="#B11E7C" stroke-width="2">
                                <title><?= htmlspecialchars($p["date"]) ?> — <?= htmlspecialchars($p["disp"]) ?> lines</title>
                            </circle>
                        <?php endforeach; ?>
                        <text class="axis-label" x="<?= $padL ?>" y="<?= $H - 12 ?>" font-size="19" fill="rgba(90,90,110,.85)"><?= htmlspecialchars($chartPts[0]["date"]) ?></text>
                        <text class="axis-label" x="<?= $W - $padR ?>" y="<?= $H - 12 ?>" text-anchor="end" font-size="19" fill="rgba(90,90,110,.85)"><?= htmlspecialchars($chartPts[$cCount - 1]["date"]) ?></text>
                    </svg>
                </div>
            </section>
        <?php endif; ?>

        <ol class="logs-timeline">
            <?php foreach ($updateLogs as $index => $log): ?>
                <li class="card log-card <?= $index >= 10 ? "hidden-log" : "" ?>">
                    <h3 class="log-date">
                        <span class="log-date-text"><?= htmlspecialchars(
                            $log["date"],
                        ) ?></span>
                        <?php if ($index === 0): ?>
                            <span class="log-latest-tag">最新</span>
                        <?php endif; ?>
                    </h3>
                    <div class="log-body">
                        <?php if (isset($log["lines"])): ?>
                            <div class="log-lines-badge">
                                <i class="fa-solid fa-code" aria-hidden="true"></i>
                                <span><?= htmlspecialchars(
                                    $log["lines"],
                                ) ?> lines</span>
                            </div>
                        <?php endif; ?>
                        <?php
                        // 分類（fix / add / change）をバッジで出す
                        $known = [
                            "fix" => ["label" => "修正", "icon" => "fa-wrench"],
                            "add" => ["label" => "追加", "icon" => "fa-plus"],
                            "change" => ["label" => "変更", "icon" => "fa-arrow-right-arrow-left"],
                        ];
                        $cats = [];
                        foreach ($log["details"] as $key => $items) {
                            if (!is_array($items) || empty($items)) continue;
                            // 未知の分類キーでも黙って消さずに「その他」として出す
                            $meta = $known[$key] ?? ["label" => "その他", "icon" => "fa-circle-dot"];
                            $cats[$key] = ["label" => $meta["label"], "icon" => $meta["icon"], "items" => $items];
                        }
                        ?>
                        <?php if ($cats): ?>
                            <?php foreach ($cats as $key => $cat): ?>
                                <section class="log-category">
                                    <p class="log-cat-badge <?= htmlspecialchars($key) ?>">
                                        <i class="fa-solid <?= htmlspecialchars($cat["icon"]) ?>" aria-hidden="true"></i>
                                        <?= htmlspecialchars($cat["label"]) ?>
                                    </p>
                                    <ul>
                                        <?php foreach ($cat["items"] as $detail): ?>
                                            <li><?= htmlspecialchars($detail) ?></li>
                                        <?php endforeach; ?>
                                    </ul>
                                </section>
                            <?php endforeach; ?>
                        <?php else: ?>
                            <ul class="log-plain-list">
                                <?php foreach ($log["details"] as $detail): ?>
                                    <li><?= htmlspecialchars($detail) ?></li>
                                <?php endforeach; ?>
                            </ul>
                        <?php endif; ?>
                        <?php if (isset($log["image"])): ?>
                            <img src="<?= htmlspecialchars(
                                $log["image"],
                            ) ?>" class="log-image" alt="更新履歴の画面例" loading="lazy">
                        <?php endif; ?>
                    </div>
                </li>
            <?php endforeach; ?>
        </ol>

        <?php if (count($updateLogs) > 10): ?>
            <button id="load-more-btn" class="load-more-btn">もっと見る（古い履歴）</button>
        <?php endif; ?>

        <a href="../" class="logs-back-link">
            <i class="fa-solid fa-arrow-left" aria-hidden="true"></i> 通知ダッシュボードに戻る
        </a>
    </main>

    <div id="footer-slot">
        <?php include __DIR__ . "/footer.php"; ?>
    </div>

    <script src="/ios-helper.js" defer></script>
    <script type="module" src="/dist/main.bundle.min.js?v=<?= @filemtime(
        __DIR__ . "/dist/main.bundle.min.js",
    ) ?:
        time() ?>" defer></script>
    <script src="/dist/ui-misc.min.js?v=<?= @filemtime(
        __DIR__ . "/dist/ui-misc.min.js",
    ) ?:
        time() ?>" defer></script>
    <script src="/js/logs-load-more.js?v=<?= @filemtime(__DIR__ . '/js/logs-load-more.js') ?: time(); ?>"></script>
</body>

</html>
