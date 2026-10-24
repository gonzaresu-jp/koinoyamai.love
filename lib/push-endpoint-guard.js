"use strict";
// @ts-check
// lib/push-endpoint-guard.js — push エンドポイントの**送信前 DNS 解決検証**（2026-10-24 / issue #76）
//
// なぜ必要か:
//   `lib/validate.js` の `publicHttpUrl` は **ホスト名の文字列**しか見ていない（IP 直書きは遮断、
//   ドメインは「公開ホスト名の形かどうか」だけ判定）。つまり **ホスト名が内部 IP に解決される**
//   経路（DNS rebinding）は塞げていない。攻撃者が `https://attacker.example/push` を登録し、
//   そのドメインの A レコードを 127.0.0.1 / 169.254.169.254 に向けたままにすると、
//   サーバーが内部へ POST する（＝任意の内部 URL への POST + ステータスオラクル）。
//
// 何をするか:
//   送信直前に `dns.promises.lookup(..., { all: true })` で解決し、
//   **すべての解決先**が `isRoutableHost`（lib/validate.js）を通るなら送信を許可する。
//   private / loopback / link-local / multicast / broadcast / Tailscale(CGNAT) / IPv6 ULA 等は拒否。
//
// 制約と前提:
//   - web-push は**独自エージェントで接続する**ため、検証後の接続先を pin する手段は無い
//     （「検査で閾値を上げる」ことが目的。DNS キャッシュ TTL 30 秒）。
//   - **失敗時は送信を止めて可視化する**（AGENTS.md §11 / §5.2 の原則）。
//     黙って通すのも、黙って消すのも不可。呼び出し側が `console.warn` で理由・解決先を出す。
//   - **既存の登録行は壊さない**（削除しない）。DNS 一時障害で端末の受信能力を失わせないため。
//   - `webview2://` 等の非 http は従来どおり、呼び出し側で先にスキップしている
//     （ここでは `non-http` を返すだけで、デスクトップ版を壊さない）。
//
// 使い方:
// ```js
// const { pushGuard } = require("../lib/push-endpoint-guard");
// const verdict = await pushGuard.check(subscription.endpoint);
// if (!verdict.ok) {
//   console.warn("[push-guard] 送信を拒否", JSON.stringify({ reason: verdict.reason, host: verdict.hostname, addresses: verdict.addresses }));
//   return false; // DB 行は残す（404/410 の削除とは別）
// }
// ```
//
// 任意 env（すべて未設定でも動く）:
//   PUSH_GUARD_CACHE_TTL_MS（既定 30000）/ PUSH_GUARD_TIMEOUT_MS（既定 3000）
//   PUSH_GUARD_DISABLED=1 … 検証を無効化する（**意図的な設定でなければ使わない**。
//     無効化すると issue #76 の経路が復活する。起動時に警告を出す）
const dns = require("dns");
const { isRoutableHost } = require("./validate");

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_CACHE_ENTRIES = 500;
const MAX_ADDRESSES_LOGGED = 4;

/**
 * @typedef {object} GuardVerdict
 * @property {boolean} ok true = 送信してよい
 * @property {string|null} reason 拒否理由（`non-public-ip(10.0.0.5)` / `dns-failure(ENOTFOUND)` /
 *   `dns-timeout` / `dns-empty` / `non-http` / `invalid-url`）
 * @property {string} hostname 判定したホスト（IP リテラルを含む）。ログ用の証拠
 * @property {string[]} addresses 解決先（ログ用に先頭のみ保持）
 * @property {boolean} cached キャッシュから返したか
 */

/**
 * 送信前の DNS 検証を行うガードを生成する（テストでは `lookup` を差し込める）。
 *
 * @param {{lookup?: (host: string, opts: object) => Promise<{address: string, family: number}[]>,
 *          now?: () => number, cacheTtlMs?: number, timeoutMs?: number}} [opts]
 */
