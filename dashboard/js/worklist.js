// ── RIS Worklist — pure RIS panel + consent ───────────────────────────────────
// A clean radiology worklist mirroring the Siratech RIS panel: every order still
// AWAITING a result, one row each — patient, exam + modality, ordering doctor,
// priority, live pipeline stage, and turnaround age. Emergency first, oldest first.
//
// It runs itself:
//  · the day is TODAY automatically (you can step to another day);
//  · the branch is YOUR branch automatically (org-wide roles can switch);
//  · it refreshes live, so a new order appears on its own;
//  · auto-file runs silently in the background — the moment a report is verified
//    it's filed into Siratech and the patient DROPS OFF this board by itself;
//  · a female patient shows a one-tap non-pregnancy consent right on her row.
// No knobs, no banners — just the board.

let wlState = { branches: [], site: '', data: null, loading: false, timer: null,
                seenEmerg: null, day: null,
                // Persistent modality/exam cache (per order) so a live refresh never
                // re-runs the heavy per-order HIS enrichment for rows we already know —
                // the board updates instantly; only a genuinely-new order hits the HIS.
                modCache: new Map() };

// Live board: refresh on a timer so a newly-arrived order (or a just-filed one
// dropping off) shows without the operator touching anything.
const WL_REFRESH_MS = 45000;

// Org-wide roles (superadmin/manager) can point the board at any branch; a branch
// team lead is server-scoped to their own branch, so the picker is locked for them.
function wlCanSwitchBranch() {
  return typeof currentUser !== 'undefined' && currentUser && ['manager', 'superadmin'].includes(currentUser.role);
}

// One canonical per-order key (billing id → bill no → MRN). Used for the modality
// cache, the enrichment merge, and the emergency seen-set, so they never disagree.
function wlRowKey(it) {
  return it.genPatBillingId != null ? 'g' + it.genPatBillingId
    : it.billNo ? 'b' + it.billNo
      : 'm' + (it.mrno || '') + '|' + (it.orderedDate || '');
}

// Local (KSA) date as YYYY-MM-DD — the operator is in KSA so the browser's local
// date IS the hospital's operational day.
function wlTodayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// day === null → "live": today + every still-pending prior-day order (nothing
// pending vanishes at midnight). Picking a date drills to exactly that day.
function wlShiftDay(delta) {
  const base = wlState.day || wlTodayLocal();
  const [y, m, d] = base.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  // Stepping forward onto today returns to the live rolling view.
  wlState.day = (iso >= wlTodayLocal()) ? null : iso;
  wlState.seenEmerg = null;
  wlSyncDayControls();
  wlLoad(true);
}
function wlSetDay(v) {
  wlState.day = (!v || v >= wlTodayLocal()) ? null : v;   // today (or blank) = live
  wlState.seenEmerg = null; wlSyncDayControls(); wlLoad(true);
}
function wlToday() { wlState.day = null; wlState.seenEmerg = null; wlSyncDayControls(); wlLoad(true); }
function wlSyncDayControls() {
  const i = document.getElementById('wl-day'); if (i) i.value = wlState.day || wlTodayLocal();
  const t = document.getElementById('wl-today-btn');
  if (t) t.style.visibility = wlState.day ? 'visible' : 'hidden';   // only offer "Today" when browsing the past
}

// A new EMERGENCY order arriving is the one event a radiology operator must not
// miss — chime + desktop notification the moment one appears (never for a backlog
// already on screen at first load). Always on; there's nothing to configure.
function wlBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    const beep = (t, freq) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.001, ac.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t + 0.28);
      o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.3);
    };
    beep(0, 880); beep(0.32, 1175);
    setTimeout(() => { try { ac.close(); } catch (e) {} }, 1200);
  } catch (e) { /* audio blocked — the visual badge still fires */ }
}
function wlNotify(newOnes) {
  const n = newOnes.length, first = newOnes[0] || {};
  const msg = n === 1
    ? `${first.patientName || first.mrno || 'A patient'} · ${first.branch || ''}`.trim()
    : `${n} new emergency orders`;
  try {
    if ('Notification' in window && Notification.permission === 'granted')
      new Notification('🚨 New emergency radiology order', { body: msg, tag: 'wl-emergency' });
  } catch (e) { /* ignore */ }
  if (typeof toast === 'function') toast(`🚨 New emergency: ${msg}`, 'err');
}
function wlKey(i) {
  return i.genPatBillingId != null ? 'g' + i.genPatBillingId
    : i.billNo ? 'b' + i.billNo
      : (i.mrno ? 'm' + i.mrno + '|' + (i.orderedDate || '') : null);
}
function wlCheckNewEmergencies(items) {
  const emerg = (items || []).filter((i) => i.emergency && wlKey(i));
  const keys = emerg.map(wlKey);
  if (wlState.seenEmerg === null) { wlState.seenEmerg = new Set(keys); return; }   // seed, no alarm
  const fresh = emerg.filter((i) => !wlState.seenEmerg.has(wlKey(i)));
  keys.forEach((k) => wlState.seenEmerg.add(k));
  if (fresh.length) { wlBeep(); wlNotify(fresh); }
}

