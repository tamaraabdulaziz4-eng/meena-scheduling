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
  odState._paintedOnce = false;          // entrance animation once per visit
  const c = document.getElementById('content');
  c.innerHTML = `<div class="cc">
    ${pageHero('Orders', 'Radiology orders', 'The full lifecycle of every order — ordered, reported, filed, with turnaround times')}
    <div class="card" style="margin-bottom:12px;padding:10px 12px;border-left:3px solid var(--blue,#3b7ddd);display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span style="font-size:18px">📋</span>
      <span style="font-size:13px;color:var(--muted)">
        This is the <strong>history &amp; turnaround</strong> view — where every report ended up.
        To <strong>work</strong> pending patients, open the <a href="#" onclick="showPage('worklist');return false" style="color:var(--blue,#3b7ddd);font-weight:600">Worklist</a>.
      </span>
    </div>
    <div id="od-summary" style="margin-bottom:12px"></div>
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <div id="od-states" style="min-width:0"></div>
        <select id="od-branch" class="input" style="min-width:170px" onchange="odOnBranch()">
          <option value="">All branches</option>
        </select>
        <input id="od-q" class="input" placeholder="File / MRN…" style="max-width:150px"
               oninput="odDebouncedSearch()" onkeydown="if(event.key==='Enter')odLoad(true)">
        <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--muted)">
          <input type="checkbox" id="od-live" checked onchange="odToggleLive()"> Live
        </label>
        <button class="open" style="width:auto" onclick="odLoad(true)">↻ Refresh</button>
        <span id="od-count" style="font-size:12px;color:var(--muted);margin-left:auto"></span>
      </div>
    </div>
    <div id="od-body"></div>
  </div>`;
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
  host.innerHTML = '<div class="tabs">' + OD_STATES.map(s => {
    // The attention + orphan tabs carry a live count so a manager sees "3 stuck" /
    // "2 unconfirmed" from anywhere.
    let n = 0;
    if (s.key === 'attention') n = odState.attnCount;
    else if (s.key === 'orphan') n = odState.orphanCount;
    const badge = n > 0 ? `<span class="n">${n}</span>` : '';
    return `<button class="tab${odState.state === s.key ? ' on' : ''}"
       onclick="odSetState('${s.key}')">${s.label}${badge}</button>`;
  }).join('') + '</div>';
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
      <button class="ghost" onclick="odLoad(true)">Retry</button></div>`;
  } finally { odState.loading = false; }
}

function odRender() {
  const d = odState.data || {}, orders = d.orders || [], by = d.byState || {};
  // Entrance animation fires ONCE per visit — the 60s silent poll recreates the
  // KPI tiles and order cards, which would replay the rise stagger as a visible
  // flicker every refresh. Same .cc-still pin as the worklist.
  const ccRoot = document.querySelector('#content > .cc');
  if (ccRoot) { ccRoot.classList.toggle('cc-still', !!odState._paintedOnce); odState._paintedOnce = true; }
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
    <div class="kpis">
      ${odStat('Ordered', by.ordered || 0, 'd', 'var(--accent,#6B4EFF)', 'awaiting report')}
      ${odStat('Reported', by.reported || 0, 'a', 'var(--yellow,#FFBA49)', 'awaiting filing')}
      ${odStat('Filed', by.filed || 0, 'c', 'var(--green,#00C896)', 'closed through Meena')}
      ${odStat('Avg order→report', avgReport == null ? '—' : odHrs(avgReport), 'b', 'var(--blue,#3BA0FF)', 'turnaround')}
      ${odStat('Avg order→filed', avgTotal == null ? '—' : odHrs(avgTotal), 'b', 'var(--blue,#3BA0FF)', 'turnaround')}
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

// One Clinical Calm KPI card (accent variants: a=amber b=blue c=green d=violet).
function odStat(label, val, accent, dot, caption) {
  return `<div class="kpi ${accent}">
    <div class="kl"><span class="kd" style="background:${dot}"></span>${label}</div>
    <div class="kv">${val}</div>
    ${caption ? `<div class="kt">${caption}</div>` : ''}
  </div>`;
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
  CT: { label: 'CT', cls: 'ct' }, MR: { label: 'MRI', cls: 'mri' }, MRI: { label: 'MRI', cls: 'mri' },
  US: { label: 'US', cls: 'us' }, XR: { label: 'X-Ray', cls: 'xr' }, DX: { label: 'X-Ray', cls: 'xr' },
  CR: { label: 'X-Ray', cls: 'xr' }, MG: { label: 'Mammo', cls: 'mm' },
};
function odModBadges(modality) {
  if (!modality) return '';
  return String(modality).split(',').map((m) => {
    const k = m.trim().toUpperCase(), info = OD_MOD[k];
    return `<span class="mod ${info ? info.cls : 'xr'}">${escapeHtml(info ? info.label : k)}</span>`;
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
  // State → Clinical Calm .ris pill: ordered→scheduled, imaged→completed,
  // reported→prelim, filed→final ('Filed elsewhere' stays muted/scheduled).
  const ris = (state, label, title) =>
    `<span class="ris ${state}"${title ? ` title="${title}"` : ''}><span class="rd"></span>${label}</span>`;
  const stateBadge = o.state === 'filed'
    ? (o.filedSource === 'external'
        ? ris('scheduled', 'Filed elsewhere', 'Left the board filed/resolved outside Meena — turnaround unknown')
        : ris('final', 'Filed'))
    : o.state === 'reported' ? ris('prelim', 'Reported')
      : (o.imagedAt ? ris('completed', 'Imaged', 'Images are in DePACS — awaiting the report')
                    : ris('scheduled', 'Ordered'));
  const attBorder = att ? (att.cls === 'badge-red' ? 'var(--danger,#E25555)' : 'var(--yellow,#e0a800)') : null;
  const border = attBorder || (emerg ? 'var(--danger,#E25555)' : null);
  return `<div class="listcard" style="margin-bottom:10px${border ? ';box-shadow:inset 3px 0 0 ' + border : ''}">
    <div class="lrow" style="align-items:flex-start;flex-wrap:wrap">
      <div class="pt" style="flex:1;min-width:200px">
        <div class="pname">${escapeHtml(o.patientName || '—')}
          ${emerg ? '<span class="stat"><i></i>STAT</span>' : ''}
          <span style="color:var(--muted);font-weight:500;font-size:12.5px">· ${escapeHtml(o.mrno || '')}</span></div>
        <div class="pmeta"><span>
          ${o.billNo ? 'Bill ' + escapeHtml(String(o.billNo)) + ' · ' : ''}${escapeHtml(o.department || '')}${o.doctor ? ' · ' + escapeHtml(o.doctor) : ''}${o.studyId ? ' · study #' + escapeHtml(String(o.studyId)) : ''}</span></div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
        ${odModBadges(o.modality)}
        ${o.accession ? `<span class="acc" title="Exact image↔order link — matched on DICOM accession ${escapeHtml(String(o.accession))}${o.accessionSource ? ' (' + escapeHtml(String(o.accessionSource)) + ')' : ''}">🔗 ${escapeHtml(String(o.accession))}</span>` : ''}
        ${(o.state === 'reported' || o.state === 'filed' || o.imagedAt || o.accession) && o.mrno
          ? `<button class="ghost" title="Open the radiology report + images — live from Siratech"
               onclick="odOpenStudy(this,'${escapeHtml(String(o.mrno))}','${escapeHtml(String(o.accession || ''))}')">📄 Report / Images</button>` : ''}
        ${att ? `<span class="sc ${att.cls === 'badge-red' ? 'no' : 'warn'}" title="Still in-flight — may need a human">⚠ ${att.label}</span>` : ''}
        ${odIsOrphan(o) ? '<span class="sc warn" title="Report was verified but Meena never filed it — confirm it reached the file">⚠ Report unconfirmed</span>' : ''}
        ${stateBadge}
        ${(o.state !== 'filed' || odIsOrphan(o)) && o.mrno
          ? `<button class="ghost" title="Open this patient on the worklist to confirm / file the report"
               onclick="odJumpWorklist('${escapeHtml(String(o.mrno))}')">${odIsOrphan(o) ? 'Verify in Worklist →' : 'Open in Worklist →'}</button>` : ''}
      </div>
    </div>
    <div style="padding:0 18px 14px">${odTimeline(o, step)}</div>
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

