// ── RIS Worklist ──────────────────────────────────────────────────────────────
// Live board of every radiology order AWAITING a result across the branch(es):
// emergency first, oldest first, with a turnaround (TAT) age. Optionally checks
// which orders already have a VERIFIED DePACS report ready to file. Read-only here;
// the actual file+authorize is handed off to the trusted Handoff wizard so the
// clinical write path lives in one place.

let wlState = { branches: [], site: '', ready: false, data: null, loading: false, timer: null, autofile: null,
                seenEmerg: null, alert: (localStorage.getItem('wl_alert') !== '0'), day: null,
                // Persistent modality/exam cache (keyed per order) so a live refresh never
                // re-runs the heavy per-order HIS enrichment for rows we've already resolved —
                // the board updates instantly and only genuinely-new orders trigger the slow pass.
                modCache: new Map() };

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

// Live board: refresh on a timer so a newly-arrived order shows up without the
// operator touching anything (the whole point — they never open Siratech).
const WL_REFRESH_MS = 45000;

// Local (KSA) date as YYYY-MM-DD — the operator is in KSA so the browser's local
// date IS the hospital's operational day. The board is viewed one day at a time.
function wlTodayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function wlShiftDay(delta) {
  const base = wlState.day || wlTodayLocal();   // shifting from "Recent" starts at today
  const [y, m, d] = base.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  wlState.day = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  wlState.seenEmerg = null;            // different scope = different set; no false alarm
  wlSyncDayControls();
  wlLoad(true);
}
function wlSetDay(v) { if (!v) return; wlState.day = v; wlState.seenEmerg = null; wlSyncDayControls(); wlLoad(true); }
// "Recent" = the rolling default (no date pin) → shows today + every still-pending
// prior-day order, so nothing pending vanishes at midnight.
function wlGoRecent() { wlState.day = null; wlState.seenEmerg = null; wlSyncDayControls(); wlLoad(true); }
function wlSyncDayControls() {
  const i = document.getElementById('wl-day'); if (i) i.value = wlState.day || '';
  const rb = document.getElementById('wl-recent-btn');
  if (rb) rb.className = 'btn btn-sm ' + (wlState.day ? 'btn-ghost' : 'btn-primary');
}

// A new EMERGENCY order arriving is the one event a radiology operator must not
// miss — so on the live board we chime + raise a desktop notification the moment
// one appears (never for orders already on screen at first load).
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
    beep(0, 880); beep(0.32, 1175);   // two-tone chime
    setTimeout(() => { try { ac.close(); } catch (e) {} }, 1200);
  } catch (e) { /* audio blocked — the visual badge + toast still fire */ }
}
function wlNotify(newOnes) {
  const n = newOnes.length;
  const first = newOnes[0] || {};
  const msg = n === 1
    ? `${first.patientName || first.mrno || 'A patient'} · ${first.branch || ''}`.trim()
    : `${n} new emergency orders`;
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('🚨 New emergency radiology order', { body: msg, tag: 'wl-emergency' });
    }
  } catch (e) { /* ignore */ }
  if (typeof toast === 'function') toast(`🚨 New emergency: ${msg}`, 'err');
}
// Compare the current emergency orders to the ones we've already seen; chime on
// genuinely new ones. First load seeds the set silently (no alarm for a backlog).
// Key an order for the seen-set: prefer genPatBillingId but fall back to bill/MRN so
// an emergency order that arrives WITHOUT a genPatBillingId still chimes (the one
// event the operator must not miss).
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
  if (fresh.length && wlState.alert) { wlBeep(); wlNotify(fresh); }
}
function wlToggleAlert() {
  wlState.alert = document.getElementById('wl-alert').checked;
  localStorage.setItem('wl_alert', wlState.alert ? '1' : '0');
  if (wlState.alert && 'Notification' in window && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (e) {}
  }
}

