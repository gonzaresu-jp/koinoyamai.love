// admin「ハニーポット」タブ: 偽の秘密ファイルへのアクセスを可視化する
// GET /api/admin/honeypot?days=7 を描画する（管理画面専用・tailnet 限定）。
// 攻撃者が制御できる値（パス・UA）を innerHTML に入れるので、必ず esc() を通す。
(function () {
  const root = document.getElementById("honeypot");
  if (!root) return;

  const C = { stolen: "#d93f3f", canary: "#7a1010", probe: "#5b7cfa", muted: "#9aa0a6", sub: "#7F2534" };
  const KIND_LABEL = { stolen: "取得", canary_used: "canary 使用", probe: "偵察" };
  let days = 7;
  let loading = false;
  let last = null;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function flag(cc) {
    if (!/^[A-Z]{2}$/.test(String(cc || ""))) return "🏳️";
    return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  }

  function clock(iso) {
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(String(iso || ""));
    return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : String(iso || "");
  }

  function orgShort(org) {
    const s = String(org || "").replace(/,\s*[A-Z]{2}$/, "");
    return s.length > 28 ? s.slice(0, 28) + "…" : s;
  }

  function card(label, icon, value, note, color) {
    return `<div style="flex:1; min-width:150px; background:#faf5f8; border:1px solid #f0dae4; border-radius:12px; padding:12px 14px;">
      <div style="font-size:.74rem; color:#8a5570; font-weight:700;"><i class="fa-solid ${icon}"></i> ${esc(label)}</div>
      <div style="font-size:1.55rem; font-weight:800; color:${color || "#2c2c3e"}; line-height:1.25; font-variant-numeric:tabular-nums;">${value}</div>
      <div style="font-size:.7rem; color:#888; line-height:1.45;">${note}</div>
    </div>`;
  }

  function block(title, inner, note) {
    return `<div style="background:#fff; border:1px solid #eee; border-radius:12px; padding:12px 14px; min-width:0;">
      <div style="font-weight:800; font-size:.9rem; color:${C.sub}; margin-bottom:4px;">${esc(title)}</div>
      ${note ? `<div style="color:#999; font-size:.7rem; margin-bottom:8px;">${note}</div>` : ""}
      ${inner}
    </div>`;
  }

  function countryRows(list) {
    if (!list.length) return `<div style="color:#999; font-size:.82rem;">データがありません</div>`;
    const max = Math.max(1, ...list.map((c) => c.events));
    return list.map((c) => {
      const org = c.orgs && c.orgs[0] ? esc(String(c.orgs[0].org).replace(/,\s*[A-Z]{2}$/, "")) : "";
      const sw = Math.round((c.stolen / max) * 100);
      const pw = Math.round((c.probe / max) * 100);
      return `<div style="margin:9px 0;">
        <div style="display:flex; align-items:center; gap:8px; font-size:.84rem;">
          <span style="width:22px; font-size:1.05rem; line-height:1;">${flag(c.cc)}</span>
          <span style="font-weight:700; min-width:104px;">${esc(c.country)}</span>
          <span style="flex:1; min-width:40px; height:11px; background:#f1eef3; border-radius:6px; overflow:hidden; display:flex;">
            <span style="width:${sw}%; background:${C.stolen};"></span>
            <span style="width:${pw}%; background:${C.probe};"></span>
          </span>
          <span style="width:52px; text-align:right; font-weight:700; font-variant-numeric:tabular-nums;">${c.events} 件</span>
        </div>
        <div style="margin-left:30px; font-size:.7rem; color:#999;">
          ${c.ips} IP${c.stolen ? ` ・ <span style="color:${C.stolen}; font-weight:700;">取得 ${c.stolen}</span>` : ""}${org ? ` ・ ${org}` : ""}
        </div>
      </div>`;
    }).join("");
  }

  function dailyChart(series) {
    const daysArr = series.slice(-14);
    if (!daysArr.length) return `<div style="color:#999; font-size:.82rem;">データがありません</div>`;
    const max = Math.max(1, ...daysArr.map((d) => d.events));
    const H = 96;
    const bars = daysArr.map((d, i) => {
      const hs = Math.round((d.stolen / max) * H);
      const hp = Math.round((d.probe / max) * H);
      const hc = Math.round((d.canaryUsed / max) * H);
      const label = i % 2 === 0 ? esc(d.date.slice(5)) : "&nbsp;";
      return `<div style="flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:stretch; min-width:0;"
          title="${esc(d.date)}: 取得 ${d.stolen} / 偵察 ${d.probe}${d.canaryUsed ? ` / canary ${d.canaryUsed}` : ""}">
        <div style="flex:1; display:flex; flex-direction:column; justify-content:flex-end; height:${H}px;">
          ${hc ? `<div style="height:${hc}px; background:${C.canary};"></div>` : ""}
          ${hs ? `<div style="height:${hs}px; background:${C.stolen};"></div>` : ""}
          ${hp ? `<div style="height:${hp}px; background:${C.probe};"></div>` : ""}
        </div>
        <div style="font-size:.6rem; color:#aaa; text-align:center; margin-top:3px; white-space:nowrap;">${label}</div>
      </div>`;
    }).join("");
    return `<div style="display:flex; gap:3px; align-items:flex-end;">${bars}</div>
      <div style="display:flex; gap:12px; flex-wrap:wrap; font-size:.7rem; color:#666; margin-top:6px;">
        <span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${C.stolen};margin-right:4px;"></i>取得</span>
        <span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${C.probe};margin-right:4px;"></i>偵察</span>
        <span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${C.canary};margin-right:4px;"></i>canary 使用</span>
      </div>`;
  }

  function pathRows(list) {
    if (!list.length) return `<div style="color:#999; font-size:.82rem;">データがありません</div>`;
    const max = Math.max(1, ...list.map((p) => p.events));
    return list.map((p) => {
      const w = Math.round((p.events / max) * 100);
      const col = p.stolen ? C.stolen : C.probe;
      return `<div style="display:flex; align-items:center; gap:8px; margin:5px 0; font-size:.78rem;">
        <span style="flex:1; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(p.path)}">${esc(p.path)}</span>
        <span style="width:74px; height:8px; background:#f1eef3; border-radius:4px; overflow:hidden;">
          <span style="display:block; width:${w}%; height:100%; background:${col};"></span>
        </span>
        <span style="width:46px; text-align:right; font-variant-numeric:tabular-nums; color:#666;">${p.events} 件</span>
      </div>`;
    }).join("");
  }

  function kindBadge(kind) {
    const map = {
      stolen: { bg: "#fdecec", fg: "#b3261e", bd: "#f7c9c6" },
      canary_used: { bg: "#7a1010", fg: "#fff", bd: "#7a1010" },
      probe: { bg: "#eef1fe", fg: "#3b4fbb", bd: "#cfd6fb" },
    };
    const s = map[kind] || map.probe;
    return `<span style="display:inline-block; padding:1px 7px; border-radius:99px; font-size:.68rem; font-weight:700; background:${s.bg}; color:${s.fg}; border:1px solid ${s.bd};">${esc(KIND_LABEL[kind] || kind)}</span>`;
  }

  function eventTable(rows) {
    if (!rows.length) return `<div style="color:#999; font-size:.82rem;">データがありません</div>`;
    const body = rows.map((r) => `<tr>
      <td style="white-space:nowrap; font-size:.74rem; color:#666;">${esc(clock(r.time))}</td>
      <td style="white-space:nowrap;" title="${esc(r.country)}">${flag(r.cc)} <span style="font-size:.7rem; color:#888;">${esc(r.cc || "??")}</span></td>
      <td style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.72rem; white-space:nowrap;">${esc(r.ip)}</td>
      <td style="font-size:.7rem; color:#888; max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(r.org || "")}">${esc(orgShort(r.org))}</td>
      <td>${kindBadge(r.kind)}</td>
      <td style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.72rem; max-width:230px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(r.path)}">${esc(r.path)}</td>
      <td style="text-align:right; font-size:.72rem; color:#666;">${r.status}</td>
      <td style="font-size:.68rem; color:#aaa; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(r.ua)}">${esc(r.ua)}</td>
    </tr>`).join("");
    return `<div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:.8rem;">
        <thead><tr style="text-align:left; color:#888; font-size:.68rem; border-bottom:1px solid #eee;">
          <th style="padding:4px 6px; font-weight:700;">時刻</th><th style="padding:4px 6px; font-weight:700;">国</th>
          <th style="padding:4px 6px; font-weight:700;">IP</th><th style="padding:4px 6px; font-weight:700;">組織</th>
          <th style="padding:4px 6px; font-weight:700;">種別</th><th style="padding:4px 6px; font-weight:700;">パス</th>
          <th style="padding:4px 6px; font-weight:700; text-align:right;">st</th><th style="padding:4px 6px; font-weight:700;">UA</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  }

  function header(d) {
    const updated = d.generatedAt ? new Date(d.generatedAt) : new Date();
    const hhmm = updated.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const btn = (v, label) => `<button type="button" class="btn-secondary hp-range" data-days="${v}"
      style="padding:3px 10px; font-size:.76rem; ${days === v ? "border-color:#B11E7C; color:#B11E7C; font-weight:800;" : ""}">${label}</button>`;
    return `<div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:10px;">
      ${btn(1, "24時間")}${btn(7, "7日")}${btn(30, "30日")}${btn(90, "90日")}
      <span style="font-size:.72rem; color:#999; margin-left:auto;">最終更新 ${esc(hhmm)}（60秒ごと）</span>
      <button type="button" class="btn-secondary" id="hp-reload" style="padding:3px 10px; font-size:.76rem;"><i class="fa-solid fa-rotate"></i> 更新</button>
    </div>`;
  }

  function render(d) {
    const t = d.totals || {};
    const s = d.source || {};
    const empty = !t.events;
    const note = d.note ? `<div style="font-size:.7rem; color:#aaa; margin-top:10px;">${esc(d.note)}</div>` : "";
    const exact = s.firstSeen && s.lastSeen
      ? `期間内 ${clock(s.firstSeen)} 〜 ${clock(s.lastSeen)}`
      : "期間内のアクセスなし";
    const kpis = `<div style="display:flex; gap:10px; flex-wrap:wrap;">
      ${card("総ヒット", "fa-shield-halved", t.events || 0, exact)}
      ${card("取得（偽物を渡した）", "fa-file-arrow-down", t.stolen || 0, "200 で配信", C.stolen)}
      ${card("canary 使用", "fa-bullseye", t.canaryUsed || 0, t.canaryUsed ? "窃取確定（中身を使った）" : "まだ使用なし", C.canary)}
      ${card("偵察", "fa-magnifying-glass", t.probe || 0, `${t.canaryScans || 0} 件は /_canary/ の探査`)}
      ${card("ユニーク IP", "fa-network-wired", t.ips || 0, `${t.countries || 0} か国`)}
    </div>`;

    const main = `<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(330px, 1fr)); gap:12px; margin-top:12px;">
      ${block("どこから来ているか", countryRows(d.byCountry || []), "国・組織は Team Cymru の DNS（30 日キャッシュ）")}
      ${block("日別の推移", dailyChart(d.byDay || []), "赤=取得 / 青=偵察 / 濃赤=canary")}
    </div>`;

    const paths = `<div style="margin-top:12px;">${block("よく狙われるパス", pathRows(d.topPaths || []), "上位 15 件")}</div>`;
    const table = `<div style="margin-top:12px;">${block(`最近のヒット（${(d.recent || []).length} 件）`, eventTable(d.recent || []), "自機テスト（127.0.0.1 かつ Cloudflare ヘッダ無し）は除外")}</div>`;

    root.innerHTML = header(d) + kpis + (empty
      ? `<div style="margin-top:14px; padding:16px; background:#f7f7f9; border-radius:10px; color:#888; font-size:.86rem;">この期間のハニーポットへのアクセスはありません。</div>`
      : main + paths + table) + note;

    root.querySelectorAll(".hp-range").forEach((b) => {
      b.addEventListener("click", () => {
        const v = Number(b.dataset.days);
        if (v && v !== days) { days = v; load(); }
      });
    });
    const reload = document.getElementById("hp-reload");
    if (reload) reload.addEventListener("click", () => load());
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch(`/api/admin/honeypot?days=${days}`, { credentials: "same-origin" });
      if (!res.ok) {
        root.innerHTML = `<div style="padding:14px; background:#fdecec; border:1px solid #f7c9c6; border-radius:10px; color:#b3261e; font-size:.85rem;">
          取得に失敗しました（HTTP ${res.status}）。管理画面の認証・tailnet 接続を確認してください。</div>`;
        return;
      }
      const d = await res.json();
      last = d;
      render(d);
    } catch (e) {
      root.innerHTML = `<div style="padding:14px; background:#fdecec; border:1px solid #f7c9c6; border-radius:10px; color:#b3261e; font-size:.85rem;">取得に失敗しました: ${esc(e && e.message)}</div>`;
    } finally {
      loading = false;
    }
  }

  // タブを開いたときにも取り直す（60 秒待たない）
  document.querySelectorAll('.admin-tab[data-tab="honeypot"]').forEach((b) => {
    b.addEventListener("click", () => { load(); });
  });

  load();
  setInterval(() => { if (!document.hidden) load(); }, 60000);
})();