function createPushEndpointGuard(opts = {}) {
  const lookup = opts.lookup || ((host, o) => dns.promises.lookup(host, o));
  const now = opts.now || (() => Date.now());
  const ttlMs = opts.cacheTtlMs === undefined ? DEFAULT_CACHE_TTL_MS : opts.cacheTtlMs;
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;

  /** @type {Map<string, {at: number, verdict: GuardVerdict}>} */
  const cache = new Map();
  /** @type {Map<string, Promise<GuardVerdict>>} */
  const inflight = new Map();

  /**
   * @param {boolean} ok
   * @param {string|null} reason
   * @param {string} hostname
   * @param {string[]} [addresses]
   * @param {boolean} [cached]
   * @returns {GuardVerdict}
   */
  function v(ok, reason, hostname, addresses, cached) {
    return {
      ok,
      reason: reason || null,
      hostname,
      addresses: (addresses || []).slice(0, MAX_ADDRESSES_LOGGED),
      cached: !!cached,
    };
  }

  /** @param {string} hostname @param {GuardVerdict} verdict */
  function remember(hostname, verdict) {
    if (ttlMs <= 0) return verdict;
    cache.set(hostname, { at: now(), verdict });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return verdict;
  }

  /**
   * 解決先がすべて公開 IP かどうかを判定する。
   * @param {string} hostname
   * @param {string[]} addresses
   * @returns {GuardVerdict}
   */
  function checkResolved(hostname, addresses) {
    const bad = addresses.find((a) => !isRoutableHost(a));
    // 1 つでも内部宛があれば拒否（DNS は複数 A レコードを返すことがある）
    if (bad) return v(false, `non-public-ip(${bad})`, hostname, addresses);
    return v(true, null, hostname, addresses);
  }

  /**
   * ホスト名を解決して判定する（30 秒キャッシュ・並行呼び出しは 1 回に束ねる）。
   * @param {string} hostname
   * @returns {Promise<GuardVerdict>}
   */
  function resolve(hostname) {
    const hit = cache.get(hostname);
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(v(hit.verdict.ok, hit.verdict.reason, hostname, hit.verdict.addresses, true));
    const pending = inflight.get(hostname);
    if (pending) return pending;

    const job = (async () => {
      try {
        const res = await Promise.race([
          lookup(hostname, { all: true, verbatim: true }),
          // ⚠️ タイマーを unref しないこと: unref すると「lookup が返ってこない」ときに
          // イベントループが空になり、**プロセスが静かに抜ける**（2026-10-24 実測:
          // 回帰テストが [17] の途中で exit 1 になった）。最大 timeoutMs 秒だけ保持されるだけ。
          new Promise((_, rej) => {
            setTimeout(() => rej(new Error("dns-timeout")), timeoutMs);
          }),
        ]);
        const list = Array.isArray(res)
          ? res.map((r) => (typeof r === "string" ? r : r && r.address)).filter(Boolean)
          : [res && res.address].filter(Boolean);
        if (!list.length) return remember(hostname, v(false, "dns-empty", hostname, []));
        return remember(hostname, checkResolved(hostname, list));
      } catch (e) {
        const code = e && e.message === "dns-timeout" ? "dns-timeout" : ((e && e.code) || "error");
        // fail-closed: 解決できない＝検証できない＝送信しない（理由はログに出る）
        return remember(hostname, v(false, `dns-failure(${code})`, hostname, []));
      } finally {
        inflight.delete(hostname);
      }
    })();

    inflight.set(hostname, job);
    return job;
  }

  /**
   * エンドポイントを検証する。
   * @param {string|null|undefined} endpoint
   * @returns {Promise<GuardVerdict>}
   */
  async function check(endpoint) {
    const raw = String(endpoint || "");
    let u;
    try {
      u = new URL(raw);
    } catch {
      return v(false, "invalid-url", "", []);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return v(false, "non-http", u.hostname, []);
    }
    let host = String(u.hostname || "").toLowerCase();
    // `new URL("http://[::1]/").hostname` は角括弧付き（lib/validate.js の注記と同じ）
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (!host) return v(false, "invalid-url", "", []);
    // IP リテラルは解決不要（同じ基準を isRoutableHost で直接判定）
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
      return checkResolved(host, [host]);
    }
    return resolve(host);
  }

  /**
   * テスト用: ホストの判定をキャッシュに仕込む（DNS を呼ばずに呼び出し側の経路を検証できる）。
   * @param {string} hostname
   * @param {boolean} ok
   * @param {string} [reason]
   */
  function primeForTest(hostname, ok, reason) {
    if (ttlMs <= 0) throw new Error("primeForTest には cacheTtlMs > 0 のガードが必要です");
    cache.set(hostname, { at: now(), verdict: v(ok, reason || null, hostname, [], false) });
  }

  return { check, primeForTest, _cache: cache };
}

const disabled = process.env.PUSH_GUARD_DISABLED === "1";
if (disabled) {
  console.warn("[push-guard] PUSH_GUARD_DISABLED=1: 送信前の DNS 検証を無効化しています（issue #76 の経路が復活します。意図的な設定か確認してください）");
}

/** アプリで使う既定インスタンス */
const pushGuard = disabled
  ? {
      check: async () => v(true, null, "", [], false),
      primeForTest: () => {},
      _cache: new Map(),
    }
  : createPushEndpointGuard();

module.exports = { createPushEndpointGuard, pushGuard };
