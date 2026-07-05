// ── RIS Orders ──────────────────────────────────────────────────────────────
// The full order lifecycle board, backed by the persisted store
// (scheduling.radiology_orders): every radiology order with its state
// (ordered → reported → filed), the timestamps of each transition, and the
// turnaround times (TAT) between them. This is the "where is every order right
// now" view — the operational heart of the platform replacing Siratech's own
// order list. Read-only.

let odState = { branches: [], site: '', state: 'attention', qtext: '', data: null, loading: false, timer: null, attnCount: 0, orphanCount: 0 };
const OD_REFRESH_MS = 60000;

async function renderOrdersPage() {
  setTopbar('Radiology orders', 'Every order and where it is — ordered · reported · filed');
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Orders', 'Radiology orders', 'The full lifecycle of every order — ordered, reported, filed, with turnaround times')}
    <div class="card" style="margin-bottom:12px;padding:10px 12px;border-left:3px solid #3b7ddd;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span style="font-size:18px">📋</span>
      <span style="font-size:13px;color:var(--muted)">
        This is the <strong>history &amp; turnaround</strong> view — where every report ended up.
        To <strong>work</strong> pending patients, open the <a href="#" onclick="showPage('worklist');return false" style="color:#3b7ddd;font-weight:600">Worklist</a>.
      </span>
    </div>
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
  { key: 'attention', label: '⚠️ Needs attention' },
  { key: 'orphan', label: '🔎 Orphan reports' },
  { key: '', label: 'All' },
  { key: 'ordered', label: 'Ordered' },
  { key: 'reported', label: 'Reported' },
  { key: 'filed', label: 'Filed' },
];
function odRenderTabs() {
  const host = document.getElementById('od-states');
  if (!host) return;
  host.innerHTML = OD_STATES.map(s => {
    // The attention + orphan tabs carry a live count so a manager sees "3 stuck" /
    // "2 unconfirmed" from anywhere.
    let badge = '';
    if (s.key === 'attention' && odState.attnCount > 0)
      badge = ` <span class="badge badge-red" style="padding:0 6px">${odState.attnCount}</span>`;
    else if (s.key === 'orphan' && odState.orphanCount > 0)
      badge = ` <span class="badge badge-orange" style="padding:0 6px">${odState.orphanCount}</span>`;
    return `<button class="btn btn-sm ${odState.state === s.key ? 'btn-primary' : 'btn-ghost'}"
       onclick="odSetState('${s.key}')">${s.label}${badge}</button>`;
  }).join('');
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
  // 'attention' isn't a server state — it's a client-side filter over the whole
  // in-flight set, so we ask for everything and pick the stuck ones out below.
  if (odState.state && odState.state !== 'attention') qs.set('state', odState.state);
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
  // Summary: the pipeline counts + a couple of average turnaround figures. Only orders
  // filed THROUGH Meena carry a real turnaround — 'external' rows were reconciled off the
  // board (filed elsewhere) with an unknown file time, so they're kept out of the averages
  // to stop the numbers being poisoned.
  const filed = orders.filter(o => o.state === 'filed' && o.filedSource !== 'external' && o.tatTotalH != null);
  const avgTotal = filed.length ? (filed.reduce((s, o) => s + o.tatTotalH, 0) / filed.length) : null;
  const rep = orders.filter(o => o.filedSource !== 'external' && o.tatReportH != null);
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

  // Orphan count comes straight from the server (scope-aware) on every load, so the tab
  // badge is accurate from any tab.
  if (typeof d.orphanCount === 'number') odState.orphanCount = d.orphanCount;

  // "Needs attention" = every still-in-flight order past its SLA (reported-not-filed, or
  // ordered-no-report), worst first. When the loaded set includes in-flight orders we can
  // refresh the tab badge count; otherwise we keep the last known count.
  const attn = orders.filter(o => odAttention(o));
  if (odState.state === 'attention' || !odState.state || odState.state === 'ordered' || odState.state === 'reported') {
    odState.attnCount = attn.length;
  }
  odRenderTabs();

  if (odState.state === 'orphan') {
    if (!orders.length) {
      body.innerHTML = `<div class="empty" style="padding:34px;text-align:center">
        <div style="font-size:34px">✅</div>
        <p style="font-weight:600;margin-top:6px">No orphan reports — every verified report is accounted for.</p>
        <p style="color:var(--muted);font-size:13px">A report lands here only if it was verified, left the worklist, and Meena never filed it.</p></div>`;
      return;
    }
    body.innerHTML = `<div class="card" style="padding:10px 12px;margin-bottom:10px;border-left:3px solid var(--warn,#e0a800)">
        <div style="font-size:13px">
          <strong>${orders.length} report(s) may not have reached the file.</strong>
          Each was verified and left the worklist, but Meena never filed it — open it on the worklist and
          confirm the report is attached (file it if not). Fully automatic matching needs the vendor's
          accession feed.
        </div></div>`
      + orders.map(odRow).join('');
    return;
  }

  if (odState.state === 'attention') {
    if (!attn.length) {
      body.innerHTML = `<div class="empty" style="padding:34px;text-align:center">
        <div style="font-size:34px">✅</div>
        <p style="font-weight:600;margin-top:6px">Nothing stuck — every report is on track.</p>
        <p style="color:var(--muted);font-size:13px">Orders show up here only when a report sits unfiled or a read runs long.</p></div>`;
      return;
    }
    // worst first: emergencies on top, then the longest-waiting.
    attn.sort((a, b) => (Number(b.emergency) - Number(a.emergency)) || (odAttnAge(b) - odAttnAge(a)));
    body.innerHTML = `<div style="font-size:12px;color:var(--muted);margin:2px 2px 10px">
        ${attn.length} order(s) need a human — filed reports and on-track orders are hidden here.</div>`
      + attn.map(odRow).join('');
    return;
  }

  if (!orders.length) { body.innerHTML = `<div class="empty" style="padding:26px"><p>No orders${odState.state ? ' in this state' : ''} yet. The store fills as the worklist is viewed.</p></div>`; return; }
  body.innerHTML = orders.map(odRow).join('');
}

