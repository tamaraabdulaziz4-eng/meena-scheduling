// ── RIS Orders ──────────────────────────────────────────────────────────────
// The full order lifecycle board, backed by the persisted store
// (scheduling.radiology_orders): every radiology order with its state
// (ordered → reported → filed), the timestamps of each transition, and the
// turnaround times (TAT) between them. This is the "where is every order right
// now" view — the operational heart of the platform replacing Siratech's own
// order list. Read-only.

let odState = { branches: [], site: '', state: '', qtext: '', data: null, loading: false, timer: null };
const OD_REFRESH_MS = 60000;

async function renderOrdersPage() {
  setTopbar('Radiology orders', 'Every order and where it is — ordered · reported · filed');
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Orders', 'Radiology orders', 'The full lifecycle of every order — ordered, reported, filed, with turnaround times')}
    <div id="od-summary" style="margin-bottom:12px"></div>
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <div id="od-states" class="od-tabs" style="display:flex;gap:6px;flex-wrap:wrap"></div>
        <select id="od-branch" class="input" style="min-width:170px" onchange="odOnBranch()">
          <option value="">All branches</option>
        </select>
        <input id="od-q" class="input" placeholder="File / MRN…" style="max-width:150px"
               oninput="odDebouncedSearch()" onkeydown="if(event.key==='Enter')odLoad(true)">
        <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--muted)">
          <input type="checkbox" id="od-live" checked onchange="odToggleLive()"> Live
        </label>
        <button class="btn btn-sm btn-primary" onclick="odLoad(true)">↻ Refresh</button>
        <span id="od-count" style="font-size:12px;color:var(--muted);margin-left:auto"></span>
      </div>
    </div>
    <div id="od-body"></div>`;
  odRenderTabs();
  try {
    const b = await API.get('/radiology/branches');
    odState.branches = (b && b.branches) || [];
    const sel = document.getElementById('od-branch');
    if (sel) for (const br of odState.branches) {
      const o = document.createElement('option');
      o.value = br.siteId; o.textContent = br.shortName || br.name || ('Branch ' + br.siteId);
      sel.appendChild(o);
    }
  } catch (e) { /* branch picker optional — team leads are scoped server-side */ }
  odLoad();
  odStartTimer();
}

const OD_STATES = [
  { key: '', label: 'All' },
  { key: 'ordered', label: 'Ordered' },
  { key: 'reported', label: 'Reported' },
  { key: 'filed', label: 'Filed' },
];
function odRenderTabs() {
  const host = document.getElementById('od-states');
  if (!host) return;
  host.innerHTML = OD_STATES.map(s =>
    `<button class="btn btn-sm ${odState.state === s.key ? 'btn-primary' : 'btn-ghost'}"
       onclick="odSetState('${s.key}')">${s.label}</button>`).join('');
}
function odSetState(k) { odState.state = k; odRenderTabs(); odLoad(true); }
function odOnBranch() { odState.site = document.getElementById('od-branch').value; odLoad(true); }

let _odSearchTimer = null;
function odDebouncedSearch() {
  clearTimeout(_odSearchTimer);
  _odSearchTimer = setTimeout(() => { odState.qtext = document.getElementById('od-q').value.trim(); odLoad(true); }, 350);
}

function odStartTimer() {
  if (odState.timer) clearInterval(odState.timer);
  odState.timer = setInterval(() => {
    if (!document.getElementById('od-body')) { clearInterval(odState.timer); odState.timer = null; return; }
    if (document.hidden) return;
    odLoad(false, true);
  }, OD_REFRESH_MS);
}
function odToggleLive() {
  if (document.getElementById('od-live').checked) odStartTimer();
  else if (odState.timer) { clearInterval(odState.timer); odState.timer = null; }
}

async function odLoad(force, silent) {
  const body = document.getElementById('od-body');
  if (!body || odState.loading) return;
  odState.loading = true;
  if (!silent) body.innerHTML = LOADING_HTML;
  const qs = new URLSearchParams();
  if (odState.site) qs.set('site', odState.site);
  if (odState.state) qs.set('state', odState.state);
  if (odState.qtext) qs.set('mrno', odState.qtext);
  try {
    odState.data = await API.get('/radiology/orders?' + qs.toString());
    odRender();
  } catch (e) {
    if (!silent) body.innerHTML = `<div class="empty" style="padding:24px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(e.message || 'Failed to load orders')}</p>
      <button class="btn btn-sm" onclick="odLoad(true)">Retry</button></div>`;
  } finally { odState.loading = false; }
}

function odRender() {
  const d = odState.data || {}, orders = d.orders || [], by = d.byState || {};
  // Summary: the pipeline counts + a couple of average turnaround figures.
  const filed = orders.filter(o => o.state === 'filed' && o.tatTotalH != null);
  const avgTotal = filed.length ? (filed.reduce((s, o) => s + o.tatTotalH, 0) / filed.length) : null;
  const rep = orders.filter(o => o.tatReportH != null);
  const avgReport = rep.length ? (rep.reduce((s, o) => s + o.tatReportH, 0) / rep.length) : null;
  const sum = document.getElementById('od-summary');
  if (sum) sum.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${odStat('Ordered', by.ordered || 0, 'var(--muted,#888)', '🕒')}
      ${odStat('Reported', by.reported || 0, '#e0a800', '📝')}
      ${odStat('Filed', by.filed || 0, 'var(--success,#2e9e6b)', '✅')}
      ${odStat('Avg order→report', avgReport == null ? '—' : odHrs(avgReport), '#3b7ddd', '⏱️')}
      ${odStat('Avg order→filed', avgTotal == null ? '—' : odHrs(avgTotal), '#7c5cff', '🏁')}
    </div>`;
  const cnt = document.getElementById('od-count');
  if (cnt) cnt.textContent = `${d.count || 0} order(s)`;
  const body = document.getElementById('od-body');
  if (!body) return;
  if (!orders.length) { body.innerHTML = `<div class="empty" style="padding:26px"><p>No orders${odState.state ? ' in this state' : ''} yet. The store fills as the worklist is viewed.</p></div>`; return; }
  body.innerHTML = orders.map(odRow).join('');
}