// ── Native Siratech report + images for one exam ──────────────────────────────
// Opens a modal with the radiology report TEXT + status + a button to the cloud
// image viewer — all live from Siratech (FetchRadiologyReport / FetchRadiologyImage
// / cpoeStatusDescription), no DePACS. Keyed by mrno + accession.
async function odOpenStudy(btn, mrno, accession) {
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '… loading'; }
  let d;
  try {
    const qs = new URLSearchParams({ mrno }); if (accession) qs.set('accession', accession);
    d = await API.get('/radiology/study?' + qs.toString());
  } catch (e) { d = { ok: false, error: (e && e.message) || 'failed' }; }
  if (btn) { btn.disabled = false; btn.textContent = old; }
  odShowStudyModal(mrno, d || {});
}

function odShowStudyModal(mrno, d) {
  document.getElementById('od-study-modal')?.remove();
  const rep = (d.reportText || '').trim();
  const wrap = document.createElement('div');
  wrap.id = 'od-study-modal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  const statusPill = d.status ? `<span class="ris ${/scan done|complet|verif|report|final/i.test(d.status) ? 'final' : 'prelim'}"><span class="rd"></span>${escapeHtml(d.status)}</span>` : '';
  const imgBtn = d.imageUrl
    ? `<a class="btn btn-sm btn-primary" style="text-decoration:none" href="${escapeHtml(d.imageUrl)}" target="_blank" rel="noopener">🖼 Open images</a>`
    : `<span style="color:var(--muted);font-size:12px">No image link</span>`;
  const body = !d.ok
    ? `<div style="color:var(--danger,#E25555)">Couldn't load: ${escapeHtml(d.error || 'error')}</div>`
    : d.found === false
      ? `<div style="color:var(--muted)">No matching exam found in Siratech for this order.</div>`
      : `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
           ${statusPill}
           ${d.modality ? `<span class="mod">${escapeHtml(String(d.modality))}</span>` : ''}
           ${d.reportDate ? `<span style="color:var(--muted);font-size:12px">Reported ${escapeHtml(String(d.reportDate))}</span>` : ''}
           <span style="flex:1"></span>${imgBtn}
         </div>
         ${d.verifiedBy ? `<div style="font-size:12px;color:var(--muted);margin-bottom:6px">Verified by ${escapeHtml(d.verifiedBy)}</div>` : ''}
         ${rep
            ? `<pre style="white-space:pre-wrap;font-family:inherit;font-size:13.5px;line-height:1.6;background:var(--surface,#f7f7fb);border:1px solid var(--border,#e5e5ee);border-radius:10px;padding:12px;max-height:52vh;overflow:auto;margin:0">${escapeHtml(rep)}</pre>`
            : `<div style="color:var(--muted)">${d.hasReport ? 'Report is filed but has no readable text.' : 'No report yet — images may still be available above.'}</div>`}`;
  wrap.innerHTML = `<div class="card" style="max-width:760px;width:100%;max-height:86vh;overflow:auto;padding:16px 18px">
      <div style="display:flex;align-items:center;margin-bottom:10px">
        <div style="font-weight:700;font-size:15px">Radiology report${d.serviceName ? ' · ' + escapeHtml(String(d.serviceName)) : ''}
          <span style="color:var(--muted);font-weight:500;font-size:12.5px"> · ${escapeHtml(String(mrno))}</span></div>
        <span style="flex:1"></span>
        <button class="ghost" onclick="document.getElementById('od-study-modal').remove()">✕</button>
      </div>
      ${body}
      <div style="margin-top:8px;font-size:11px;color:var(--muted)">Live from Siratech · read-only</div>
    </div>`;
  document.body.appendChild(wrap);
}
