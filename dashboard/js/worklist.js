// ── RIS Worklist ──────────────────────────────────────────────────────────────
// Live board of every radiology order AWAITING a result across the branch(es):
// emergency first, oldest first, with a turnaround (TAT) age. Optionally checks
// which orders already have a VERIFIED DePACS report ready to file. Read-only here;
// the actual file+authorize is handed off to the trusted Handoff wizard so the
// clinical write path lives in one place.

let wlState = { branches: [], site: '', ready: false, data: null, loading: false, timer: null, autofile: null,
                seenEmerg: null, alert: (localStorage.getItem('wl_alert') !== '0'), day: null };

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
  const [y, m, d] = wlState.day.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  wlState.day = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  wlState.seenEmerg = null;            // different day = different set; no false alarm
  const inp = document.getElementById('wl-day'); if (inp) inp.value = wlState.day;
  wlLoad(true);
}
function wlSetDay(v) { if (!v) return; wlState.day = v; wlState.seenEmerg = null; wlLoad(true); }
function wlGoToday() {
  wlState.day = wlTodayLocal(); wlState.seenEmerg = null;
  const i = document.getElementById('wl-day'); if (i) i.value = wlState.day;
  wlLoad(true);
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
  if (!wlState.day) wlState.day = wlTodayLocal();
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Worklist', 'Radiology worklist', 'Every order awaiting a result — emergency first, oldest first')}
    <div id="wl-autofile"></div>
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <div style="display:flex;gap:4px;align-items:center">
          <button class="btn btn-sm btn-ghost" onclick="wlShiftDay(-1)" title="Previous day">◀</button>
          <input type="date" id="wl-day" class="input" value="${wlState.day}" onchange="wlSetDay(this.value)" style="width:150px">
          <button class="btn btn-sm btn-ghost" onclick="wlShiftDay(1)" title="Next day">▶</button>
          <button class="btn btn-sm btn-ghost" onclick="wlGoToday()" title="Jump to today">Today</button>
        </div>
        <select id="wl-branch" class="input" style="min-width:160px" onchange="wlOnBranch()">
          <option value="">All branches</option>
        </select>
        <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--muted)">
          <input type="checkbox" id="wl-ready" onchange="wlToggleReady()"> Check report-ready (slower)
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
  try {
    const b = await API.get('/radiology/branches');
    wlState.branches = (b && b.branches) || [];
    const sel = document.getElementById('wl-branch');
    if (sel) for (const br of wlState.branches) {
      const o = document.createElement('option');
      o.value = br.siteId; o.textContent = br.shortName || br.name || ('Branch ' + br.siteId);
      sel.appendChild(o);
    }
  } catch (e) { /* branch picker is optional; team leads are auto-scoped server-side */ }
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
    wlRender();
    if (silent) wlLoadAutofile();               // keep the auto-file banner fresh too
    wlEnrichModality();                          // fills the modality badges when ready
  } catch (e) {
    if (!silent) body.innerHTML = `<div class="empty" style="padding:24px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(e.message || 'Failed to load the worklist')}</p>
      <button class="btn btn-sm" onclick="wlLoad(true)">Retry</button></div>`;
  } finally { wlState.loading = false; }
}

// Second pass: fetch the same worklist with modality=1 (slow — a RadiologyDetails
// call per order) and merge the modality onto the already-rendered rows. Never
// blocks the board; if it fails or times out the rows just show no modality badge.
let _wlModBusy = false;
async function wlEnrichModality() {
  if (_wlModBusy) return;
  _wlModBusy = true;
  const qs = new URLSearchParams();
  if (wlState.site) qs.set('sites', wlState.site);
  if (wlState.ready) qs.set('ready', '1');
  if (wlState.day) { qs.set('from', wlState.day); qs.set('to', wlState.day); }
  qs.set('modality', '1');
  try {
    const d = await API.get('/radiology/worklist?' + qs.toString());
    const mod = new Map();
    for (const it of (d.items || [])) if (it.genPatBillingId != null && it.modality) mod.set(String(it.genPatBillingId), it.modality);
    if (mod.size && wlState.data && Array.isArray(wlState.data.items)) {
      let changed = false;
      for (const it of wlState.data.items) {
        const m = mod.get(String(it.genPatBillingId));
        if (m && it.modality !== m) { it.modality = m; changed = true; }
      }
      if (changed && document.getElementById('wl-body')) wlRender();
    }
  } catch (e) { /* modality is best-effort — leave badges empty on failure */ }
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
  body.innerHTML = items.map((it, i) => wlRow(it, i)).join('');
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

function wlRow(it, i) {
  const readyBadge = it.readyToFile === true ? `<span class="badge badge-green">report ready</span>`
    : it.readyToFile === false ? `<span class="badge badge-orange">awaiting report</span>` : '';
  const age = wlAge(it.ageHours);
  return `<div class="card wl-card" style="margin-bottom:8px;padding:12px${it.emergency ? ';border-left:3px solid var(--danger,#E25555)' : ''}">
    <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div style="font-weight:700">${escapeHtml(it.patientName || '—')}
          <span style="color:var(--muted);font-weight:500">· ${escapeHtml(it.mrno)}</span></div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">${escapeHtml(it.branch || '')}${it.department ? ' · ' + escapeHtml(it.department) : ''}${it.doctorName ? ' · ' + escapeHtml(it.doctorName) : ''}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${wlModBadges(it.modality)}
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