// How long an in-flight order has been waiting at its current stage (hours) — drives the
// worst-first sort on the attention tab.
function odAttnAge(o) {
  if (o.state === 'reported') return odHoursSince(o.reportedAt) || 0;
  if (o.state === 'ordered') return odHoursSince(o.orderedAt) || 0;
  return 0;
}
function odJumpWorklist(mrno) {
  window._wlPendingFilter = String(mrno || '');
  showPage('worklist');
}
// A verified report that left the board without Meena filing it (mirrors the backend's
// orphan predicate) — a report exists but we can't confirm it reached the patient file.
function odIsOrphan(o) {
  return o.state === 'filed' && o.filedSource === 'external' && !o.studyId && !!o.reportedAt;
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
  const stateBadge = o.state === 'filed'
    ? (o.filedSource === 'external'
        ? '<span class="badge" style="background:#8a8f98;color:#fff" title="Left the board filed/resolved outside Meena — turnaround unknown">Filed elsewhere</span>'
        : '<span class="badge badge-green">Filed</span>')
    : o.state === 'reported' ? '<span class="badge badge-orange">Reported</span>'
      : (o.imagedAt ? '<span class="badge badge-orange" title="Images are in DePACS — awaiting the report">📷 Imaged</span>'
                    : '<span class="badge">Ordered</span>');
  const attBorder = att ? (att.cls === 'badge-red' ? 'var(--danger,#E25555)' : 'var(--warn,#e0a800)') : null;
  const border = attBorder || (emerg ? 'var(--danger,#E25555)' : null);
  return `<div class="card" style="margin-bottom:8px;padding:12px${border ? ';border-left:3px solid ' + border : ''}">
    <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div style="font-weight:700">${escapeHtml(o.patientName || '—')}
          <span style="color:var(--muted);font-weight:500">· ${escapeHtml(o.mrno || '')}</span></div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">
          ${o.billNo ? 'Bill ' + escapeHtml(String(o.billNo)) + ' · ' : ''}${escapeHtml(o.department || '')}${o.doctor ? ' · ' + escapeHtml(o.doctor) : ''}${o.studyId ? ' · study #' + escapeHtml(String(o.studyId)) : ''}${o.accession ? ' · acc ' + escapeHtml(String(o.accession)) : ''}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${odModBadges(o.modality)}
        ${o.accession ? `<span class="badge badge-green" title="Exact image↔order link — matched on DICOM accession ${escapeHtml(String(o.accession))}${o.accessionSource ? ' (' + escapeHtml(String(o.accessionSource)) + ')' : ''}">🔗 Linked</span>` : ''}
        ${o.cpacsUrl ? `<a class="badge" style="background:#3b6fd4;color:#fff;text-decoration:none" href="${escapeHtml(String(o.cpacsUrl))}" target="_blank" rel="noopener" title="Open the study in the PACS viewer">🖼 View images</a>` : ''}
        ${emerg ? '<span class="badge badge-red">Emergency</span>' : ''}
        ${att ? `<span class="badge ${att.cls}" title="Still in-flight — may need a human">⚠ ${att.label}</span>` : ''}
        ${odIsOrphan(o) ? '<span class="badge badge-orange" title="Report was verified but Meena never filed it — confirm it reached the file">⚠ Report unconfirmed</span>' : ''}
        ${stateBadge}
        ${(o.state !== 'filed' || odIsOrphan(o)) && o.mrno
          ? `<button class="btn btn-sm btn-ghost" style="padding:2px 8px" title="Open this patient on the worklist to confirm / file the report"
               onclick="odJumpWorklist('${escapeHtml(String(o.mrno))}')">${odIsOrphan(o) ? 'Verify in Worklist →' : 'Open in Worklist →'}</button>` : ''}
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
