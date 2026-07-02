// ── Radiology statistics (manager dashboard) ─────────────────────────────────
// Live, read-only view of radiology requests across all branches, pulled from
// Siratech HIS through the connector (/api/radiology/stats). Clearly divided:
// totals + priority KPIs, then branch · modality · ordering doctor · department ·
// pending-age · daily trend. Date-range presets + branch filter + auto-refresh.
//
// The paid/unpaid *collection* split is added later from the billing report; a
// banner marks it as pending so managers know what this view does and doesn't
// yet cover.

let radstats = {
  from: '', to: '', preset: '30d',
  branches: [], sel: null,           // sel = Set of selected siteIds (null = all)
  data: null, loading: false,
  modData: null, modLoading: false, modError: '',
  finData: null, finLoading: false, finError: '',
  auto: false, timer: null, lastError: '',
};

const RS_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
];

function rsFmtDate(d) { return d.toISOString().slice(0, 10); }

function rsPresetRange(id) {
  const now = new Date();
  const end = rsFmtDate(now);
  if (id === 'today') return { from: end, to: end };
  if (id === '7d') return { from: rsFmtDate(new Date(now.getTime() - 6 * 864e5)), to: end };
  if (id === 'month') return { from: end.slice(0, 8) + '01', to: end };
  return { from: rsFmtDate(new Date(now.getTime() - 29 * 864e5)), to: end }; // 30d
}