async function renderWorklistPage() {
  setTopbar('Radiology worklist', 'Orders awaiting a result — emergency first, oldest first');
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Worklist', 'Radiology worklist', 'Every order awaiting a result')}
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <div style="display:flex;gap:4px;align-items:center">
          <button class="btn btn-sm btn-ghost" onclick="wlShiftDay(-1)" title="Previous day">◀</button>
          <input type="date" id="wl-day" class="input" value="${wlState.day || wlTodayLocal()}" onchange="wlSetDay(this.value)" style="width:150px" title="The day is today automatically — pick another to look back">
          <button class="btn btn-sm btn-ghost" onclick="wlShiftDay(1)" title="Next day">▶</button>
          <button id="wl-today-btn" class="btn btn-sm btn-primary" onclick="wlToday()" style="visibility:hidden" title="Back to today (live)">Today</button>
        </div>
        <select id="wl-branch" class="input" style="min-width:160px" onchange="wlOnBranch()">
          <option value="">All branches</option>
        </select>
        <input id="wl-search" class="input" placeholder="🔍 Find patient (file / ID / iqama / mobile) — all branches"
               style="min-width:230px;flex:1" onkeydown="if(event.key==='Enter')wlSearch(this.value)">
        <button class="btn btn-sm btn-ghost" onclick="wlLoad(true)" title="Refresh now">↻</button>
        <span id="wl-summary" style="font-size:12px;color:var(--muted);margin-left:auto"></span>
      </div>
    </div>
    <div id="wl-body"></div>`;

  // Only org-wide roles can switch branches; a team lead is scoped server-side to
  // their own branch, so we lock the picker for them and point them at the search
  // box (which finds a patient across every branch).
  const sel = document.getElementById('wl-branch');
  if (sel && !wlCanSwitchBranch()) {
    sel.disabled = true;
    sel.title = 'You see your own branch. To find a patient from another branch, use the search box.';
    if (sel.options[0]) sel.options[0].textContent = 'Your branch';
  } else {
    try {
      const b = await API.get('/radiology/branches');
      wlState.branches = (b && b.branches) || [];
      if (sel) for (const br of wlState.branches) {
        const o = document.createElement('option');
        o.value = br.siteId; o.textContent = br.shortName || br.name || ('Branch ' + br.siteId);
        sel.appendChild(o);
      }
    } catch (e) { /* picker optional; org-wide roles can still see all */ }
  }
  wlLoad();
  wlStartTimer();
}

function wlStartTimer() {
  if (wlState.timer) clearInterval(wlState.timer);
  wlState.timer = setInterval(() => {
    if (!document.getElementById('wl-body')) { clearInterval(wlState.timer); wlState.timer = null; return; }
    if (document.hidden) return;               // don't poll a backgrounded tab
    wlLoad(false, true);                        // silent refresh — never blanks the board
  }, WL_REFRESH_MS);
}

// Changing the branch shows a different set — re-seed the emergency baseline so
// switching scope never fires a false "new emergency" alarm.
function wlOnBranch() { wlState.site = document.getElementById('wl-branch').value; wlState.seenEmerg = null; wlLoad(); }

async function wlLoad(force, silent) {
  const body = document.getElementById('wl-body');
  if (!body || wlState.loading) return;
  wlState.loading = true;
  if (!silent) body.innerHTML = LOADING_HTML;
  const qs = new URLSearchParams();
  if (wlState.site) qs.set('sites', wlState.site);
  qs.set('ready', '1');                                     // pipeline stage is always on — it's a RIS panel
  if (wlState.day) { qs.set('from', wlState.day); qs.set('to', wlState.day); }
  if (force) qs.set('nocache', '1');
  try {
    wlState.data = await API.get('/radiology/worklist?' + qs.toString());
    wlHydrateModality();                          // paint known modality/exam instantly from cache
    wlRender();
    wlEnrichModality();                            // fill only the rows still missing modality
  } catch (e) {
    if (!silent) body.innerHTML = `<div class="empty" style="padding:24px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(e.message || 'Failed to load the worklist')}</p>
      <button class="btn btn-sm" onclick="wlLoad(true)">Retry</button></div>`;
  } finally { wlState.loading = false; }
}

// Paint modality/exam onto the freshly-loaded board from the persistent cache, so a
// live refresh shows the badges INSTANTLY without waiting on — or firing — the slow
// enrichment pass for rows we already know.
function wlHydrateModality() {
  const items = (wlState.data && wlState.data.items) || [];
  for (const it of items) {
    if (it.modality || it.exam) continue;
    const c = wlState.modCache.get(wlRowKey(it));
    if (c) { if (c.modality) it.modality = c.modality; if (c.exam) it.exam = c.exam; }
  }
}

// Second pass: fetch the same worklist with modality=1 (slow — a RadiologyDetails
// call per order) and merge modality/exam onto the rendered rows. Skipped entirely
// when every visible row is already resolved (from cache) — so a steady board's
// live refresh is light and instant, and the heavy HIS fan-out only runs for a
// genuinely-new order. Never blocks the board.
let _wlModBusy = false;
async function wlEnrichModality() {
  if (_wlModBusy) return;
  const items = (wlState.data && wlState.data.items) || [];
  if (!items.some((it) => !it.modality && !it.exam)) return;   // nothing new → no heavy call
  _wlModBusy = true;
  const qs = new URLSearchParams();
  if (wlState.site) qs.set('sites', wlState.site);
  qs.set('ready', '1');
  if (wlState.day) { qs.set('from', wlState.day); qs.set('to', wlState.day); }
  qs.set('modality', '1');
  try {
    const d = await API.get('/radiology/worklist?' + qs.toString());
    if (wlState.modCache.size > 2000) wlState.modCache.clear();   // bound memory on a long-lived kiosk
    const enr = new Map();
    for (const it of (d.items || [])) if (it.modality || it.exam) {
      const k = wlRowKey(it), v = { modality: it.modality, exam: it.exam };
      enr.set(k, v); wlState.modCache.set(k, v);
    }
    if (enr.size && wlState.data && Array.isArray(wlState.data.items)) {
      let changed = false;
      for (const it of wlState.data.items) {
        const e = enr.get(wlRowKey(it));
        if (e) {
          if (e.modality && it.modality !== e.modality) { it.modality = e.modality; changed = true; }
          if (e.exam && it.exam !== e.exam) { it.exam = e.exam; changed = true; }
        }
      }
      if (changed && document.getElementById('wl-body')) wlRender();
    }
  } catch (e) { /* best-effort */ }
  finally { _wlModBusy = false; }
}

// The RIS pipeline stages, in order. Each is detected from a specific signal:
//   ordered  — order line present in Siratech, no images yet
//   imaged   — a study exists in DePACS/PACS (scan performed), not yet reported
//   reported — the DePACS study is VERIFIED (signed report) → auto-file will file it
// (once filed in Siratech the order drops off this board entirely).
const WL_STAGES = [
  { key: 'reported', label: '✅ Report ready', color: '#2e9e6b' },
  { key: 'imaged',   label: '📷 Imaged — awaiting report', color: '#e0a800' },
  { key: 'ordered',  label: '📋 Ordered — awaiting imaging', color: '#6b7280' },
];

function wlRender() {
  const d = wlState.data || {}, items = d.items || [];
  wlCheckNewEmergencies(items);
  const sum = document.getElementById('wl-summary');
  if (sum) sum.textContent = `${d.total || 0} awaiting · ${d.emergency || 0} emergency`
    + (d.sites && d.sites.failed && d.sites.failed.length ? ` · ${d.sites.failed.length} branch(es) unreachable` : '');
  const body = document.getElementById('wl-body');
  if (!body) return;
  if (!items.length) { body.innerHTML = `<div class="empty" style="padding:26px"><p>No orders awaiting a result.</p></div>`; return; }
  const haveStages = items.some((it) => it.stage);
  if (!haveStages) { body.innerHTML = items.map((it, i) => wlRow(it, i)).join(''); return; }
  let html = '', idx = 0;
  for (const st of WL_STAGES) {
    const group = items.filter((it) => (it.stage || 'imaged') === st.key);
    if (!group.length) continue;
    html += `<div style="display:flex;align-items:center;gap:8px;margin:14px 2px 8px">
      <span style="font-weight:700;color:${st.color}">${st.label}</span>
      <span class="badge" style="background:${st.color};color:#fff">${group.length}</span>
      <div style="flex:1;height:1px;background:var(--border,#e5e5ea)"></div></div>`;
    html += group.map((it) => wlRow(it, idx++)).join('');
  }
  const rest = items.filter((it) => !it.stage);
  if (rest.length) {
    html += `<div style="font-size:12px;color:var(--muted);margin:14px 2px 8px">Not checked yet (${rest.length})</div>`;
    html += rest.map((it) => wlRow(it, idx++)).join('');
  }
  body.innerHTML = html;
}

function wlAge(h) { return h == null ? '' : (h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`); }

