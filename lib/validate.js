"use strict";
// @ts-check
const geoip = require("../services/geoip");
/**
 * lib/validate.js — 境界バリデーション（依存ゼロ・fail-closed）
 *
 * なぜ必要か:
 *   - JSON を型注釈するだけでは「検証していない」ことに等しい。TS の型は**実行時に存在しない**。
 *   - 実際に起きた事故は「外部が返したオブジェクトを想定どおりと信じて使う」型のものが多い
 *     （依存更新で API 形状が変わる、API がエラー JSON を返す、クライアントが想定外の型を送る）。
 *   - 静かに壊れるより **400 を返して失敗を可視化する**方が安全（§11「fail-closed」）。
 *
 * 型検査: TypeScript を入れずに `// @ts-check` + JSDoc で行う（2026-10-23 追加）。
 *
 * @fileoverview 外部入力を**そのまま信じて使うな**。このモジュールは「壊れる可能性のある入力」を
 *   400 に倒すための共通ヘルパ。`lib/` に置くのは `lib/admin.js` からも使うため（低レイヤ）。
 *
 * 使い方（HMAC 検証や認証の**後**に呼ぶこと。検証で先に通すと認証バイパスになる）:
 * ```js
 * const { str, num, enumOf, ValidationError } = require("../lib/validate");
 * try {
 *   const title = str(req.body.title, { field: "title", min: 1, max: 500, trim: true });
 *   ...
 * } catch (e) {
 *   if (e instanceof ValidationError) return res.status(400).json({ ok: false, error: e.message });
 *   throw e;
 * }
 * ```
 *
 * 長さの上限は「壊れるか」ではなく「壊さない」ための値を指定する。
 * 既存クライアントを妨げないよう、上限は実装の想定より大きめに取ること。
 */

/** 入力検証に失敗した（＝そのまま扱うと壊れる）。呼び出し側は 400 に倒す。 */
class ValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

/** @param {*} v */
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * 文字列を検証する。
 * @param {*} v
 * @param {{field: string, min?: number, max?: number, trim?: boolean, pattern?: RegExp, allowNull?: boolean}} o
 * @returns {string|null} `allowNull` かつ null/undefined のときだけ null
 */
function str(v, o) {
  const f = o.field || "value";
  if (o.allowNull && v == null) return null;
  if (typeof v !== "string") {
    throw new ValidationError(`${f} must be a string (got ${describe(v)})`);
  }
  const s = o.trim ? v.trim() : v;
  const min = o.min == null ? 0 : o.min;
  const max = o.max == null ? 0 : o.max;
  if (s.length < min) throw new ValidationError(`${f} is too short (min ${min})`);
  if (max && s.length > max) throw new ValidationError(`${f} is too long (max ${max})`);
  if (o.pattern && !o.pattern.test(s)) throw new ValidationError(`${f} has an invalid format`);
  return s;
}

/**
 * 数値を検証する（文字列の数字は受け付けない＝`"10"` で型ヒットしないように）。
 * @param {*} v
 * @param {{field: string, min?: number, max?: number, int?: boolean, allowNull?: boolean, default?: number}} o
 * @returns {number}
 */
function num(v, o) {
  const f = o.field || "value";
  if (o.allowNull && v == null) return null;
  if (o.default != null && v == null) return o.default;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ValidationError(`${f} must be a finite number (got ${describe(v)})`);
  }
  if (o.int && !Number.isInteger(v)) throw new ValidationError(`${f} must be an integer`);
  const min = o.min == null ? -Infinity : o.min;
  const max = o.max == null ? Infinity : o.max;
  if (v < min || v > max) throw new ValidationError(`${f} is out of range (${min}..${max})`);
  return v;
}

/**
 * 真偽値を検証する（`"false"` のような文字列は拒否する）。
 * @param {*} v
 * @param {{field: string, allowNull?: boolean, default?: boolean}} o
 * @returns {boolean}
 */
function bool(v, o) {
  const f = o.field || "value";
  if (o.allowNull && v == null) return null;
  if (o.default != null && v == null) return o.default;
  if (typeof v !== "boolean") throw new ValidationError(`${f} must be a boolean (got ${describe(v)})`);
  return v;
}

/**
 * 許可リストのいずれかであることを検証する。
 * @template {string|number} T
 * @param {*} v
 * @param {{field: string, values: T[], allowNull?: boolean, default?: T}} o
 * @returns {T}
 */
function enumOf(v, o) {
  const f = o.field || "value";
  if (o.allowNull && v == null) return null;
  if (o.default !== undefined && v == null) return o.default;
  if (!o.values.includes(v)) throw new ValidationError(`${f} must be one of: ${o.values.join(", ")}`);
  return v;
}

/**
 * 配列を検証する（要素ごとの検証は `of` に渡す）。
 * @template T
 * @param {*} v
 * @param {{field: string, max?: number, min?: number, of?: (item: any, path: string) => T}} o
 * @returns {T[]}
 */
function arr(v, o) {
  const f = o.field || "value";
  if (!Array.isArray(v)) throw new ValidationError(`${f} must be an array (got ${describe(v)})`);
  const max = o.max == null ? 0 : o.max;
  if (max && v.length > max) throw new ValidationError(`${f} has too many items (max ${max})`);
  if (o.min != null && v.length < o.min) throw new ValidationError(`${f} has too few items (min ${o.min})`);
  if (!o.of) return v;
  return v.map((item, i) => o.of(item, `${f}[${i}]`));
}

/**
 * オブジェクトのキーを**明示的に列挙**して検証する（知らないキーは弾く＝enum のような暴挙を防ぐ）。
 * @param {*} v
 * @param {{field: string, allowed: string[], allowNull?: boolean}} o
 * @returns {Record<string, any>}
 */