async function renderRadStatsPage() {
  setTopbar('Radiology statistics', 'Live requests across all branches');
  rsStopAuto();
  if (radstats.preset && radstats.preset !== 'custom') {
    const r = rsPresetRange(radstats.preset);
    radstats.from = r.from; radstats.to = r.to;
  }
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Radiology', 'Radiology statistics', 'Live request volume by branch, modality, doctor and department — straight from Siratech HIS')}
    <div id="rs-controls"></div>
    <div id="rs-billing-banner"></div>
    <div id="rs-body">${LOADING_HTML}</div>`;
  rsRenderControls();
  rsLoadBranches();            // populate the branch picker (once), then it stays
  await rsLoad();
}

// Load the real branch list so the picker shows every branch by name.
async function rsLoadBranches() {
  if (radstats.branches.length) { rsRenderControls(); return; }
  try {
    const d = await API.get('/radiology/branches');
    radstats.branches = (d && d.branches) || [];
  } catch (e) { /* picker just stays hidden; stats still default to all */ }
  rsRenderControls();
}

// null selection (or all selected) means "all branches" → send no sites param.
function rsSitesParam() {
  if (!radstats.sel || !radstats.branches.length) return '';
  if (radstats.sel.size === radstats.branches.length) return '';
  return [...radstats.sel].join(',');
}

function rsRenderControls() {
  const box = document.getElementById('rs-controls');
  if (!box) return;
  const presets = RS_PRESETS.map((p) =>
    `<button class="rs-chip${radstats.preset === p.id ? ' on' : ''}" onclick="rsSetPreset('${p.id}')">${p.label}</button>`).join('');
  box.innerHTML = `
    <div class="card rs-controls">
      <div class="rs-ctl-row">
        <div class="rs-presets">${presets}</div>
        <div class="rs-dates">
          <label>From <input type="date" id="rs-from" value="${escapeHtml(radstats.from)}" onchange="rsSetCustom()"></label>
          <label>To <input type="date" id="rs-to" value="${escapeHtml(radstats.to)}" onchange="rsSetCustom()"></label>
        </div>
        <div class="rs-ctl-actions">
          <label class="rs-auto"><input type="checkbox" id="rs-auto" ${radstats.auto ? 'checked' : ''} onchange="rsToggleAuto()"> Auto</label>
          <button class="btn btn-primary btn-sm" onclick="rsLoad()" ${radstats.loading ? 'disabled' : ''}>${radstats.loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>
      ${rsBranchPicker()}
    </div>`;
}

function rsBranchPicker() {
  if (!radstats.branches.length) return '';
  const all = !radstats.sel || radstats.sel.size === radstats.branches.length;
  const chips = radstats.branches.map((b) => {
    const on = all || (radstats.sel && radstats.sel.has(b.siteId));
    return `<button class="rs-bchip${on ? ' on' : ''}" onclick="rsToggleBranch(${b.siteId})" title="${escapeHtml(b.name)}">${escapeHtml(b.shortName || b.name)}</button>`;
  }).join('');
  return `<div class="rs-branches">
      <span class="rs-branches-lbl">Branches</span>
      <button class="rs-bchip rs-ball${all ? ' on' : ''}" onclick="rsAllBranches()">All (${radstats.branches.length})</button>
      ${chips}
    </div>`;
}

function rsAllBranches() { radstats.sel = null; rsRenderControls(); rsLoad(); }
function rsToggleBranch(id) {
  if (!radstats.sel) radstats.sel = new Set(radstats.branches.map((b) => b.siteId));  // start from "all"
  if (radstats.sel.has(id)) radstats.sel.delete(id); else radstats.sel.add(id);
  if (radstats.sel.size === 0) radstats.sel = null;                                    // never allow empty → all
  rsRenderControls();
  rsLoad();
}

function rsSetPreset(id) {
  radstats.preset = id;
  const r = rsPresetRange(id);
  radstats.from = r.from; radstats.to = r.to;
  rsRenderControls();
  rsLoad();
}
function rsSetCustom() {
  const f = document.getElementById('rs-from'), t = document.getElementById('rs-to');
  radstats.from = (f && f.value) || radstats.from;
  radstats.to = (t && t.value) || radstats.to;
  radstats.preset = 'custom';
  rsRenderControls();
  rsLoad();
}
function rsToggleAuto() {
  radstats.auto = !radstats.auto;
  if (radstats.auto) rsStartAuto(); else rsStopAuto();
}
function rsStartAuto() {
  rsStopAuto();
  radstats.timer = setInterval(() => {
    if (typeof currentPage !== 'undefined' && currentPage !== 'radstats') { rsStopAuto(); return; }
    if (!document.getElementById('rs-body')) { rsStopAuto(); return; }
    rsLoad(true);
  }, 60000);
}
function rsStopAuto() { if (radstats.timer) { clearInterval(radstats.timer); radstats.timer = null; } }

async function rsLoad(silent) {
  radstats.loading = true;
  radstats.lastError = '';
  if (!silent) rsRenderControls();
  const q = new URLSearchParams();
  if (radstats.from) q.set('from', radstats.from);
  if (radstats.to) q.set('to', radstats.to);
  const _s = rsSitesParam(); if (_s) q.set('sites', _s);
  // Any filter change invalidates the (separately-loaded) modality & finance data.
  radstats.modData = null; radstats.modError = ''; radstats.modLoading = false;
  radstats.finData = null; radstats.finError = ''; radstats.finLoading = false;
  try {
    const d = await API.get('/radiology/stats?' + q.toString());
    radstats.data = d;
  } catch (e) {
    radstats.lastError = (e && e.message) || 'Could not load statistics';
  } finally {
    radstats.loading = false;
    rsRenderControls();
    rsRenderBody();
  }
}

// Exact modality mix is slower (per-order detail calls), so it loads on demand.
async function rsLoadModality() {
  if (radstats.modLoading) return;
  radstats.modLoading = true; radstats.modError = '';
  rsRenderBody();
  const q = new URLSearchParams();
  if (radstats.from) q.set('from', radstats.from);
  if (radstats.to) q.set('to', radstats.to);
  const _s = rsSitesParam(); if (_s) q.set('sites', _s);
  q.set('modality', '1');
  try {
    const d = await API.get('/radiology/stats?' + q.toString());
    radstats.modData = d.modality || { mix: [], sampled: 0, ofTotal: 0 };
  } catch (e) {
    radstats.modError = (e && e.message) || 'Could not load modality mix';
  } finally {
    radstats.modLoading = false;
    rsRenderBody();
  }
}

// Revenue & payer split is slower (per-order bill reads), so it loads on demand.
async function rsLoadFinancial() {
  if (radstats.finLoading) return;
  radstats.finLoading = true; radstats.finError = '';
  rsRenderBody();
  const q = new URLSearchParams();
  if (radstats.from) q.set('from', radstats.from);
  if (radstats.to) q.set('to', radstats.to);
  const _s = rsSitesParam(); if (_s) q.set('sites', _s);
  q.set('financial', '1');
  try {
    const d = await API.get('/radiology/stats?' + q.toString());
    radstats.finData = d.financial || { revenue: 0, patient: 0, sponsor: 0, sampled: 0, ofTotal: 0 };
  } catch (e) {
    radstats.finError = (e && e.message) || 'Could not load revenue';
  } finally {
    radstats.finLoading = false;
    rsRenderBody();
  }
}

// ── rendering ─────────────────────────────────────────────────────────────────
const RS_MOD_COLOR = { CT: '#6B4EFF', MRI: '#0ea5e9', 'X-Ray': '#22c55e', Ultrasound: '#f59e0b', Mammography: '#ec4899', 'DEXA / Bone Density': '#14b8a6', Fluoroscopy: '#8b5cf6', Other: '#94a3b8' };
const rsNum = (n) => Number(n || 0).toLocaleString();
const rsPct = (n, of) => (of ? Math.round((n / of) * 100) : 0);

function rsBarRows(items, color, max0) {
  if (!items || !items.length) return `<div class="rs-empty">No data</div>`;
  const total = items.reduce((a, i) => a + i.count, 0);
  const max = max0 || Math.max(1, ...items.map((i) => i.count));
  return `<div class="rs-bars">` + items.map((i) => {
    const label = escapeHtml(String(i.label == null || i.label === '' ? 'Unknown' : i.label));
    const pct = Math.round((i.count / max) * 100);
    const col = typeof color === 'function' ? color(i) : (color || 'var(--accent)');
    return `<div class="rs-bar">
      <div class="rs-bar-label" title="${label}">${label}</div>
      <div class="rs-bar-track"><div class="rs-bar-fill" style="width:${pct}%;background:${col}"></div></div>
      <div class="rs-bar-val">${rsNum(i.count)}<span class="rs-bar-share">${rsPct(i.count, total)}%</span></div>
    </div>`;
  }).join('') + `</div>`;
}

// Lightweight SVG donut with a legend — no chart library.
function rsDonut(segs, opts) {
  segs = (segs || []).filter((s) => s.count > 0);
  const total = segs.reduce((a, s) => a + s.count, 0);
  if (!total) return `<div class="rs-empty">No data</div>`;
  const R = 54, C = 2 * Math.PI * R, cx = 70, cy = 70, sw = 20;
  let off = 0;
  const arcs = segs.map((s) => {
    const len = (s.count / total) * C;
    const el = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${sw}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cy})">
      <title>${escapeHtml(s.label)}: ${rsNum(s.count)} (${rsPct(s.count, total)}%)</title></circle>`;
    off += len; return el;
  }).join('');
  const legend = segs.map((s) => `<div class="rs-leg">
      <span class="rs-leg-dot" style="background:${s.color}"></span>
      <span class="rs-leg-l" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</span>
      <span class="rs-leg-v">${rsNum(s.count)} · ${rsPct(s.count, total)}%</span></div>`).join('');
  const cVal = opts && opts.centerVal != null ? opts.centerVal : total;
  return `<div class="rs-donut-wrap">
    <svg viewBox="0 0 140 140" class="rs-donut">${arcs}
      <text x="70" y="67" text-anchor="middle" class="rs-donut-n">${rsNum(cVal)}</text>
      <text x="70" y="85" text-anchor="middle" class="rs-donut-l">${escapeHtml((opts && opts.centerLabel) || 'total')}</text>
    </svg>
    <div class="rs-legend">${legend}</div>
  </div>`;
}