// Friendly labels + colour per imaging modality so the board reads at a glance.
const WL_MOD = {
  CT: { label: 'CT', bg: '#3b7ddd' }, MR: { label: 'MRI', bg: '#7c5cff' },
  US: { label: 'US', bg: '#2e9e6b' }, XR: { label: 'X-Ray', bg: '#6b7280' },
  MG: { label: 'Mammo', bg: '#d6568c' },
};
function wlModBadges(modality) {
  if (!modality) return '';
  return String(modality).split(',').map((m) => {
    const k = m.trim().toUpperCase(), info = WL_MOD[k];
    const label = info ? info.label : k, bg = info ? info.bg : '#8a8f98';
    return `<span class="badge" style="background:${bg};color:#fff">${escapeHtml(label)}</span>`;
  }).join(' ');
}

// A female patient needs a signed non-pregnancy consent BEFORE imaging. Detect
// female from the HIS gender and surface the consent state right on the row.
function wlIsFemale(g) {
  const s = String(g || '').trim().toLowerCase();
  return s.startsWith('f') || /أنث|انث/.test(s);
}
function wlConsentEl(it) {
  if (!wlIsFemale(it.gender)) return '';
  if (it.consentOnFile) return '<span class="badge badge-green" title="Non-pregnancy consent signed">✓ Consent</span>';
  return `<button class="btn btn-sm" style="background:#e0a800;color:#fff;border:none" title="Sign the non-pregnancy consent before imaging" onclick="wlConsent('${jsAttr(it.mrno)}','${jsAttr(it.patientName || '')}','${jsAttr(it.exam || '')}','${jsAttr(it.doctorName || '')}','${jsAttr(it.branch || '')}')">⚠ Consent needed</button>`;
}
function wlConsent(mrno, name, exam, doctor, branch) {
  // QR flow: her data is pre-printed on the official form, she scans the QR, signs
  // on HER OWN phone, and it reflects straight back (the board refreshes to ✓ Consent).
  const prefill = { file_no: mrno, mrno: mrno, mrn: mrno, name: name, procedure: exam,
                    referring_doctor: doctor || '', branch: branch || '' };
  if (typeof openConsentQR === 'function') { openConsentQR(prefill, () => wlLoad(true)); return; }
  if (typeof openConsent === 'function') { openConsent(prefill, () => wlLoad(true)); return; }
  if (typeof toast === 'function') toast('Consent module unavailable', 'err');
}

