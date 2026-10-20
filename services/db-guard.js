/**
 * sqlite3 の保護（プロセス落ちの防止）
 *
 * なぜ必要か（2026-10-21 実測）:
 *   node-sqlite3 は、文ごとのエラーコールバック（errBack）を持たない文でエラーになると、
 *   Statement が EventEmitter の 'error' イベントを emit する。
 *   リスナが無いと EventEmitter が例外を投げて **uncaught exception** になり、
 *   API / ワーカーが落ちる。SQLITE_BUSY（ロック競合）で実際に再現した。
 *
 *   ファイル単位のエラーコールバックを全部書くのは現実的でないため、
 *   Database.prototype に「既定のエラーコールバック」を差し込むことで
 *   「エラーはログに残るが、処理は続く」状態にする。
 *
 *   ※ Database 側の 'error' イベント（db.on('error')）では捕まらない。
 *     発生源は Statement 側の 'error' なので、プロトタイプを差す。
 *
 * 使い方: require('./services/db-guard') を DB を使う前に1度だけ require する。
 */
const sqlite3 = require('sqlite3');

const MARK = '__maiDbGuarded';

if (!sqlite3.Database.prototype[MARK]) {
    const defaultErrBack = (method) => (err) => {
        if (err) console.error(`[db] ${method} error:`, err.message);
    };

    for (const method of ['run', 'all', 'get']) {
        const orig = sqlite3.Database.prototype[method];
        if (typeof orig !== 'function') continue;
        sqlite3.Database.prototype[method] = function (sql, ...args) {
            // 末尾が関数でなければ、既定のエラーコールバックを足す
            if (typeof args[args.length - 1] !== 'function') {
                args.push(defaultErrBack(method));
            }
            return orig.call(this, sql, ...args);
        };
    }

    const origPrepare = sqlite3.Database.prototype.prepare;
    if (typeof origPrepare === 'function') {
        sqlite3.Database.prototype.prepare = function (sql, ...args) {
            if (typeof args[args.length - 1] !== 'function') {
                args.push(defaultErrBack('prepare'));
            }
            return origPrepare.call(this, sql, ...args);
        };
    }

    sqlite3.Database.prototype[MARK] = true;
}

module.exports = {};