function objKeys(v, o) {
  const f = o.field || "value";
  if (o.allowNull && v == null) return null;
  if (!isPlainObject(v)) throw new ValidationError(`${f} must be an object (got ${describe(v)})`);
  for (const key of Object.keys(v)) {
    if (!o.allowed.includes(key)) throw new ValidationError(`${f}.${key} is not an allowed key`);
  }
  return v;
}

/**
 * ホスト名が「インターネットへ到達可能な公開ホスト」か。
 *
 * **SSRF 対策**: web push のエンドポイントはクライアントが自由に指定でき、サーバーが
 * その URL へ POST する（`routes/subscriptions.js` 登録 → `services/notification.js` 送信）。
 * ここを素通りすると「任意の内部 URL への POST 経路 + ステータスオラクル」になる。
 *
 * ⚠️ 残る限界: **ホスト名が公開 IP に解決されるかまでは見ない**（DNS rebinding）。
 * プッシュサービスのホストは安定しているので許可リスト化も可能だが、
 * 他ブラウザの push service まで壊さないため今回は経路リスト方式にしている。
 *
 * @param {string} hostRaw `URL.hostname` の値。
 *   ⚠️ `new URL("http://[::1]/").hostname` は**角括弧付き**の `[::1]` を返すので、ここでは外して判定する。
 * @returns {boolean} true = 送信先として許可
 */
function isRoutableHost(hostRaw) {
  const h = String(hostRaw || "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!h) return false;

  // IPv6 リテラル（IPv4 リテラルより先に見る。`.` を含まないため）
  if (h.includes(":")) {
    const nib = geoip.ipv6Nibbles(h); // 32 桁の nibble 列（解釈不能なら null）
    if (!nib) return false; // fail-closed
    // IPv4-mapped（`::ffff:a9fe:a9fe` = 169.254.169.254）は **IPv4 として判定**する。
    // ここを外すと 16 進表記経由でメタデータへ届く。
    // プレフィックスは 96bit = 24 nibble（先頭 20 個の 0 + ffff）。数え違えるとメタデータが素通りする。
    if (/^0{20}ffff/.test(nib)) {
      const v4 = [24, 26, 28, 30].map((i) => parseInt(nib.slice(i, i + 2), 16)).join(".");
      return isRoutableHost(v4);
    }
    // nibble 列で判定する（圧縮形・全表記形どちらでも同じ結果になるように）。
    // `geoip.isPrivateIp` は `::1` のように**圧縮表記しか見ていない**のでここでは使わない。
    if (nib === "0".repeat(32)) return false;            // unspecified (::)
    if (nib === "0".repeat(31) + "1") return false;      // loopback (::1 / 0:0:0:0:0:0:0:1)
    if (nib.startsWith("ff")) return false;              // multicast (ff00::/8)
    if (/^fe[89ab]/.test(nib)) return false;             // link-local (fe80::/10)
    if (/^f[cd]/.test(nib)) return false;                // unique local (fc00::/7)
    return true;
  }

  // 単一ラベル（`localhost` / `intranet`）とローカル系 TLD は拒否
  if (!h.includes(".")) return false;
  if (/\.(local|localhost|internal|intranet|private|corp|home|lan|test|example|invalid|onion)$/.test(h)) return false;
  // IPv4 リテラル
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (geoip.isPrivateIp(h)) return false;                       // 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10
    if (a === 0) return false;                                    // 0.0.0.0/8
    if (a === 255) return false;                                   // broadcast
    if (a >= 224) return false;                                    // multicast (224/4) と予約 (240/4)
    if (a === 192 && b === 0) return false;                        // 192.0.0.0/24 (IETF)
    if (a === 198 && (b === 18 || b === 19)) return false;         // 198.18.0.0/15 (ベンチマーク)
    if (a === 198 && b === 51) return false;                       // 198.51.100.0/24 (TEST-NET-2)
    if (a === 203 && b === 0) return false;                        // 203.0.113.0/24 (TEST-NET-3)
    return true;
  }
  // 通常の FQDN（ラベルの前後にハイフンを許可しない形で厳しめに）
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h);
}

/**
 * 送信先として使える URL を検証する（http/https かつ**公開ホスト**）。SSRF 対策。
 * 非 http（デスクトップアプリの `webview2://` 等）は呼び出し側で別扱いにすること。
 * @param {*} v
 * @param {{field: string, max?: number, allowNull?: boolean}} o
 * @returns {string}
 */
function publicHttpUrl(v, o) {
  const s = httpUrl(v, { field: o.field, max: o.max || 2048, allowNull: o.allowNull });
  if (s == null) return null;
  if (!isRoutableHost(new URL(s).hostname)) {
    // ホスト名はエラーメッセージに出さない（攻撃者の入力をエコーしない）
    throw new ValidationError(`${o.field || "url"} must point to a public http(s) host`);
  }
  return s;
}

/** 診断メッセージ用（実データの中身を出さない。型だけ示す） */
function describe(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * URL を検証する（http/https のみ。`data:` や `javascript:` を渡さないため）。
 * @param {*} v
 * @param {{field: string, max?: number, allowNull?: boolean}} o
 * @returns {string}
 */
function httpUrl(v, o) {
  const s = str(v, { field: o.field, min: 1, max: o.max || 2048, allowNull: o.allowNull });
  if (s == null) return null;
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    throw new ValidationError(`${o.field || "url"} is not a valid URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ValidationError(`${o.field || "url"} must be http(s)`);
  }
  return s;
}

module.exports = {
  ValidationError,
  isPlainObject,
  str,
  num,
  bool,
  enumOf,
  arr,
  objKeys,
  httpUrl,
  publicHttpUrl,
  isRoutableHost,
  describe,
};
