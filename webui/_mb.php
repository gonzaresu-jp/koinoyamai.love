<?php
/**
 * mbstring 非依存の UTF-8 補助関数（長さ・検索のみ）。
 *
 * なぜ mbstring を入れないのか（2026-10-21 実測）:
 *   - このサーバの PHP には `php8.3-mbstring` を導入していない（意図的）。
 *     ext/mbstring は Ubuntu 8.3.6-0ubuntu0.24.04.12 に未バックポートの
 *     CVE-2026-6104（mb_convert_encoding の global buffer over-read）の
 *     影響を受ける拡張。使わないなら導入しない（攻撃面・未適用 CVE を増やさない）。
 *   - 過去に subtitle-compare.php が `mb_strlen()` を素で呼び、
 *     mbstring 不在のため本番で HTTP 500
 *     （Fatal error: Call to undefined function mb_strlen()）になっていた。
 *     同じことを繰り返さないよう、mb_* を直接呼ばず必ず本ファイル経由にする。
 *
 * 回帰テスト [10] が「webui/*.php に mb_ 関数が無いこと」を保証する
 * （mbstring を誤って入れてもAttack面が増えないよう、使うなら再レビューすること）。
 */
if (!function_exists('mai_utf8_len')) {
    /**
     * UTF-8 の文字数（コードポイント数）を返す。
     * 不正な UTF-8 の場合はバイト数にフォールバックする（mb_strlen と近似）。
     */
    function mai_utf8_len(string $s): int
    {
        if ($s === '') {
            return 0;
        }
        $n = preg_match_all('/./us', $s);
        return $n === false ? strlen($s) : $n;
    }
}

if (!function_exists('mai_utf8_strpos')) {
    /**
     * mb_strpos の代替needle が含まれる位置を**文字位置**で返す（無ければ false）。
     * 引数は UTF-8 である前提。不正な UTF-8 の場合は false を返す（誤検知を避ける）。
     */
    function mai_utf8_strpos(string $haystack, string $needle, int $offset = 0): int|false
    {
        if ($needle === '') {
            return 0;
        }
        // 空パターン + /u は「UTF-8 として妥当か」の判定に使える
        if (!preg_match('//u', $haystack) || !preg_match('//u', $needle)) {
            return false;
        }
        // offset は mb_strpos と同じく「文字位置」。バイト位置へ変換してから探す
        $byteOffset = 0;
        if ($offset > 0) {
            if (preg_match('/^.{0,' . $offset . '}/us', $haystack, $m) === 1) {
                $byteOffset = strlen($m[0]);
            }
        }
        $byte = strpos($haystack, $needle, $byteOffset);
        if ($byte === false) {
            return false;
        }
        // バイト位置を文字位置へ変換
        return mai_utf8_len(substr($haystack, 0, $byte));
    }
}