function wlRow(it, i) {
  const readyBadge = it.stage === 'reported' ? `<span class="badge badge-green">✅ report ready</span>`
    : it.stage === 'imaged' ? `<span class="badge badge-orange">📷 awaiting report</span>`
      : it.stage === 'ordered' ? `<span class="badge">📋 awaiting imaging</span>` : '';
  const age = wlAge(it.ageHours);
  return `<div class="card wl-card" style="margin-bottom:8px;padding:12px${it.emergency ? ';border-left:3px solid var(--danger,#E25555)' : ''}">
    <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div style="font-weight:700">${escapeHtml(it.patientName || '—')}
          <span style="color:var(--muted);font-weight:500">· ${escapeHtml(it.mrno)}</span></div>
        ${it.exam ? `<div style="font-size:13px;font-weight:600;color:var(--text,#1a1a2e);margin-top:3px">🩻 ${escapeHtml(it.exam)}</div>` : ''}
        <div style="font-size:12px;color:var(--muted);margin-top:2px">${escapeHtml(it.branch || '')}${it.doctorName ? ' · 👨‍⚕️ ' + escapeHtml(it.doctorName) : ''}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${wlModBadges(it.modality)}
        ${wlConsentEl(it)}
        ${it.emergency ? '<span class="badge badge-red">Emergency</span>' : '<span class="badge">Routine</span>'}
        ${age ? `<span class="badge badge-purple" title="time since ordered">${age}</span>` : ''}
        ${readyBadge}
        <button class="btn btn-sm btn-ghost" onclick="wlToggle(${i}, '${jsAttr(it.mrno)}', ${it.site || 0}, this)">Check</button>
      </div>
    </div>
    <div class="wl-detail" id="wl-d-${i}" style="display:none;margin-top:10px"></div>
  </div>`;
}

