<?php
/**
 * ドメインの単一ソース（リクエストから導出）。
 * ドメイン移行時も本ファイルの修正不要 — Host / X-Forwarded-Proto に自動追従する。
 *  override したい場合のみ $domain を先に定義してから require すること。
 */
$host = $_SERVER['HTTP_HOST'] ?? 'koinoyamai.love';

if (!isset($domain)) {
    $fwd = strtolower($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '');
    $isHttps = ($fwd === 'https') || (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    $proto = $isHttps ? 'https' : 'http';
    $domain = $proto . '://' . $host;
}
if (!isset($defaultImage)) {
    $defaultImage = $domain . '/social.jpg';
}
if (!isset($apiBase)) {
    /**
     * ローカル Node API のベース URL（PHP → API の内部通信用）。
     * 公開ドメイン（https://koinoyamai.love）経由だと往復で数百 ms かかるため、
     * 同一ホスト内の API を直叩きする（archive.php のサーバサイド描画で使う）。
     * ポートは環境で違う（本番 8080 / staging 8081）ため Host から導出する。
     *   - test.koinoyamai.love → staging API (:8081)
     *   - それ以外（koinoyamai.love / LAN 直撃 192.168.1.72:1717 / elza）→ 本番 API (:8080)
     */
    $apiPort = (strpos($host, 'test.') === 0) ? 8081 : 8080;
    $apiBase = 'http://127.0.0.1:' . $apiPort;
}
