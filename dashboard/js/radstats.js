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
  from: '', to: '', sites: '',
  preset: '30d',
  data: null, loading: false,
  modData: null, modLoading: false, modError: '',
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
  await rsLoad();
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
          <input type="text" id="rs-sites" class="rs-sites" placeholder="Branches e.g. 2,11 (blank = all)" value="${escapeHtml(radstats.sites)}" onchange="rsSetSites()">
          <label class="rs-auto"><input type="checkbox" id="rs-auto" ${radstats.auto ? 'checked' : ''} onchange="rsToggleAuto()"> Auto</label>
          <button class="btn btn-primary btn-sm" onclick="rsLoad()" ${radstats.loading ? 'disabled' : ''}>${radstats.loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>
    </div>`;
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
function rsSetSites() {
  const el = document.getElementById('rs-sites');
  radstats.sites = (el && el.value || '').replace(/[^0-9,]/g, '');
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
  if (radstats.sites) q.set('sites', radstats.sites);
  // Any filter change invalidates the (separately-loaded) modality mix.
  radstats.modData = null; radstats.modError = ''; radstats.modLoading = false;
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
  if (radstats.sites) q.set('sites', radstats.sites);
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

// ── rendering ─────────────────────────────────────────────────────────────────
const RS_MOD_COLOR = { CT: '#6B4EFF', MRI: '#0ea5e9', 'X-Ray': '#22c55e', Ultrasound: '#f59e0b', Mammography: '#ec4899', 'DEXA / Bone Density': '#14b8a6', Fluoroscopy: '#8b5cf6', Other: '#94a3b8' };
const rsNum = (n) => Number(n || 0).toLocaleString();

function rsBarRows(items, labelKey, valMax, color) {
  if (!items || !items.length) return `<div class="rs-empty">No data</div>`;
  const max = valMax || Math.max(1, ...items.map((i) => i.count));
  return items.map((i) => {
    const label = escapeHtml(String(i[labelKey] == null || i[labelKey] === '' ? 'Unknown' : i[labelKey]));
    const pct = Math.round((i.count / max) * 100);
    const col = typeof color === 'function' ? color(i) : (color || 'var(--accent)');
    return `<div class="rs-bar">
      <div class="rs-bar-label" title="${label}">${label}</div>
      <div class="rs-bar-track"><div class="rs-bar-fill" style="width:${pct}%;background:${col}"></div></div>
      <div class="rs-bar-val">${rsNum(i.count)}</div>
    </div>`;
  }).join('');
}

function rsPanel(title, inner, sub) {
  return `<div class="card rs-panel">
    <div class="rs-panel-head"><h3>${escapeHtml(title)}</h3>${sub ? `<span class="rs-panel-sub">${escapeHtml(sub)}</span>` : ''}</div>
    ${inner}
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
  if (!d || !d.ok) { body.innerHTML = LOADING_HTML; return; }

  const total = d.total || 0;
  const emg = (d.priority && d.priority.emergency) || 0;
  const rtn = (d.priority && d.priority.routine) || 0;
  const aged = (d.aging && d.aging['>7d']) || 0;
  const sitesOk = (d.sites && d.sites.returned && d.sites.returned.length) || 0;
  const sitesFail = (d.sites && d.sites.failed && d.sites.failed.length) || 0;

  const kpis = `
    <div class="rs-kpis">
      <div class="rs-kpi"><div class="rs-kpi-n">${rsNum(total)}</div><div class="rs-kpi-l">Total requests</div></div>
      <div class="rs-kpi"><div class="rs-kpi-n">${rsNum(emg)}</div><div class="rs-kpi-l">Emergency</div></div>
      <div class="rs-kpi"><div class="rs-kpi-n">${rsNum(rtn)}</div><div class="rs-kpi-l">Routine</div></div>
      <div class="rs-kpi rs-kpi-warn"><div class="rs-kpi-n">${rsNum(aged)}</div><div class="rs-kpi-l">Pending &gt; 7 days</div></div>
      <div class="rs-kpi"><div class="rs-kpi-n">${rsNum(sitesOk)}</div><div class="rs-kpi-l">Branches reporting${sitesFail ? ` <span class="rs-fail">(${sitesFail} n/a)</span>` : ''}</div></div>
    </div>`;

  const branchItems = (d.byBranch || []).map((b) => ({ label: 'Branch ' + b.site, count: b.count }));
  const agingItems = ['<1d', '1-3d', '3-7d', '>7d'].map((k) => ({ label: k, count: (d.aging && d.aging[k]) || 0 }));

  const panels = `
    <div class="rs-grid">
      ${rsPanel('By branch', rsBarRows(branchItems, 'label', null, 'var(--accent)'), `${branchItems.length} branches`)}
      ${rsPanel('By modality', rsModalityInner(), rsModalitySub())}
      ${rsPanel('Top ordering doctors', rsBarRows((d.byDoctor || []).map((x) => ({ label: x.name, count: x.count })), 'label', null, '#0ea5e9'), 'top 15')}
      ${rsPanel('By ordering department', rsBarRows((d.byDepartment || []).map((x) => ({ label: x.name, count: x.count })), 'label', null, '#8358FD'))}
      ${rsPanel('Pending age', rsBarRows(agingItems, 'label', null, (i) => i.label === '>7d' ? '#ef4444' : (i.label === '3-7d' ? '#f59e0b' : '#22c55e')), 'time since order')}
      ${rsPanel('Daily trend', rsTrend(d.daily || []), `${(d.daily || []).length} days`)}
    </div>`;

  const foot = `<div class="rs-foot">Range ${escapeHtml((d.range && d.range.from) || '')} → ${escapeHtml((d.range && d.range.to) || '')}
    · updated ${escapeHtml(rsAgo(d.generatedAt))}${sitesFail ? ` · branches unavailable: ${escapeHtml((d.sites.failed || []).join(', '))}` : ''}</div>`;

  body.innerHTML = kpis + panels + foot;
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
      <p>Modality isn't on the request row — it's read per order, so it loads on demand.</p>
      <button class="btn btn-primary btn-sm" onclick="rsLoadModality()">Load modality mix</button>
    </div>`;
  }
  if (!m.mix || !m.mix.length) return `<div class="rs-empty">No exam details returned</div>`;
  return rsBarRows(m.mix.map((x) => ({ label: x.modality, count: x.count })), 'label', null, (i) => RS_MOD_COLOR[i.label] || '#94a3b8');
}

function rsTrend(daily) {
  if (!daily.length) return `<div class="rs-empty">No data</div>`;
  const max = Math.max(1, ...daily.map((x) => x.count));
  const bars = daily.map((x) => {
    const h = Math.max(3, Math.round((x.count / max) * 100));
    return `<div class="rs-tbar" title="${escapeHtml(x.date)}: ${x.count}"><div class="rs-tbar-fill" style="height:${h}%"></div></div>`;
  }).join('');
  return `<div class="rs-trend">${bars}</div>`;
}

function rsAgo(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return 'just now';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}
