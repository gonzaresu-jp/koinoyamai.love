
        function timeAgo(date) {
            if (!date) return 'Never';
            const seconds = Math.floor((new Date() - new Date(date)) / 1000);
            let interval = seconds / 31536000;
            if (interval > 1) return Math.floor(interval) + ' years ago';
            interval = seconds / 2592000;
            if (interval > 1) return Math.floor(interval) + ' months ago';
            interval = seconds / 86400;
            if (interval > 1) return Math.floor(interval) + ' days ago';
            interval = seconds / 3600;
            if (interval > 1) return Math.floor(interval) + ' hours ago';
            interval = seconds / 60;
            if (interval > 1) return Math.floor(interval) + ' minutes ago';
            return Math.floor(seconds) + ' seconds ago';
        }

        function fmtBytes(bytes) {
            if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
            if (bytes >= 1048576)    return (bytes / 1048576).toFixed(0) + ' MB';
            return (bytes / 1024).toFixed(0) + ' KB';
        }

        function fmtUptime(sec) {
            const d = Math.floor(sec / 86400);
            const h = Math.floor((sec % 86400) / 3600);
            const m = Math.floor((sec % 3600) / 60);
            if (d > 0) return d + 'd ' + h + 'h';
            if (h > 0) return h + 'h ' + m + 'm';
            return m + 'm';
        }

        function barClass(pct, baseClass) {
            if (pct >= 90) return 'crit';
            if (pct >= 70) return 'warn';
            return baseClass;
        }

        async function fetchWithRetry(url) {
            const maxAttempts = 3;
            let res = null;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    res = await fetch(url);
                } catch (e) {
                    if (attempt === maxAttempts) throw e;
                    await new Promise(r => setTimeout(r, attempt * 2000));
                    continue;
                }
                if (res.ok) return res;
                if (res.status === 429 && attempt < maxAttempts) {
                    const ra = parseInt(res.headers.get('Retry-After'), 10);
                    const waitMs = Math.min((ra > 0 ? ra : attempt * 2) * 1000, 30000);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }
                if (attempt === maxAttempts) return res;
                await new Promise(r => setTimeout(r, attempt * 2000));
            }
            return res;
        }

        async function loadSystemInfo() {
            const grid = document.getElementById('resource-grid');
            try {
                const res  = await fetchWithRetry('/api/system-info');
                if (!res.ok) {
                    if (grid) grid.innerHTML = '<div class="ai-muted">リソース情報を取得できませんでした</div>';
                    return;
                }
                const d    = await res.json();
                const cpu  = d.cpu || {};
                const mem  = d.memory || {};
                const proc = d.process || {};
                const dOs  = d.os || {};

                const cpuPct  = cpu.usagePercent  ?? 0;
                const memPct  = mem.usagePercent  ?? 0;
                const procPct = mem.total ? Math.round(proc.rss / mem.total * 100) : 0;

                grid.innerHTML = `
                    <!-- CPU Card -->
                    <div class="resource-card">
                        <div class="resource-card-top">
                            <div class="resource-label"><i class="fa-solid fa-microchip"></i>CPU 使用率</div>
                            <div class="resource-value">${cpuPct}<span class="resource-unit">%</span></div>
                        </div>
                        <div class="resource-bar-wrap">
                            <div class="resource-bar cpu ${barClass(cpuPct, 'cpu')}" style="width:${cpuPct}%"></div>
                        </div>
                        <div class="resource-sub">
                            <span>${cpu.count ?? '?'} vCPU</span>
                        </div>
                        <!-- Load Average -->
                        <div class="loadavg-row">
                            <div class="loadavg-item">
                                <div class="lv">${cpu.loadavg?.['1m'] ?? '-'}</div>
                                <div class="lt">1m avg</div>
                            </div>
                            <div class="loadavg-item">
                                <div class="lv">${cpu.loadavg?.['5m'] ?? '-'}</div>
                                <div class="lt">5m avg</div>
                            </div>
                            <div class="loadavg-item">
                                <div class="lv">${cpu.loadavg?.['15m'] ?? '-'}</div>
                                <div class="lt">15m avg</div>
                            </div>
                        </div>
                    </div>

                    <!-- Memory Card -->
                    <div class="resource-card">
                        <div class="resource-card-top">
                            <div class="resource-label"><i class="fa-solid fa-memory"></i>メモリ</div>
                            <div class="resource-value">${memPct}<span class="resource-unit">%</span></div>
                        </div>
                        <div class="resource-bar-wrap">
                            <div class="resource-bar mem ${barClass(memPct, 'mem')}" style="width:${memPct}%"></div>
                        </div>
                        <div class="resource-sub">
                            <span>使用: ${fmtBytes(mem.used ?? 0)}</span>
                            <span>合計: ${fmtBytes(mem.total ?? 0)}</span>
                        </div>
                    </div>

                    <!-- Process Card -->
                    <div class="resource-card">
                        <div class="resource-card-top">
                            <div class="resource-label"><i class="fa-brands fa-node-js"></i>Node.jsプロセス</div>
                            <div class="resource-value">${fmtBytes(proc.rss ?? 0)}</div>
                        </div>
                        <div class="resource-bar-wrap">
                            <div class="resource-bar proc ${barClass(procPct, 'proc')}" style="width:${Math.min(procPct * 5, 100)}%"></div>
                        </div>
                        <div class="resource-sub">
                            <span>Heap: ${fmtBytes(proc.heapUsed ?? 0)} / ${fmtBytes(proc.heapTotal ?? 0)}</span>
                            <span>起動: ${fmtUptime(proc.uptimeSec ?? 0)}</span>
                        </div>
                    </div>

                    <!-- OS Uptime Card -->
                    <div class="resource-card">
                        <div class="resource-card-top">
                            <div class="resource-label"><i class="fa-solid fa-clock-rotate-left"></i>OS 稼働時間</div>
                            <div class="resource-value" style="font-size:1.1rem">${fmtUptime(dOs.uptimeSec ?? 0)}</div>
                        </div>
                        <div class="resource-sub" style="margin-top:4px">
                            <span>稼働: ${fmtUptime(dOs.uptimeSec ?? 0)}</span>
                        </div>
                    </div>
                `;
            } catch (e) {
                grid.innerHTML = '<div class="ai-muted">リソース情報を取得できませんでした</div>';
            }
        }

        async function loadStatus() {
            const grid = document.getElementById('status-grid');
            try {
                const res = await fetchWithRetry('/api/scraper-status');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                const items = data.items || [];

                if (items.length === 0) {
                    grid.innerHTML = '<div class="ai-muted" style="grid-column:1/-1;text-align:center">No statistics reported yet. Processes might be starting...</div>';
                    return;
                }

                grid.innerHTML = items.map(item => {
                    const lastRunMs = item.last_run ? new Date(item.last_run).getTime() : 0;
                    const staleSec  = (Date.now() - lastRunMs) / 1000;
                    const isStaleRunning = item.status === 'running' && staleSec > 180;

                    const effectiveStatus = isStaleRunning ? 'success' : (item.status || 'unknown');
                    const statusClass = effectiveStatus === 'success' ? 'ok' : effectiveStatus;
                    const statusText  = effectiveStatus === 'success' ? 'Healthy'
                                      : effectiveStatus === 'running' ? 'Active'
                                      : effectiveStatus === 'degraded' ? 'Degraded'
                                      : effectiveStatus === 'error'   ? 'Critical'
                                      : 'Unknown';

                    // 名前・ID・メッセージは innerHTML に入れているので必ず esc する
                    // （scraper-status は公開のエンドポイントで、内容も外部由来しうるため）
                    return `
                        <div class="status-card">
                            <div class="status-card-top">
                                <div class="status-name">${esc(item.name || item.id)}</div>
                                <div class="status-badge ${statusClass}">${statusText}</div>
                            </div>
                            <div class="status-info">
                                最終実行: ${timeAgo(item.last_run)}
                            </div>
                            <div class="status-time">
                                ID: ${esc(item.id)} <br>
                                更新: ${new Date(item.updated_at).toLocaleString('ja-JP')}
                            </div>
                            ${item.message ? `<div class="status-error-msg">${esc(item.message)}</div>` : ''}
                        </div>
                    `;
                }).join('');

            } catch (e) {
                grid.innerHTML = '<div class="ai-muted" style="color:#ff8a80">Failed to load status. Please try again.</div>';
            }
        }

        function esc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // レート制限ヘッダは取得できているものだけ表示（未取得なら「未取得」）
        function hdrBlock(headers) {
            if (!headers || !Object.keys(headers).length) {
                return '<div class="ai-muted">ヘッダ未取得（次回のAI呼び出し以降に記録）</div>';
            }
            return '<div class="ai-kv">' + Object.entries(headers)
                .map(([k, v]) => `<div class="ai-kv-row"><span class="ai-kv-key">${esc(k)}</span><span class="ai-kv-val">${esc(v)}</span></div>`)
                .join('') + '</div>';
        }

        function dailyBars(daily) {
            if (!daily || !daily.length) return '';
            const max = Math.max(1, ...daily.map(d => d.count));
            return `<div class="ai-daily">` + daily.map(d => {
                const n = Number(d.count) || 0;
                const h = n > 0 ? Math.max(5, Math.round((n / max) * 26)) : 3;
                return `<div class="ai-daily-cell" title="${esc(d.date)}: ${n} 件">
                    <div class="ai-daily-count${n ? '' : ' is-zero'}">${n}</div>
                    <div class="ai-daily-barwrap"><div class="ai-daily-bar${n ? '' : ' is-zero'}" style="height:${h}px"></div></div>
                    <div class="ai-daily-date">${esc(String(d.date).slice(5))}</div>
                </div>`;
            }).join('') + `</div>`;
        }

        function fmtNum(n) {
            if (n == null || n === '' || isNaN(Number(n))) return String(n ?? '—');
            const v = Number(n);
            return v.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
        }

        async function loadAiUsage() {
            const grid = document.getElementById('ai-grid');
            if (!grid) return;
            try {
                const res = await fetchWithRetry('/api/ai-usage');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const d = await res.json();

                const cf   = d.cloudflare || {};
                const gm   = d.gemini || {};
                const gq   = d.groq || {};
                const chat = d.chat || {};
                const mn   = d.minutes || {};
                const wh   = d.whisper || {};

                const cfPct = Math.min(Number(cf.pct) || 0, 100);
                const cfUsed = fmtNum(cf.used ?? 0);
                const cfRemain = cf.remaining == null ? '—' : fmtNum(cf.remaining);
                const e429 = gm.errors429 || 0;

                grid.innerHTML = `
                    <!-- Cloudflare Workers AI -->
                    <div class="resource-card">
                        <div class="resource-card-top">
                            <div class="resource-label"><i class="fa-solid fa-cloud"></i>Cloudflare AI</div>
                            <div class="resource-value">${cfUsed}</div>
                        </div>
                        <div class="resource-bar-wrap">
                            <div class="resource-bar cpu ${barClass(cfPct, 'cpu')}" style="width:${cfPct}%"></div>
                        </div>
                        <div class="resource-sub">
                            <span>残り <b>${cfRemain}</b> neurons（${cfPct}% 使用）</span>
                            <span>上限 ${fmtNum(cf.budget)} ・ 無料枠 ${fmtNum(cf.freeTier ?? 10000)} / 日</span>
                        </div>
                        <div class="ai-muted">用途: 要約生成 ・ ${cf.stale ? (cf.day ? `※ ${esc(cf.day)} 時点の値（以降使用なし・UTC日次リセット）` : '※ 使用記録なし') : '日次: ' + esc(cf.day || '—')}</div>
                    </div>

                    <!-- Gemini -->
                    <div class="resource-card">
                        <div class="resource-card-top">
                            <div class="resource-label"><i class="fa-solid fa-gem"></i>Gemini（ツイート解析）</div>
                            <div class="resource-value">${fmtNum(gm.calls ?? 0)}<span class="resource-unit">回</span></div>
                        </div>
                        <div class="resource-sub">
                            <span>429（上限超過）: <b class="${e429 > 0 ? 'ai-alert' : 'ai-ok'}">${e429} 回</b></span>
                            <span>予備モデル切替: ${gm.fallback ?? 0} 回</span>
                        </div>
                        ${hdrBlock(gm.headers)}
                        ${gm.usage ? `<div class="ai-mono">usage: ${esc(JSON.stringify(gm.usage))}</div>` : ''}
                        ${dailyBars(gm.daily)}
                    </div>

                    <!-- Groq -->
                    <div class="resource-card">
                        <div class="resource-card-top">
                            <div class="resource-label"><i class="fa-solid fa-bolt"></i>Groq（予備 / Whisper）</div>
                            <div class="resource-value">${fmtNum(gq.calls ?? 0)}<span class="resource-unit">回記録</span></div>
                        </div>
                        <div class="resource-sub">
                            <span>レスポンス: <span class="ai-mono">${gq.statuses ? esc(JSON.stringify(gq.statuses)) : '—'}</span></span>
                        </div>
                        <div class="resource-sub">
                            <span>無料枠: <b>20</b> req/分 ・ <b>2,000</b> req/日</span>
                            <span>音声 <b>7,200</b> 秒/時 ・ <b>28,800</b> 秒/日</span>
                        </div>
                        ${hdrBlock(gq.headers)}
                        <div class="resource-sub">
                            <span>Whisper 字幕（本番）: <b>${fmtNum(wh.segments ?? 0)}</b> セグメント / <b>${fmtNum(Math.round((wh.seconds ?? 0) / 60))}</b> 分</span>
                        </div>
                    </div>

                    <!-- まいAIチャット -->
                    <div class="resource-card">
                        <div class="resource-card-top">
                            <div class="resource-label"><i class="fa-solid fa-comments"></i>まいAI（チャット）</div>
                            <div class="resource-value">${fmtNum(chat.total ?? 0)}<span class="resource-unit">件</span></div>
                        </div>
                        <div class="resource-sub">
                            <span>要約: <b>${fmtNum(mn.videos ?? 0)}</b> 本（5分チャンク単位）</span>
                        </div>
                        ${dailyBars(chat.daily)}
                    </div>
                `;
            } catch (e) {
                grid.innerHTML = '<div class="ai-muted">AI 使用量を取得できませんでした</div>';
            }
        }

        async function loadAll() {
            const btn = document.querySelector('.status-refresh-btn');
            if (btn) btn.disabled = true;
            await Promise.all([loadSystemInfo(), loadStatus(), loadAiUsage()]);
            if (btn) btn.disabled = false;
        }

        document.addEventListener('DOMContentLoaded', loadAll);
        // 30秒ごとに自動更新
        setInterval(loadAll, 30000);
    