// Smooth-ish area + line trend with gridlines and hover dots.
function rsArea(daily) {
  if (!daily || !daily.length) return `<div class="rs-empty">No data</div>`;
  const W = 720, H = 180, pad = 30, n = daily.length;
  const max = Math.max(1, ...daily.map((x) => x.count));
  const X = (i) => pad + (n <= 1 ? (W - 2 * pad) / 2 : (i / (n - 1)) * (W - 2 * pad));
  const Y = (v) => H - pad - (v / max) * (H - 2 * pad);
  const pts = daily.map((x, i) => `${X(i).toFixed(1)},${Y(x.count).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `M${X(0).toFixed(1)},${H - pad} L${pts.join(' L')} L${X(n - 1).toFixed(1)},${H - pad} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = H - pad - f * (H - 2 * pad);
    return `<line x1="${pad}" y1="${y}" x2="${W - pad}" y2="${y}" class="rs-grid"/><text x="${pad - 6}" y="${y + 3}" text-anchor="end" class="rs-axis">${Math.round(max * f)}</text>`;
  }).join('');
  const dots = daily.map((x, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(x.count).toFixed(1)}" r="3" class="rs-dot"><title>${escapeHtml(x.date)}: ${x.count}</title></circle>`).join('');
  const idxs = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  const xl = idxs.map((i) => `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="rs-axis">${escapeHtml(daily[i].date.slice(5))}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="rs-area">
    <defs><linearGradient id="rsg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#rsg)"/><path d="${line}" class="rs-line"/>${dots}${xl}
  </svg>`;
}

function rsPanel(title, inner, sub, cls) {
  return `<div class="card rs-panel${cls ? ' ' + cls : ''}">
    <div class="rs-panel-head"><h3>${escapeHtml(title)}</h3>${sub ? `<span class="rs-panel-sub">${escapeHtml(sub)}</span>` : ''}</div>
    ${inner}
  </div>`;
}

const RS_ICON = {
  total: '<path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 4-5"/>',
  emg: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/>',
  rtn: '<path d="M20 6 9 17l-5-5"/>',
  aged: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  branch: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/>',
};
function rsKpi(icon, val, label, cls, sub) {
  return `<div class="rs-kpi${cls ? ' ' + cls : ''}">
    <span class="rs-kpi-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${RS_ICON[icon] || ''}</svg></span>
    <div><div class="rs-kpi-n">${val}</div><div class="rs-kpi-l">${label}${sub ? ` <span class="rs-kpi-sub">${sub}</span>` : ''}</div></div>
  </div>`;
}

function rsRenderBody() {
  const body = document.getElementById('rs-body');
  const banner = document.getElementById('rs-billing-banner');
  if (!body) return;

  if (banner) {
    banner.innerHTML = `<div class="rs-note">
      <b>Operational view (live).</b> Numbers below are radiology requests registered in the RIS worklist per branch.
      The <b>paid / unpaid collection split</b> and revenue are added next from the billing report.
    </div>`;
  }

  if (radstats.lastError) {
    body.innerHTML = `<div class="card"><div class="empty" style="padding:26px 16px">
      <div class="empty-icon">⚠️</div>
      <div class="empty-title">Couldn't load statistics</div>
      <div class="empty-sub">${escapeHtml(radstats.lastError)}</div>
      <button class="btn btn-sm" style="margin-top:12px" onclick="rsLoad()">Retry</button></div></div>`;
    return;
  }
  const d = radstats.data;
  if (!d || !d.ok) { body.innerHTML = `<div class="rs-skel">${LOADING_HTML}</div>`; return; }

  const total = d.total || 0;
  const emg = (d.priority && d.priority.emergency) || 0;
  const rtn = (d.priority && d.priority.routine) || 0;
  const aged = (d.aging && d.aging['>7d']) || 0;
  const sitesOk = (d.sites && d.sites.returned && d.sites.returned.length) || 0;
  const sitesFail = (d.sites && d.sites.failed && d.sites.failed.length) || 0;

  const kpis = `
    <div class="rs-kpis">
      ${rsKpi('total', rsNum(total), 'Total requests')}
      ${rsKpi('emg', rsNum(emg), 'Emergency', 'rs-kpi-red', total ? rsPct(emg, total) + '%' : '')}
      ${rsKpi('rtn', rsNum(rtn), 'Routine', '', total ? rsPct(rtn, total) + '%' : '')}
      ${rsKpi('aged', rsNum(aged), 'Pending &gt; 7 days', aged ? 'rs-kpi-warn' : '')}
      ${rsKpi('branch', rsNum(sitesOk), 'Branches reporting', '', sitesFail ? `<span class="rs-fail">${sitesFail} n/a</span>` : '')}
    </div>`;

  const branchItems = (d.byBranch || []).map((b) => ({ label: b.name || ('Branch ' + b.site), count: b.count }));
  const docItems = (d.byDoctor || []).map((x) => ({ label: x.name, count: x.count }));
  const deptItems = (d.byDepartment || []).map((x) => ({ label: x.name, count: x.count }));
  const agingItems = ['<1d', '1-3d', '3-7d', '>7d'].map((k) => ({ label: k, count: (d.aging && d.aging[k]) || 0 }));
  const agingColor = (i) => i.label === '>7d' ? '#ef4444' : (i.label === '3-7d' ? '#f59e0b' : (i.label === '1-3d' ? '#eab308' : '#22c55e'));
  const prioDonut = rsDonut([
    { label: 'Routine', count: rtn, color: '#22c55e' },
    { label: 'Emergency', count: emg, color: '#ef4444' },
  ], { centerVal: total, centerLabel: 'requests' });

  const layout = `
    <div class="rs-grid2">
      ${rsPanel('Priority split', prioDonut)}
      ${rsPanel('Modality mix', rsModalityInner(), rsModalitySub())}
    </div>
    ${rsPanel('Revenue &amp; payer', rsFinancialInner(), rsFinancialSub(), 'rs-wide')}
    ${rsPanel('Daily trend', rsArea(d.daily || []), `${(d.daily || []).length} days`, 'rs-wide')}
    <div class="rs-grid2">
      ${rsPanel('By branch', rsBarRows(branchItems, 'var(--accent)'), `${branchItems.length} branches`)}
      ${rsPanel('Top ordering doctors', rsBarRows(docItems, '#0ea5e9'), 'top 15')}
    </div>
    <div class="rs-grid2">
      ${rsPanel('By ordering department', rsBarRows(deptItems, '#8358FD'))}
      ${rsPanel('Pending age', rsBarRows(agingItems, agingColor), 'time since order')}
    </div>`;

  const foot = `<div class="rs-foot">Range ${escapeHtml((d.range && d.range.from) || '')} → ${escapeHtml((d.range && d.range.to) || '')}
    · updated ${escapeHtml(rsAgo(d.generatedAt))}${sitesFail ? ` · branches unavailable: ${escapeHtml((d.sites.failed || []).join(', '))}` : ''}</div>`;

  body.innerHTML = kpis + layout + foot;
}

function rsModalitySub() {
  const m = radstats.modData;
  if (!m) return 'exact — click to load';
  return m.truncated ? `sample of ${rsNum(m.sampled)}/${rsNum(m.ofTotal)} orders` : `${rsNum(m.exams || 0)} exams`;
}

function rsModalityInner() {
  if (radstats.modLoading) return `<div class="rs-empty"><span class="mini-spin"></span> Reading exam details…</div>`;
  if (radstats.modError) return `<div class="rs-empty">${escapeHtml(radstats.modError)} <button class="btn btn-sm" onclick="rsLoadModality()">Retry</button></div>`;
  const m = radstats.modData;
  if (!m) {
    return `<div class="rs-modcta">
      <span class="rs-modcta-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg></span>
      <p>Modality is read per order, so it loads on demand.</p>
      <button class="btn btn-primary btn-sm" onclick="rsLoadModality()">Load modality mix</button>
    </div>`;
  }
  if (!m.mix || !m.mix.length) return `<div class="rs-empty">No exam details returned</div>`;
  const segs = m.mix.map((x) => ({ label: x.modality, count: x.count, color: RS_MOD_COLOR[x.modality] || '#94a3b8' }));
  return rsDonut(segs, { centerVal: m.exams, centerLabel: 'exams' });
}

const rsSAR = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' SAR';
function rsFinancialSub() {
  const f = radstats.finData;
  if (!f) return 'insurance vs cash — click to load';
  return f.truncated ? `sample of ${rsNum(f.sampled)}/${rsNum(f.ofTotal)} orders` : `${rsNum(f.items || 0)} items`;
}
function rsFinancialInner() {
  if (radstats.finLoading) return `<div class="rs-empty"><span class="mini-spin"></span> Reading bills…</div>`;
  if (radstats.finError) return `<div class="rs-empty">${escapeHtml(radstats.finError)} <button class="btn btn-sm" onclick="rsLoadFinancial()">Retry</button></div>`;
  const f = radstats.finData;
  if (!f) {
    return `<div class="rs-modcta">
      <span class="rs-modcta-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></span>
      <p>Radiology revenue &amp; insurance-vs-cash split — read per order, so it loads on demand.<br>
      <span style="opacity:.75">Note: your radiology is almost all insurance; this is billed revenue, not collected/settled.</span></p>
      <button class="btn btn-primary btn-sm" onclick="rsLoadFinancial()">Load revenue</button>
    </div>`;
  }
  const donut = rsDonut([
    { label: 'Insurance', count: Math.round(f.sponsor || 0), color: '#6B4EFF' },
    { label: 'Cash / copay', count: Math.round(f.patient || 0), color: '#22c55e' },
  ], { centerVal: Math.round(f.revenue || 0), centerLabel: 'SAR' });
  const brRev = (f.byBranch || []).slice(0, 8).map((b) => ({ label: b.name || ('Branch ' + b.site), count: Math.round(b.revenue) }));
  return `<div class="rs-fin">
    <div class="rs-fin-head">
      <div class="rs-fin-total"><div class="rs-fin-n">${rsSAR(f.revenue)}</div><div class="rs-fin-l">total radiology revenue</div></div>
      <div class="rs-fin-split">
        <span><i style="background:#6B4EFF"></i> Insurance ${rsSAR(f.sponsor)}</span>
        <span><i style="background:#22c55e"></i> Cash/copay ${rsSAR(f.patient)}</span>
      </div>
    </div>
    <div class="rs-grid2" style="margin:0">
      ${donut}
      <div>${rsBarRows(brRev, 'var(--accent)')}</div>
    </div>
  </div>`;
}

function rsAgo(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return 'just now';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}