async function renderWorklistPage() {
  setTopbar('Radiology worklist', 'Orders awaiting a result — file the ready ones');
  // Default view = rolling recent window (keeps today + every still-pending prior-day
  // order). day === null means "recent/all pending"; picking a date drills to that day.
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Worklist', 'Radiology worklist', 'Every order awaiting a result — emergency first, oldest first')}
    <div id="wl-autofile"></div>
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <div style="display:flex;gap:4px;align-items:center">
          <button id="wl-recent-btn" class="btn btn-sm ${wlState.day ? 'btn-ghost' : 'btn-primary'}" onclick="wlGoRecent()" title="All still-pending orders (recent)">Recent</button>
          <button class="btn btn-sm btn-ghost" onclick="wlShiftDay(-1)" title="Previous day">◀</button>
          <input type="date" id="wl-day" class="input" value="${wlState.day || ''}" onchange="wlSetDay(this.value)" style="width:140px" title="Drill down to one day">
          <button class="btn btn-sm btn-ghost" onclick="wlShiftDay(1)" title="Next day">▶</button>
        </div>
        <select id="wl-branch" class="input" style="min-width:160px" onchange="wlOnBranch()">
          <option value="">All branches</option>
        </select>
        <input id="wl-search" class="input" placeholder="🔍 Find patient (file / ID / iqama / mobile) — all branches"
               style="min-width:230px;flex:1" onkeydown="if(event.key==='Enter')wlSearch(this.value)">
        <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--muted)" title="Group by pipeline stage: Ordered → Imaged → Report ready (checks DePACS, slower)">
          <input type="checkbox" id="wl-ready" onchange="wlToggleReady()"> Show stage (slower)
        </label>
        <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--muted)">
          <input type="checkbox" id="wl-live" checked onchange="wlToggleLive()"> Live
        </label>
        <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--muted)" title="Chime + notify on a new emergency order">
          <input type="checkbox" id="wl-alert" ${wlState.alert ? 'checked' : ''} onchange="wlToggleAlert()"> 🔔 Emergency alert
        </label>
        <button class="btn btn-sm btn-primary" onclick="wlLoad(true)">↻ Refresh</button>
        <span id="wl-summary" style="font-size:12px;color:var(--muted);margin-left:auto"></span>
      </div>
    </div>
    <div id="wl-body"></div>`;
  // Only org-wide roles can switch the board between branches; a branch team lead is
  // scoped to their own branch server-side, so we DON'T offer them a picker that the
  // server would silently ignore — we lock it and point them at the search box (which
  // finds a patient across every branch). This is the "per-branch" control done right.
  const canSwitch = wlCanSwitchBranch();
  const sel = document.getElementById('wl-branch');
  if (sel && !canSwitch) {
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
    } catch (e) { /* branch picker is optional; superadmin/manager can still see all */ }
  }
  wlLoadAutofile();
  wlLoad();
  wlStartTimer();
}

function wlStartTimer() {
  if (wlState.timer) clearInterval(wlState.timer);
  wlState.timer = setInterval(() => {
    // Page navigated away → the board is gone; stop polling and free the timer.
    if (!document.getElementById('wl-body')) { clearInterval(wlState.timer); wlState.timer = null; return; }
    if (document.hidden) return;               // don't poll a backgrounded tab
    wlLoad(false, true);                        // silent refresh — never blanks the board
  }, WL_REFRESH_MS);
}
function wlToggleLive() {
  if (document.getElementById('wl-live').checked) wlStartTimer();
  else if (wlState.timer) { clearInterval(wlState.timer); wlState.timer = null; }
}

// Changing the branch/filter shows a different set of orders — re-seed the
// emergency baseline so switching scope never fires a false "new emergency" alarm.
function wlOnBranch() { wlState.site = document.getElementById('wl-branch').value; wlState.seenEmerg = null; wlLoad(); }
function wlToggleReady() { wlState.ready = document.getElementById('wl-ready').checked; wlLoad(true); }

async function wlLoad(force, silent) {
  const body = document.getElementById('wl-body');
  if (!body || wlState.loading) return;
  wlState.loading = true;
  if (!silent) body.innerHTML = LOADING_HTML;   // silent = timer refresh, keep the board visible
  const qs = new URLSearchParams();
  if (wlState.site) qs.set('sites', wlState.site);
  if (wlState.ready) qs.set('ready', '1');
  if (wlState.day) { qs.set('from', wlState.day); qs.set('to', wlState.day); }   // one day at a time
  if (force) qs.set('nocache', '1');
  try {
    // Load the board FAST (no modality) so it appears immediately, then enrich
    // modality in the background — a per-order HIS call for ~80 rows is too slow
    // to block the first paint.
    wlState.data = await API.get('/radiology/worklist?' + qs.toString());
    wlHydrateModality();                          // paint known modality/exam instantly from cache
    wlRender();
    if (silent) wlLoadAutofile();               // keep the auto-file banner fresh too
    wlEnrichModality();                          // fills only the rows still missing modality
  } catch (e) {
    if (!silent) body.innerHTML = `<div class="empty" style="padding:24px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(e.message || 'Failed to load the worklist')}</p>
      <button class="btn btn-sm" onclick="wlLoad(true)">Retry</button></div>`;
  } finally { wlState.loading = false; }
}

// Paint modality/exam onto the freshly-loaded (fast, modality-less) board straight
// from the persistent cache, so a live refresh shows the badges INSTANTLY without
// waiting on — or even firing — the slow enrichment pass for rows we already know.
function wlHydrateModality() {
  const items = (wlState.data && wlState.data.items) || [];
  for (const it of items) {
    if (it.modality || it.exam) continue;          // the board already carried it
    const c = wlState.modCache.get(wlRowKey(it));
    if (c) { if (c.modality) it.modality = c.modality; if (c.exam) it.exam = c.exam; }
  }
}

// Second pass: fetch the same worklist with modality=1 (slow — a RadiologyDetails
// call per order) and merge the modality onto the already-rendered rows. Skipped
// entirely when every visible row is already resolved (from the cache) — so on a
// steady board the 45s live refresh is light and instant, and the heavy HIS fan-out
// only runs when a genuinely new, unseen order appears. Never blocks the board; if
// it fails or times out the rows just keep whatever modality they already had.
let _wlModBusy = false;
async function wlEnrichModality() {
  if (_wlModBusy) return;
  const items = (wlState.data && wlState.data.items) || [];
  const needed = items.some((it) => !it.modality && !it.exam);
  if (!needed) return;                              // nothing new to resolve → no heavy call
  _wlModBusy = true;
  const qs = new URLSearchParams();
  if (wlState.site) qs.set('sites', wlState.site);
  if (wlState.ready) qs.set('ready', '1');
  if (wlState.day) { qs.set('from', wlState.day); qs.set('to', wlState.day); }
  qs.set('modality', '1');
  try {
    const d = await API.get('/radiology/worklist?' + qs.toString());
    if (wlState.modCache.size > 2000) wlState.modCache.clear();   // bound memory on a long-lived kiosk
    const enr = new Map();
    for (const it of (d.items || [])) if (it.modality || it.exam) {
      const k = wlRowKey(it), v = { modality: it.modality, exam: it.exam };
      enr.set(k, v);
      wlState.modCache.set(k, v);                   // remember it so future refreshes stay light
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
  } catch (e) { /* modality/exam is best-effort — leave empty on failure */ }
  finally { _wlModBusy = false; }
}

// Auto-file status banner: shows whether the platform is filing verified reports
// into Siratech on its own. Superadmin gets an on/off switch; everyone else sees
// the live state so they know the board self-clears.
async function wlLoadAutofile() {
  const host = document.getElementById('wl-autofile');
  if (!host) return;
  try { wlState.autofile = await API.get('/radiology/autofile/config'); }
  catch (e) { host.innerHTML = ''; return; }
  const a = wlState.autofile || {};
  const on = !!a.enabled;
  const isSuper = (typeof currentUser !== 'undefined' && currentUser && currentUser.role === 'superadmin');
  const last = a.lastFiledAt ? `Last auto-filed ${escapeHtml(a.lastFiledFile || '')} · ${wlWhen(a.lastFiledAt)}` : 'Nothing auto-filed yet';
  const toggle = isSuper
    ? `<button class="btn btn-sm ${on ? 'btn-ghost' : 'btn-primary'}" onclick="wlSetAutofile(${on ? 'false' : 'true'})">${on ? 'Turn OFF' : 'Turn ON'}</button>`
    : '';
  host.innerHTML = `<div class="card" style="margin-bottom:12px;padding:12px;border-left:3px solid ${on ? 'var(--success,#2e9e6b)' : 'var(--muted,#888)'}">
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <div style="font-size:20px">${on ? '🟢' : '⚪'}</div>
      <div style="flex:1;min-width:200px">
        <div style="font-weight:700">Auto-file ${on ? 'is ON' : 'is OFF'}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">
          ${on ? `Verified reports are filed into Siratech automatically every ${Math.round((a.everySec||180)/60)} min — no manual step.` : 'Reports must be filed by hand from Handoff.'}
          · ${last}</div>
      </div>
      ${toggle}
    </div></div>`;
}

async function wlSetAutofile(enabled) {
  if (enabled && !confirm('Turn ON automatic filing?\n\nThe platform will write VERIFIED reports (exactly-one-study matches only) into the live Siratech HIS by itself. Anything ambiguous is left for manual review.')) return;
  try {
    wlState.autofile = await API.post('/radiology/autofile/config', { enabled: !!enabled });
    wlLoadAutofile();
    toast(enabled ? 'Auto-file turned ON' : 'Auto-file turned OFF');
  } catch (e) { toast(e.message || 'Could not change auto-file', 'err'); }
}

function wlWhen(iso) {
  try {
    const d = new Date(iso), diff = (Date.now() - d.getTime()) / 60000;
    if (diff < 1) return 'just now';
    if (diff < 60) return `${Math.round(diff)} min ago`;
    if (diff < 1440) return `${Math.round(diff / 60)}h ago`;
    return d.toLocaleDateString();
  } catch (e) { return ''; }
}

// The RIS pipeline stages, in order. Each is detected from a specific signal:
//   ordered  — order line present in Siratech (RadiologySearch filterResult=0), no images yet
//   imaged   — a study exists in DePACS/PACS for the patient (scan performed), not yet reported
//   reported — the DePACS study is VERIFIED (signed report) → ready to file into Siratech
// (filed/done = result entered in Siratech → the order drops off this board entirely)
const WL_STAGES = [
  { key: 'reported', label: '✅ Report ready — file it', color: '#2e9e6b' },
  { key: 'imaged',   label: '📷 Imaged — awaiting report', color: '#e0a800' },
  { key: 'ordered',  label: '📋 Ordered — awaiting imaging', color: '#6b7280' },
];

function wlRender() {
  const d = wlState.data || {}, items = d.items || [];
  wlCheckNewEmergencies(items);   // chime on any genuinely new emergency order
  const sum = document.getElementById('wl-summary');
  if (sum) sum.textContent = `${d.total || 0} awaiting · ${d.emergency || 0} emergency`
    + (d.readyChecked ? ` · checked ${d.readyChecked}` : '')
    + (d.sites && d.sites.failed && d.sites.failed.length ? ` · ${d.sites.failed.length} branch(es) unreachable` : '');
  const body = document.getElementById('wl-body');
  if (!body) return;
  if (!items.length) { body.innerHTML = `<div class="empty" style="padding:26px"><p>No orders awaiting a result.</p></div>`; return; }
  // If pipeline stages are known (the "Show stage" / ready pass ran), SEGMENT the
  // board into Ordered → Imaged → Report-ready sections so the operator sees where
  // every order is. Otherwise render a flat list.
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
  // Anything with an unknown stage (beyond the checked cap) goes last, unlabeled.
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
    const label = info ? info.label : k;
    const bg = info ? info.bg : '#8a8f98';
    return `<span class="badge" style="background:${bg};color:#fff">${escapeHtml(label)}</span>`;
  }).join(' ');
}

// A female patient needs a signed non-pregnancy consent BEFORE imaging. Detect
// female from the HIS gender, and surface the consent state right on the board.
function wlIsFemale(g) {
  const s = String(g || '').trim().toLowerCase();
  return s.startsWith('f') || /أنث|انث/.test(s);
}
function wlConsentEl(it) {
  if (!wlIsFemale(it.gender)) return '';
  if (it.consentOnFile) return '<span class="badge badge-green" title="Non-pregnancy consent signed">✓ Consent</span>';
  return `<button class="btn btn-sm" style="background:#e0a800;color:#fff;border:none" title="Sign the non-pregnancy consent before imaging" onclick="wlConsent('${jsAttr(it.mrno)}','${jsAttr(it.patientName || '')}','${jsAttr(it.exam || '')}')">⚠ Consent needed</button>`;
}
function wlConsent(mrno, name, exam) {
  // QR flow: her data is pre-printed on the official form, the patient scans the QR,
  // opens it on HER OWN phone, reads, agrees and signs, and it reflects straight back
  // here (the board refreshes to ✓ Consent). Falls back to sign-on-this-device.
  const prefill = { file_no: mrno, mrno: mrno, mrn: mrno, name: name, procedure: exam };
  if (typeof openConsentQR === 'function') { openConsentQR(prefill, () => wlLoad(true)); return; }
  if (typeof openConsent === 'function') { openConsent(prefill, () => wlLoad(true)); return; }
  if (typeof toast === 'function') toast('Consent module unavailable', 'err');
}

function wlRow(it, i) {
  // Badge from the real pipeline STAGE, not a bare ready flag: "awaiting report" only
  // when a study is actually imaged-but-unread in PACS; a not-yet-imaged order shows
  // "awaiting imaging", never "awaiting report".
  const readyBadge = it.stage === 'reported' ? `<span class="badge badge-green">✅ report ready</span>`
    : it.stage === 'imaged' ? `<span class="badge badge-orange">📷 awaiting report</span>`
      : it.stage === 'ordered' ? `<span class="badge">📋 awaiting imaging</span>`
        : (it.readyToFile === true ? `<span class="badge badge-green">report ready</span>` : '');
  const age = wlAge(it.ageHours);
  return `<div class="card wl-card" style="margin-bottom:8px;padding:12px${it.emergency ? ';border-left:3px solid var(--danger,#E25555)' : ''}">
    <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div style="font-weight:700">${escapeHtml(it.patientName || '—')}
          <span style="color:var(--muted);font-weight:500">· ${escapeHtml(it.mrno)}</span></div>
        ${it.exam ? `<div style="font-size:13px;font-weight:600;color:var(--text,#1a1a2e);margin-top:3px">🩻 ${escapeHtml(it.exam)}</div>` : ''}
        <div style="font-size:12px;color:var(--muted);margin-top:2px">${escapeHtml(it.branch || '')}${it.department ? ' · ' + escapeHtml(it.department) : ''}${it.doctorName ? ' · ' + escapeHtml(it.doctorName) : ''}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${wlModBadges(it.modality)}
        ${wlConsentEl(it)}
        ${it.emergency ? '<span class="badge badge-red">Emergency</span>' : '<span class="badge">Routine</span>'}
        ${age ? `<span class="badge badge-purple" title="time since ordered">${age}</span>` : ''}
        ${readyBadge}
        <button class="btn btn-sm btn-ghost" onclick="wlToggle(${i}, '${jsAttr(it.mrno)}', ${it.site || 0}, this)">Check report</button>
        <button class="btn btn-sm btn-primary" onclick="wlOpenHandoff('${jsAttr(it.mrno)}')">Open in Handoff →</button>
      </div>
    </div>
    <div class="wl-detail" id="wl-d-${i}" style="display:none;margin-top:10px"></div>
  </div>`;
}

// Read-only drill: match the finished DePACS report(s) to this patient's order(s).
async function wlToggle(i, mrno, site, btn) {
  const box = document.getElementById('wl-d-' + i);
  if (!box) return;
  if (box.style.display === 'block') { box.style.display = 'none'; btn.textContent = 'Check report'; return; }
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
    + `<div style="font-size:12px;color:var(--muted);margin-top:2px">Use <b>Open in Handoff</b> to file + authorize the ready report.</div>`;
}

// Deep-link into the trusted Handoff wizard, pre-loaded with this patient's file.
function wlOpenHandoff(mrno) {
  window._handoffPreload = mrno;
  showPage('handoff');
}

// Cross-branch patient search from the worklist: find a patient by ANY identifier
// (file / national ID / iqama / mobile) across ALL branches — for a patient whose
// exam was ordered at a different branch — and open them in Handoff to see the exam.
async function wlSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  try {
    const d = await API.get('/radiology/find?q=' + encodeURIComponent(q));
    const pts = (d && d.patients) || [];
    if (!pts.length) { if (typeof toast === 'function') toast('No patient found for "' + q + '"', 'err'); return; }
    if (pts.length > 1 && typeof toast === 'function') toast(pts.length + ' matches — opening the first; refine to narrow');
    wlOpenHandoff(String(pts[0].mrno || pts[0].file_no || q));
  } catch (e) { if (typeof toast === 'function') toast(e.message || 'Search failed', 'err'); }
}