function odStat(label, val, color, icon) {
  return `<div class="card" style="flex:1;min-width:140px;padding:12px;border-top:3px solid ${color}">
    <div style="font-size:12px;color:var(--muted)">${icon} ${label}</div>
    <div style="font-size:24px;font-weight:800;margin-top:2px">${val}</div></div>`;
}

// hours → friendly "3h" / "2d 4h" / "45m"
function odHrs(h) {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${h.toFixed(1)}h`;
  const d = Math.floor(h / 24), r = Math.round(h % 24);
  return r ? `${d}d ${r}h` : `${d}d`;
}
function odWhen(iso) {
  if (!iso) return '—';
  try {
    const dt = new Date(iso);
    return dt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return '—'; }
}

const OD_MOD = {
  CT: { label: 'CT', bg: '#3b7ddd' }, MR: { label: 'MRI', bg: '#7c5cff' },
  US: { label: 'US', bg: '#2e9e6b' }, XR: { label: 'X-Ray', bg: '#6b7280' },
  MG: { label: 'Mammo', bg: '#d6568c' },
};
function odModBadges(modality) {
  if (!modality) return '';
  return String(modality).split(',').map((m) => {
    const k = m.trim().toUpperCase(), info = OD_MOD[k];
    return `<span class="badge" style="background:${info ? info.bg : '#8a8f98'};color:#fff">${escapeHtml(info ? info.label : k)}</span>`;
  }).join(' ');
}

const OD_STEP_ORDER = { ordered: 0, reported: 1, filed: 2 };
// "Stuck" thresholds (hours): a report verified but not filed for this long almost
// always means the match was ambiguous and needs a human; an order with no report
// for this long is a slow read worth chasing. Emergencies get tighter limits.
const OD_STUCK_REPORT_H = 3, OD_STUCK_REPORT_EMERG_H = 1;
const OD_STUCK_ORDER_H = 24, OD_STUCK_ORDER_EMERG_H = 4;
function odHoursSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 36e5 : null;
}
// Returns an "attention" flag for an order still in-flight, else null.
function odAttention(o) {
  if (o.state === 'reported') {
    const h = odHoursSince(o.reportedAt);
    const lim = o.emergency ? OD_STUCK_REPORT_EMERG_H : OD_STUCK_REPORT_H;
    if (h != null && h >= lim) return { label: `needs filing · ${odHrs(h)}`, cls: 'badge-red' };
  } else if (o.state === 'ordered') {
    const h = odHoursSince(o.orderedAt);
    const lim = o.emergency ? OD_STUCK_ORDER_EMERG_H : OD_STUCK_ORDER_H;
    if (h != null && h >= lim) return { label: `no report · ${odHrs(h)}`, cls: 'badge-orange' };
  }
  return null;
}

function odRow(o) {
  const step = OD_STEP_ORDER[o.state] ?? 0;
  const emerg = o.emergency;
  const att = odAttention(o);
  const stateBadge = o.state === 'filed' ? '<span class="badge badge-green">Filed</span>'
    : o.state === 'reported' ? '<span class="badge badge-orange">Reported</span>'
      : '<span class="badge">Ordered</span>';
  const attBorder = att ? (att.cls === 'badge-red' ? 'var(--danger,#E25555)' : 'var(--warn,#e0a800)') : null;
  const border = attBorder || (emerg ? 'var(--danger,#E25555)' : null);
  return `<div class="card" style="margin-bottom:8px;padding:12px${border ? ';border-left:3px solid ' + border : ''}">
    <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div style="font-weight:700">${escapeHtml(o.patientName || '—')}
          <span style="color:var(--muted);font-weight:500">· ${escapeHtml(o.mrno || '')}</span></div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">
          ${o.billNo ? 'Bill ' + escapeHtml(String(o.billNo)) + ' · ' : ''}${escapeHtml(o.department || '')}${o.doctor ? ' · ' + escapeHtml(o.doctor) : ''}${o.studyId ? ' · study #' + escapeHtml(String(o.studyId)) : ''}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${odModBadges(o.modality)}
        ${emerg ? '<span class="badge badge-red">Emergency</span>' : ''}
        ${att ? `<span class="badge ${att.cls}" title="Still in-flight — may need a human">⚠ ${att.label}</span>` : ''}
        ${stateBadge}
      </div>
    </div>
    ${odTimeline(o, step)}
  </div>`;
}

// A 3-node pipeline: Ordered ──(TAT)── Reported ──(TAT)── Filed. Reached nodes are
// solid; the gap labels carry the turnaround between the two stamps.
function odTimeline(o, step) {
  const node = (i, label, iso) => {
    const done = step >= i;
    const color = done ? (i === 2 ? 'var(--success,#2e9e6b)' : i === 1 ? '#e0a800' : '#3b7ddd') : 'var(--border,#ccc)';
    return `<div style="display:flex;flex-direction:column;align-items:center;min-width:78px">
      <div style="width:14px;height:14px;border-radius:50%;background:${done ? color : 'transparent'};border:2px solid ${color}"></div>
      <div style="font-size:11px;font-weight:600;margin-top:4px;color:${done ? 'inherit' : 'var(--muted)'}">${label}</div>
      <div style="font-size:10px;color:var(--muted)">${odWhen(iso)}</div>
    </div>`;
  };
  const link = (i, tat) => {
    const done = step >= i;
    return `<div style="flex:1;min-width:36px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding-top:6px">
      <div style="height:2px;width:100%;background:${done ? 'var(--success,#2e9e6b)' : 'var(--border,#ccc)'}"></div>
      <div style="font-size:10px;color:var(--muted);margin-top:2px">${tat != null ? odHrs(tat) : ''}</div>
    </div>`;
  };
  return `<div style="display:flex;align-items:flex-start;margin-top:10px;gap:2px">
    ${node(0, 'Ordered', o.orderedAt)}
    ${link(1, o.tatReportH)}
    ${node(1, 'Reported', o.reportedAt)}
    ${link(2, o.tatFileH)}
    ${node(2, 'Filed', o.filedAt)}
  </div>`;
}