// Read-only drill: match the finished DePACS report(s) to this patient's order(s).
async function wlToggle(i, mrno, site, btn) {
  const box = document.getElementById('wl-d-' + i);
  if (!box) return;
  if (box.style.display === 'block') { box.style.display = 'none'; btn.textContent = 'Check'; return; }
  box.style.display = 'block'; btn.textContent = 'Hide'; box.innerHTML = LOADING_HTML;
  try {
    const d = await API.get(`/radiology/results/match/${encodeURIComponent(mrno)}${site ? `?site=${site}` : ''}`);
    box.innerHTML = wlMatch(d);
  } catch (e) {
    box.innerHTML = `<div class="ho-note">${escapeHtml(e.message || 'Result match failed')}</div>`;
  }
}

function wlMatch(d) {
  const orders = (d && d.orders) || [];
  if (!orders.length) return `<div class="ho-note">No order awaiting a result for this file.</div>`;
  const card = (t) => {
    const s = t.study || {}, rep = t.report || {};
    if (t.decision === 'unique') {
      return `<div class="ho-de-box ok" style="display:block;margin-bottom:6px">
        <div><b>✅ ${escapeHtml(t.test.serviceName || '')}</b> — report ready
          · ${escapeHtml(s.modality || '')} ${escapeHtml(s.desc || '')}${rep.pdfOk ? ' · 📄 PDF' : ''}</div>
        ${rep.preview ? `<div style="font-size:12px;color:var(--muted);margin-top:3px">${escapeHtml(rep.preview.slice(0, 200))}…</div>` : ''}
      </div>`;
    }
    return `<div class="ho-de-box" style="display:block;margin-bottom:6px;border-color:var(--warn,#b7791f)">
      <div><b>⚠️ ${escapeHtml(t.test.serviceName || '')}</b> — ${escapeHtml(t.reason || t.decision)}. Manual review.</div></div>`;
  };
  return orders.map(o => (o.tests || []).map(card).join('')).join('')
    + `<div style="font-size:12px;color:var(--muted);margin-top:2px">A verified report is filed automatically — it will drop off the board on its own.</div>`;
}

// Deep-link into the trusted Handoff wizard, pre-loaded with this patient's file.
function wlOpenHandoff(mrno) {
  window._handoffPreload = mrno;
  showPage('handoff');
}

// Cross-branch patient search: find a patient by ANY identifier (file / national ID
// / iqama / mobile) across ALL branches — for a patient whose exam was ordered at a
// different branch — and open them in Handoff to see the exam. Shows a chooser when
// more than one patient matches (never silently opens the wrong one).
async function wlSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  try {
    const d = await API.get('/radiology/find?q=' + encodeURIComponent(q));
    const pts = (d && d.patients) || [];
    if (!pts.length) { if (typeof toast === 'function') toast('No patient found for "' + q + '"', 'err'); return; }
    if (pts.length === 1) { wlOpenHandoff(String(pts[0].mrno || pts[0].file_no || q)); return; }
    wlShowMatches(pts);
  } catch (e) { if (typeof toast === 'function') toast(e.message || 'Search failed', 'err'); }
}
function wlShowMatches(pts) {
  const body = document.getElementById('wl-body');
  if (!body) return;
  const rows = pts.slice(0, 25).map((p) => {
    const mrn = String(p.mrno || p.file_no || '');
    const sub = [p.gender, p.birthDate || p.dob, p.branch].filter(Boolean).map(escapeHtml).join(' · ');
    return `<div class="card" style="margin-bottom:6px;padding:10px;display:flex;justify-content:space-between;align-items:center;gap:10px">
      <div><div style="font-weight:700">${escapeHtml(p.patientName || p.name || '—')} <span style="color:var(--muted);font-weight:500">· ${escapeHtml(mrn)}</span></div>
        ${sub ? `<div style="font-size:12px;color:var(--muted)">${sub}</div>` : ''}</div>
      <button class="btn btn-sm btn-primary" onclick="wlOpenHandoff('${jsAttr(mrn)}')">Open →</button></div>`;
  }).join('');
  body.innerHTML = `<div style="margin:6px 2px 10px;font-weight:700">${pts.length} matches — pick the patient</div>${rows}
    <button class="btn btn-sm btn-ghost" style="margin-top:6px" onclick="wlLoad(true)">← Back to worklist</button>`;
}
