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
                seenEmerg: null, from: wlTodayLocal(), to: wlTodayLocal(), filter: null, searchView: false,
                // Persistent per-order caches so a live refresh paints INSTANTLY and the
                // heavy per-order HIS work (modality/exam + pipeline stage) runs in the
                // background, only for rows we don't already know — never blocking paint.
                modCache: new Map(), stageCache: new Map(), pregCache: new Map(),
                // RIS-style worklist: which status bucket + modality is the board filtered to.
                statusTab: 'all', modFilter: null };

// Live board: refresh on a timer so a newly-arrived order (or a just-filed one
// dropping off) shows without the operator touching anything.
const WL_REFRESH_MS = 45000;

// Org-wide roles (superadmin/manager) can point the board at any branch; a branch
// team lead is server-scoped to their own branch, so the picker is locked for them.
function wlCanSwitchBranch() {
  return typeof currentUser !== 'undefined' && currentUser && ['manager', 'superadmin'].includes(currentUser.role);
}

// One canonical per-order key for the modality/stage caches and the enrichment
// merge. Only a genuinely unique id counts — billing id or bill no. If BOTH are
// absent we return null and the caller skips caching/merging that row, rather than
// fall back to mrno+date (two same-day orders for one patient would collide and swap
// each other's modality/stage). Keyless rows just re-enrich each pass — no swap.
function wlRowKey(it) {
  const base = it.genPatBillingId != null ? 'g' + it.genPatBillingId
    : it.billNo ? 'b' + it.billNo : null;
  if (base == null) return null;
  // A bill can bundle several exams (one board row per exam) — key each exam's row
  // separately or the caches would smear one exam's modality/stage onto its sibling.
  // Prefer the stable service id; fall back to the exam NAME (also stable) rather than
  // the per-response array index, which can reorder between the fast and enrich passes.
  const svc = it.svcId != null ? it.svcId : (it.exam ? 'x' + it.exam : null);
  return svc != null ? base + ':' + svc : base;
}

// Local (KSA) date as YYYY-MM-DD — the operator is in KSA so the browser's local
// date IS the hospital's operational day.
function wlTodayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// The board shows a date RANGE [from, to], defaulting to today only. Widen it with
// the From/To pickers, or step the whole window a day at a time.
// Leaving a search: changing range/branch must drop any active on-board filter or
// cross-branch match view, else the new board is fetched but never painted (the
// searchView guard blocks it) or the old MRN filter re-applies to the new data.
function wlExitSearch() {
  wlState.filter = null; wlState.searchView = false;
  const s = document.getElementById('wl-search'); if (s) s.value = '';
}
function _wlAddDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function wlShiftDay(delta) {   // step the whole [from,to] window by a day
  wlState.from = _wlAddDays(wlState.from, delta);
  wlState.to = _wlAddDays(wlState.to, delta);
  wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlLoad(true);
}
function wlSetFrom(v) {
  if (!v) return;
  wlState.from = v;
  if (wlState.to < v) wlState.to = v;                       // keep from <= to
  wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlLoad(true);
}
function wlSetTo(v) {
  if (!v) return;
  wlState.to = v;
  if (v < wlState.from) wlState.from = v;
  wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlLoad(true);
}
function wlTodayRange() {
  wlState.from = wlTodayLocal(); wlState.to = wlTodayLocal();
  wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlLoad(true);
}
function wlSyncDayControls() {
  const f = document.getElementById('wl-from'); if (f) f.value = wlState.from;
  const t = document.getElementById('wl-to'); if (t) t.value = wlState.to;
  const btn = document.getElementById('wl-today-btn');
  const isToday = wlState.from === wlTodayLocal() && wlState.to === wlTodayLocal();
  if (btn) btn.className = 'btn btn-sm ' + (isToday ? 'btn-primary' : 'btn-ghost');
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
  setTopbar('Radiology worklist', 'Live RIS status board · STAT first');
  wlState.filter = null; wlState.searchView = false;   // never reopen stuck in a search view
  wlState.from = wlTodayLocal(); wlState.to = wlTodayLocal();   // default: today only
  // A "Open in Worklist" jump from the Orders page pre-seeds this — land straight on
  // that patient (search finds them even if they're not on today's board).
  const jumpMrn = window._wlPendingFilter; window._wlPendingFilter = null;
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Worklist', 'Radiology worklist', 'Live status board — scheduled · imaged · reporting · reported')}
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <div style="display:flex;gap:4px;align-items:center">
          <button class="btn btn-sm btn-ghost" onclick="wlShiftDay(-1)" title="Previous day">◀</button>
          <span style="font-size:12px;color:var(--muted)">From</span>
          <input type="date" id="wl-from" class="input" value="${wlState.from}" onchange="wlSetFrom(this.value)" style="width:145px" title="From date">
          <span style="font-size:12px;color:var(--muted)">To</span>
          <input type="date" id="wl-to" class="input" value="${wlState.to}" onchange="wlSetTo(this.value)" style="width:145px" title="To date">
          <button class="btn btn-sm btn-ghost" onclick="wlShiftDay(1)" title="Next day">▶</button>
          <button id="wl-today-btn" class="btn btn-sm btn-primary" onclick="wlTodayRange()" title="Today only">Today</button>
        </div>
        <select id="wl-branch" class="input" style="min-width:160px" onchange="wlOnBranch()">
          <option value="">All branches</option>
        </select>
        <input id="wl-search" class="input" placeholder="🔍 Type file # to filter — or full ID / iqama / mobile"
               style="min-width:230px;flex:1" inputmode="numeric" autocomplete="off"
               oninput="wlLiveFilter(this.value)" onkeydown="if(event.key==='Enter')wlSearch(this.value)">
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
  await wlLoad();
  if (jumpMrn) {
    const inp = document.getElementById('wl-search');
    if (inp) inp.value = jumpMrn;
    wlSearch(jumpMrn);   // filters the board, or finds the patient cross-branch if not on it
  }
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
function wlOnBranch() { wlState.site = document.getElementById('wl-branch').value; wlState.seenEmerg = null; wlExitSearch(); wlLoad(); }

async function wlLoad(force, silent) {
  const body = document.getElementById('wl-body');
  if (!body || wlState.loading) return;
  wlState.loading = true;
  if (!silent && !wlState.filter) body.innerHTML = LOADING_HTML;
  // FAST load: no ready/modality — just the pending list, so the board paints in one
  // round-trip. The pipeline stage + exam/modality (per-order HIS work) come in a
  // background pass right after, and never block the first paint.
  const qs = new URLSearchParams();
  if (wlState.site) qs.set('sites', wlState.site);
  qs.set('from', wlState.from); qs.set('to', wlState.to);   // explicit range (defaults to today only)
  if (force) qs.set('nocache', '1');
  try {
    wlState.data = await API.get('/radiology/worklist?' + qs.toString());
    // The fast pass carries only a PRELIMINARY stage (from the HIS RIS status text),
    // which can be wrong ("Not Verified" etc). Demote it: it may hint the badge, but it
    // must NOT move a row into the imaged/reported strips — only the authoritative
    // DePACS stage (ready=1 pass) does that. This stops an imaged row from being
    // hidden then reappearing when a later pass overwrites the accurate stage.
    for (const it of (wlState.data.items || [])) {
      if (it.stage) { it.stagePrelim = it.stage; delete it.stage; }
    }
    wlHydrate();                                  // paint known modality/exam/stage instantly from cache
    wlRender();
    wlEnrich(silent);                             // background: fill stage + modality for unknown rows
  } catch (e) {
    if (!silent) {
      // In a search view, replacing the body with a retry card would wipe the results —
      // surface the failure as a toast instead so the operator still sees the error.
      if (wlState.filter || wlState.searchView) {
        if (typeof toast === 'function') toast(e.message || 'Refresh failed', 'err');
      } else {
        body.innerHTML = `<div class="empty" style="padding:24px"><div class="empty-icon">⚠️</div>
          <p>${escapeHtml(e.message || 'Failed to load the worklist')}</p>
          <button class="btn btn-sm" onclick="wlLoad(true)">Retry</button></div>`;
      }
    }
  } finally { wlState.loading = false; }
}

// Paint modality/exam AND pipeline stage onto the freshly-loaded board from the
// persistent caches, so a live refresh shows everything INSTANTLY without waiting on
// the slow enrichment pass for rows we already resolved.
wlState.scannedSeen = wlState.scannedSeen || new Set();
function wlHydrate() {
  const items = (wlState.data && wlState.data.items) || [];
  for (const it of items) {
    const k = wlRowKey(it);
    if (!k) continue;                              // keyless row → never restore from cache (collision-safe)
    if (!it.modality && !it.exam) { const c = wlState.modCache.get(k); if (c) { it.modality = c.modality; it.exam = c.exam; } }
    if (!it.stage) { const s = wlState.stageCache.get(k); if (s) it.stage = s; }
    // "scanned" is a hard fact (Siratech recorded the exam start/end) — once true it
    // stays true, so a later load where the RIS panel omitted the times can't drop the
    // row back off the Imaged strip.
    if (it.scanned) wlState.scannedSeen.add(k);
    else if (wlState.scannedSeen.has(k)) it.scanned = true;
  }
}

// Background pass: fetch the board WITH ready=1 (pipeline stage) + modality=1 (exam +
// modality) — the heavy per-order HIS work — and merge it onto the visible rows.
// Always runs on a manual/explicit load; on a silent live refresh it runs when a new
// row still lacks a stage OR it's been >2 min since the last enrich — so pipeline
// progress (ordered→imaged→report-ready) actually keeps updating on the live board,
// while a steady board stays light. Never blocks paint; caches results so paints are
// instant. Cache-restored stages are refreshed by the periodic re-check.
let _wlEnrichBusy = false;
async function wlEnrich(silent) {
  if (_wlEnrichBusy) return;
  const items = (wlState.data && wlState.data.items) || [];
  if (!items.length) return;
  const anyMissing = items.some((it) => !it.stage || !it.exam);
  // Re-check the pipeline stage on (almost) every live refresh so promotions
  // (ordered→imaged→reported) show within a poll — the DePACS lookups are now
  // short-window + cached on the connector, so this is cheap. The ratchet in
  // wlMergeEnrich guarantees a row never moves backward, so more-frequent checks
  // only ever fill in progress, never cause flicker.
  if (silent && !anyMissing && (Date.now() - (wlState.lastEnrich || 0) < 30000)) return;
  _wlEnrichBusy = true;
  // Show the loading shimmer on the not-yet-filled cells while this pass runs.
  if (anyMissing) { wlState.enriching = true; if (document.getElementById('wl-body')) wlRender(); }
  const mkQs = (flags) => {
    const qs = new URLSearchParams();
    if (wlState.site) qs.set('sites', wlState.site);
    qs.set('from', wlState.from); qs.set('to', wlState.to);
    for (const k of Object.keys(flags)) qs.set(k, flags[k]);
    return qs.toString();
  };
  // Two INDEPENDENT passes in parallel — this is what makes the board feel like the
  // native RIS panel. exam+modality is pure HIS work and returns quickly; the
  // pipeline stage does per-patient DePACS matching and is the slow one. The old
  // single combined request made the Exam/Type columns shimmer until the SLOWEST
  // work finished; now each pass merges + repaints the moment it lands.
  try {
    await Promise.all([
      // modality pass: exam+modality ONLY — must never touch the stage (it carries just
      // the preliminary stage, which would stomp the accurate one from the ready pass).
      API.get('/radiology/worklist?' + mkQs({ modality: '1' })).then((d) => wlMergeEnrich(d, false)).catch(() => {}),
      // ready pass: the authoritative DePACS-grounded stage.
      API.get('/radiology/worklist?' + mkQs({ ready: '1' })).then((d) => wlMergeEnrich(d, true)).catch(() => {}),
    ]);
    wlState.lastEnrich = Date.now();
  } finally {
    _wlEnrichBusy = false;
    // Settle: turn the shimmer off and repaint with whatever filled in (rows still
    // empty after this pass fall back to "—" — that's the connector's per-order cap).
    wlState.enriching = false;
    if (document.getElementById('wl-body')) wlRender();
  }
}

// The pipeline is monotonic: ordered → imaged → draft → reported. On the live board a
// row only moves FORWARD (images don't un-scan, a signed report doesn't un-sign; a row
// that's truly done leaves the board entirely). So we RATCHET the stage: a later pass
// may promote a row but must never demote it. This kills the flicker where an
// imaged/reported row briefly showed then dropped back to "ordered" because one
// ambiguous DePACS lookup (narrow window / modality miss / transient blip) disagreed.
const _WL_STAGE_RANK = { ordered: 0, imaged: 1, draft: 2, reported: 3 };
function wlStageRank(stage) {
  return stage in _WL_STAGE_RANK ? _WL_STAGE_RANK[stage] : -1;
}
// The highest stage we currently believe for a row, honouring the hard scan signal
// (scanned → at least imaged) so a ready pass can't hide a scanned row as "ordered".
function wlCurRank(it) {
  return Math.max(wlStageRank(it.stage), it.scanned ? _WL_STAGE_RANK.imaged : -1);
}

// Merge one enrichment pass onto the visible rows and repaint IMMEDIATELY — the
// sibling pass may still be running, but whatever this one filled shows now.
function wlMergeEnrich(d, isReady) {
  if (wlState.modCache.size > 3000) { wlState.modCache.clear(); wlState.stageCache.clear(); wlState.scannedSeen.clear(); }
  const enr = new Map();
  for (const it of ((d && d.items) || [])) {
    const k = wlRowKey(it);
    if (!k) continue;                            // keyless → don't cache/merge (collision-safe)
    enr.set(k, { modality: it.modality, exam: it.exam, stage: it.stage,
      accession: it.accession, accessionSource: it.accessionSource, pacsId: it.pacsId, cpacsUrl: it.cpacsUrl });
    if (it.modality || it.exam) wlState.modCache.set(k, { modality: it.modality, exam: it.exam });
    // Cache the HIGHEST stage ever seen for this row (ratchet), so a refresh restores
    // the furthest-along state instead of letting a weaker later reading win.
    if (isReady && it.stage) {
      const prev = wlState.stageCache.get(k);
      if (!prev || wlStageRank(it.stage) >= wlStageRank(prev)) wlState.stageCache.set(k, it.stage);
    }
  }
  if (enr.size && wlState.data && Array.isArray(wlState.data.items)) {
    for (const it of wlState.data.items) {
      const k = wlRowKey(it); if (!k) continue;
      const e = enr.get(k);
      if (!e) continue;
      if (e.modality && it.modality !== e.modality) it.modality = e.modality;
      if (e.exam && it.exam !== e.exam) it.exam = e.exam;
      // The deterministic accession link (+ PACS pointers) rides along when known.
      if (e.accession && !it.accession) { it.accession = e.accession; it.accessionSource = e.accessionSource; }
      if (e.pacsId && !it.pacsId) it.pacsId = e.pacsId;
      if (e.cpacsUrl && !it.cpacsUrl) it.cpacsUrl = e.cpacsUrl;
      // Stage is authoritative ONLY from the ready pass — and only ever moves forward.
      if (isReady && e.stage && wlStageRank(e.stage) > wlCurRank(it)) it.stage = e.stage;
    }
  }
  if (document.getElementById('wl-body')) wlRender();
}

// Pipeline stage → badge. Each stage is detected from a specific signal:
//   ordered  — order line present in Siratech, no images yet
//   imaged   — a study exists in DePACS/PACS (scan done), not yet reported
//   reported — the DePACS study is VERIFIED (signed) → auto-file files it and it
//              then drops off this board on its own.
function wlStageBadge(stage) {
  if (stage === 'reported') return '<span class="badge badge-green" title="Report signed — auto-file will file it, then it leaves the board">✅ Report ready</span>';
  if (stage === 'draft')    return '<span class="badge" style="background:#7c5cff;color:#fff" title="A report exists but is NOT verified yet — radiologist mid-report">📝 Not verified</span>';
  if (stage === 'imaged')   return '<span class="badge badge-orange" title="Images are in DePACS — nothing written yet">📷 Imaged</span>';
  if (stage === 'ordered')  return '<span class="badge" title="Ordered — images not in DePACS yet">📋 Ordered</span>';
  return '<span class="badge" style="opacity:.55">…</span>';
}

// The full radiology exam-status lifecycle, the way a real RIS (Epic Radiant, Sectra,
// Merge) models it, mapped onto the signals Meena has:
//   Scheduled/Ordered → Arrived → In progress → Completed(imaged) → Preliminary(draft)
//   → Final(reported)
// Returns { bucket, label, cls, icon } — bucket drives the status tabs, the rest the badge.
function wlRisStatus(it) {
  if (it.stage === 'reported')
    return { bucket: 'reported', label: 'Final report', cls: 'wl-st-final', icon: '✅' };
  if (it.stage === 'draft')
    return { bucket: 'reporting', label: 'Preliminary', cls: 'wl-st-prelim', icon: '📝' };
  if (it.stage === 'imaged' || it.scanned)
    return { bucket: 'imaged', label: 'Completed', cls: 'wl-st-done', icon: '📷' };
  if (it.examStartAt)
    return { bucket: 'waiting', label: 'In progress', cls: 'wl-st-prog', icon: '🔵' };
  if (it.arrivedAt)
    return { bucket: 'waiting', label: 'Arrived', cls: 'wl-st-arr', icon: '🟡' };
  return { bucket: 'waiting', label: 'Scheduled', cls: 'wl-st-sched', icon: '📋' };
}
const _WL_BUCKETS = [
  { key: 'all',       label: 'All',        icon: '▦' },
  { key: 'waiting',   label: 'To scan',    icon: '🕐' },
  { key: 'imaged',    label: 'Imaged',     icon: '📷' },
  { key: 'reporting', label: 'Reporting',  icon: '📝' },
  { key: 'reported',  label: 'Reported',   icon: '✅' },
];
// Switching the view re-indexes rows, so drop any open drills (their positional keys
// would otherwise restore onto a different patient's row).
function wlSetTab(t) { wlState.statusTab = t; if (wlState.openDrills) wlState.openDrills.clear(); wlRender(); }
function wlSetMod(m) { wlState.modFilter = (m === '' || wlState.modFilter === m) ? null : m; if (wlState.openDrills) wlState.openDrills.clear(); wlRender(); }
// Modality of a row, normalised to the coarse RIS bucket for filtering.
function wlRowMod(it) {
  const raw = String(it.modality || it.exam || '').toUpperCase();
  for (const k of ['CT', 'MR', 'US', 'XR', 'MG']) if (raw.includes(k)) return k;
  if (/MRI/.test(raw)) return 'MR'; if (/X.?RAY|XR|CR|DR\b/.test(raw)) return 'XR';
  if (/ULTRA|SONO|US\b/.test(raw)) return 'US'; if (/MAMMO|MG\b/.test(raw)) return 'MG';
  return null;
}

function wlRender() {
  const d = wlState.data || {}, items = d.items || [];
  wlCheckNewEmergencies(items);
  // The main board is ONLY the pre-scan queue (who still needs consent + imaging).
  // The moment images land in DePACS the row moves to the "Imaged" strip; the moment
  // the report is signed it moves to the "Reported" strip (auto-file takes it from
  // there). Both strips open with one click, so nothing is ever silently lost.
  // `scanned` = Siratech recorded an exam start/end (a hard fact) → imaged, even before
  // the DePACS pass and regardless of the demoted preliminary stage text.
  // Bucket every row by its RIS status, and count per bucket for the tabs.
  for (const it of items) it.__bucket = wlRisStatus(it).bucket;
  const counts = { all: items.length, waiting: 0, imaged: 0, reporting: 0, reported: 0 };
  for (const it of items) counts[it.__bucket] = (counts[it.__bucket] || 0) + 1;
  const sum = document.getElementById('wl-summary');
  if (sum) sum.textContent = `${counts.waiting} to scan · ${counts.imaged} imaged · ${counts.reporting} reporting · ${counts.reported} reported`
    + (d.sites && d.sites.failed && d.sites.failed.length ? ` · ${d.sites.failed.length} branch(es) unreachable` : '');
  const body = document.getElementById('wl-body');
  if (!body) return;
  // A cross-branch search result view is showing — don't let a live refresh clobber it.
  if (wlState.searchView) return;
  // Live typeahead: as the operator types digits, filter the board to the MRNs that
  // START WITH what's typed (prefix), so the patient narrows down live — no need to
  // type the whole number or press Enter.
  if (wlState.filter) {
    const f = wlState.filter;
    const match = items.filter((it) => String(it.mrno || '').replace(/\D/g, '').startsWith(f));
    const banner = `<div style="display:flex;align-items:center;gap:8px;margin:2px 2px 12px">
      <span style="font-weight:700">${match.length} on this board starting with "${escapeHtml(f)}"</span>
      <button class="btn btn-sm btn-ghost" onclick="wlClearFilter()">← Back to full board</button></div>`;
    body.innerHTML = banner + (match.length
      ? wlTable(match)
      : `<div class="empty" style="padding:20px"><p>No patient on this board starts with "${escapeHtml(f)}".${f.length >= 6 ? ' Press Enter to search all branches.' : ''}</p></div>`);
    wlAutoPreg();
    return;
  }
  if (!items.length) { body.innerHTML = `<div class="empty" style="padding:26px"><p>No orders awaiting a result.</p></div>`; return; }

  // ── RIS status tabs (worklist buckets) ──────────────────────────────────────
  if (!(wlState.statusTab in counts)) wlState.statusTab = 'all';
  const tabs = _WL_BUCKETS.map((b) => {
    const n = counts[b.key] || 0;
    const on = wlState.statusTab === b.key;
    return `<button class="wl-tab${on ? ' on' : ''}" onclick="wlSetTab('${b.key}')">
      <span>${b.icon}</span><span>${b.label}</span><span class="wl-tab-n">${n}</span></button>`;
  }).join('');

  // ── Modality filter chips (only modalities actually present) ────────────────
  const present = new Set(items.map(wlRowMod).filter(Boolean));
  const MOD_ORDER = [['CT', 'CT'], ['MR', 'MRI'], ['US', 'US'], ['XR', 'X-Ray'], ['MG', 'Mammo']];
  const modChips = present.size > 1 ? `<div class="wl-modbar">
      <button class="wl-mchip${!wlState.modFilter ? ' on' : ''}" onclick="wlSetMod('')">All</button>
      ${MOD_ORDER.filter(([k]) => present.has(k)).map(([k, lbl]) =>
        `<button class="wl-mchip${wlState.modFilter === k ? ' on' : ''}" onclick="wlSetMod('${k}')">${lbl}</button>`).join('')}
    </div>` : '';

  // Filter to the selected bucket + modality.
  let rows = items;
  if (wlState.statusTab !== 'all') rows = rows.filter((it) => it.__bucket === wlState.statusTab);
  if (wlState.modFilter) rows = rows.filter((it) => wlRowMod(it) === wlState.modFilter);

  const bar = `<div class="wl-tabbar">${tabs}</div>${modChips}`;
  body.innerHTML = bar + (rows.length
    ? wlTable(rows, 'a')
    : `<div class="empty" style="padding:22px"><p>Nothing in this view.</p></div>`);
  wlRestoreOpenState();   // a live refresh must not collapse drills the operator opened
  wlAutoPreg();           // auto-check pregnancy status for female rows (throttled, cached)
}

// Which strips + Check drills the operator has open — preserved across every repaint
// (live refresh, enrichment merge) so the board never "resets" under their hands.
wlState.openStrips = wlState.openStrips || new Set();
wlState.openDrills = wlState.openDrills || new Set();
function wlRestoreOpenState() {
  for (const id of wlState.openStrips) {
    const list = document.getElementById(`wl-${id}-list`), arrow = document.getElementById(`wl-${id}-arrow`);
    if (list) { list.style.display = ''; if (arrow) arrow.textContent = '▾'; }
  }
  for (const key of wlState.openDrills) {
    const row = document.getElementById('wl-dr-' + key), box = document.getElementById('wl-d-' + key);
    if (!row) { wlState.openDrills.delete(key); continue; }   // its row left the board
    row.style.display = '';
    const cached = wlState.drillHtml && wlState.drillHtml.get(key);
    if (box && cached) box.innerHTML = cached;                // restore last result, no refetch flicker
  }
}
function wlToggleStrip(id) {
  const list = document.getElementById(`wl-${id}-list`), arrow = document.getElementById(`wl-${id}-arrow`);
  if (!list) return;
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : '';
  if (arrow) arrow.textContent = open ? '▸' : '▾';
  if (open) wlState.openStrips.delete(id); else wlState.openStrips.add(id);
}

// RIS worklist table. Sort the way a real RIS orders an actionable queue: STAT /
// emergency pinned to the very top, then LONGEST-WAITING first (highest age) so the
// order breaching its turnaround is never buried under fresh arrivals.
function wlTable(items, prefix) {
  const p = prefix || 'a';   // namespace row ids — several tables coexist
  const border = { waiting: 0, imaged: 1, reporting: 2, reported: 3 };
  const bk = (it) => border[it.__bucket != null ? it.__bucket : wlRisStatus(it).bucket] ?? 0;
  const rows = items.slice().sort((a, b) =>
    (Number(b.emergency) - Number(a.emergency))     // STAT / emergency always on top
    || (bk(a) - bk(b))                              // then by workflow phase (to-scan → reported)
    || ((a.ageHours || 0) - (b.ageHours || 0)));    // then NEWEST first (freshest order on top)
  return `<div class="table-wrap"><table class="wl-table" style="width:100%">
    <thead><tr>
      <th>Patient</th><th>Exam</th><th>Ordered</th><th>Status</th><th>Safety</th><th style="width:64px"></th>
    </tr></thead>
    <tbody>${rows.map((it, i) => wlRow(it, p + i)).join('')}</tbody>
  </table></div>`;
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
// Radiation-safety decision support: for a female patient of child-bearing age,
// let the tech check β-hCG / pregnancy lab status BEFORE imaging — on demand, per
// patient (never auto for the whole board: each check is 2 HIS lab searches). The
// verdict is cached so a live refresh keeps it. This never blocks imaging — it just
// surfaces what Siratech's lab module already knows.
function wlPregEl(it) {
  if (!wlIsFemale(it.gender)) return '';
  const mr = String(it.mrno || '');
  const cached = wlState.pregCache.get(mr);
  const id = 'wl-preg-' + mr.replace(/[^A-Za-z0-9_-]/g, '');
  if (cached) return `<span id="${id}">${wlPregBadge(cached)}</span>`;
  // Auto-checks in the background (wlAutoPreg) — no click needed.
  return `<span id="${id}"><span class="badge" style="background:var(--card-alt);color:var(--muted);border:1px solid var(--border)" title="Checking pregnancy / β-hCG status…">🤰 <span class="wl-shimmer" style="width:40px;display:inline-block;vertical-align:middle"></span></span></span>`;
}
// Automatically check pregnancy status for every female row on the visible board —
// no button. Throttled (small concurrency) and cached, so a 30-row board makes a
// steady trickle of calls instead of a burst, and a live refresh never re-fetches
// a patient we already know.
let _wlPregBusy = 0;
const _WL_PREG_MAX = 2;
const _wlPregQueue = [];
function wlAutoPreg() {
  const items = (wlState.data && wlState.data.items) || [];
  const seen = new Set(_wlPregQueue.map((x) => x.mr));
  for (const it of items) {
    if (!wlIsFemale(it.gender)) continue;
    const mr = String(it.mrno || '');
    if (!mr || wlState.pregCache.has(mr) || seen.has(mr)) continue;
    seen.add(mr);
    _wlPregQueue.push({ mr, site: Number(it.site) || 0 });
  }
  wlPregPump();
}
function wlPregPump() {
  while (_wlPregBusy < _WL_PREG_MAX && _wlPregQueue.length) {
    const { mr, site } = _wlPregQueue.shift();
    if (wlState.pregCache.has(mr)) continue;
    _wlPregBusy++;
    const qs = new URLSearchParams({ mrno: mr }); if (site) qs.set('site', String(site));
    API.get('/radiology/labs/pregnancy?' + qs.toString())
      .then((r) => {
        wlState.pregCache.set(mr, r);
        const el = document.getElementById('wl-preg-' + mr.replace(/[^A-Za-z0-9_-]/g, ''));
        if (el) el.innerHTML = wlPregBadge(r);
      })
      .catch(() => { /* leave the shimmer; a later refresh retries */ })
      .finally(() => { _wlPregBusy--; wlPregPump(); });
  }
}
function wlPregBadge(r) {
  if (!r || !r.found || !r.hasPregnancyTest) {
    return '<span class="badge" style="background:#e0a800;color:#fff" title="No recent pregnancy / β-hCG lab found in Siratech — confirm status before imaging">🤰 No recent test</span>';
  }
  const when = r.resultDate || r.orderDate;
  const dstr = when ? (' · ' + escapeHtml(String(when).slice(0, 10))) : '';
  const nm = r.testName ? escapeHtml(String(r.testName)) : 'pregnancy test';
  if (r.verdict === 'positive') {
    return `<span class="badge badge-red" title="${nm}${r.resultText ? ' = ' + escapeHtml(String(r.resultText)) : ''} — POSITIVE. Do NOT irradiate without physician review.">🤰 POSITIVE${dstr}</span>`;
  }
  if (r.verdict === 'negative') {
    return `<span class="badge badge-green" title="${nm}${r.resultText ? ' = ' + escapeHtml(String(r.resultText)) : ''} — negative">🤰 Negative${dstr}</span>`;
  }
  if (r.resulted) {
    return `<span class="badge" style="background:#6b7280;color:#fff" title="${nm} resulted${r.resultText ? ' = ' + escapeHtml(String(r.resultText)) : ''} — read the value">🤰 Resulted${dstr}</span>`;
  }
  return `<span class="badge" style="background:#e0a800;color:#fff" title="${nm} ordered but result still pending">🤰 Test pending${dstr}</span>`;
}
async function wlPregCheck(mrno, site, id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'checking…'; }
  try {
    const qs = new URLSearchParams({ mrno }); if (site) qs.set('site', String(site));
    const r = await API.get('/radiology/labs/pregnancy?' + qs.toString());
    wlState.pregCache.set(String(mrno), r);
    const el = document.getElementById(id);
    if (el) el.innerHTML = wlPregBadge(r);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '🤰 Preg check'; }
    if (typeof toast === 'function') toast('Pregnancy lookup failed', 'err');
  }
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

// The RIS status badge (icon + label), coloured by workflow phase.
function wlRisStatusBadge(it) {
  const p = wlState.enriching;
  // While the stage is still being checked and we have no signal at all, shimmer.
  if (p && !it.stage && !it.scanned && !it.arrivedAt && !it.stagePrelim) return `<span class="wl-shimmer" style="width:70px"></span>`;
  const s = wlRisStatus(it);
  return `<span class="wl-st ${s.cls}"><span>${s.icon}</span>${escapeHtml(s.label)}</span>`;
}
function wlRow(it, key) {
  const edge = it.emergency ? 'box-shadow:inset 3px 0 0 var(--danger,#E25555);' : '';
  const age = wlAge(it.ageHours);
  // While the background HIS enrichment is still running, show a loading shimmer for
  // the exam instead of a bare "—" so the board reads as "loading", not broken.
  const p = wlState.enriching;
  const sh = (w) => `<span class="wl-shimmer" style="width:${w}px"></span>`;
  const dash = '<span style="color:var(--muted)">—</span>';
  const acc = it.accession || it.accessionNumber || null;
  const demo = [it.age, (it.gender ? String(it.gender).charAt(0).toUpperCase() : '')].filter(Boolean).map((x) => escapeHtml(String(x))).join(' · ');
  const ordered = it.orderedDate ? wlTrackFmt(it.orderedDate) : '';
  return `<tr style="${edge}">
    <td data-l="Patient"><div style="font-weight:700">${escapeHtml(it.patientName || '—')}
        ${it.emergency ? ' <span class="badge badge-red">STAT</span>' : ''}</div>
      <div style="font-size:11px;color:var(--muted)">${escapeHtml(it.mrno || '')}${demo ? ' · ' + demo : ''}</div>
      ${(it.branch || it.doctorName) ? `<div style="font-size:10.5px;color:var(--muted)">${escapeHtml(it.branch || '')}${it.branch && it.doctorName ? ' · ' : ''}${it.doctorName ? 'Dr ' + escapeHtml(it.doctorName) : ''}</div>` : ''}</td>
    <td data-l="Exam">${(() => { const mod = wlModBadges(it.modality);
      if (it.exam) return mod + ' <span>' + escapeHtml(it.exam) + '</span>';
      if (p) return mod + ' ' + sh(90);
      return mod || dash; })()}
      ${acc ? `<div style="font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums" title="DICOM accession">🔗 ${escapeHtml(String(acc))}</div>` : ''}</td>
    <td data-l="Ordered" style="white-space:nowrap;font-size:11.5px;color:var(--muted)">${ordered ? escapeHtml(ordered) : dash}</td>
    <td data-l="Status"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${wlRisStatusBadge(it)}${(age && it.__bucket !== 'reported') ? `<span style="font-size:11px;color:var(--muted)" title="waiting time">${age} waiting</span>` : ''}</div></td>
    <td data-l="Safety"><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">${wlConsentEl(it)}${wlPregEl(it)}</div></td>
    <td style="white-space:nowrap"><button class="btn btn-sm btn-ghost" onclick="wlToggle('${key}', '${jsAttr(it.mrno)}', ${Number(it.site) || 0}, this)">Open</button></td>
  </tr>
  <tr id="wl-dr-${key}" style="display:none"><td colspan="6" style="background:var(--card-alt,#f7f7fa);padding:10px">${wlTrack(it)}<div id="wl-d-${key}"></div></td></tr>`;
}

// Patient-journey tracker (RIS "arrival → exam → done"), built from Siratech's own
// FetchRISPanel timestamps already on the row. A horizontal stepper: each reached
// step is solid + shows its time; the gaps show how long each phase took. Purely
// from data we already have — no extra call.
function wlTrackFmt(s) {
  if (!s) return '';
  const t = wlParseTs(s);
  if (!t) return String(s).slice(0, 16).replace('T', ' ');
  const d = new Date(t);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function wlParseTs(s) {
  if (!s) return 0;
  const t = Date.parse(String(s));
  return isNaN(t) ? 0 : t;
}
function wlTrack(it) {
  const reported = it.stage === 'reported' || it.stage === 'draft';
  const steps = [
    { label: 'Ordered', at: it.orderedDate, on: !!it.orderedDate },
    { label: 'Arrived', at: it.arrivedAt, on: !!it.arrivedAt },
    { label: 'Exam started', at: it.examStartAt, on: !!it.examStartAt },
    { label: 'Exam done', at: it.examEndAt, on: !!(it.examEndAt || it.scanned) },
    { label: 'Reported', at: null, on: reported },
  ];
  // Nothing recorded beyond the order? Show a hint instead of a bare single dot.
  const anyTracking = it.arrivedAt || it.examStartAt || it.examEndAt;
  const dur = (a, b) => {
    const ta = wlParseTs(a), tb = wlParseTs(b);
    if (!ta || !tb || tb < ta) return '';
    const m = Math.round((tb - ta) / 60000);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };
  const node = (s, i) => {
    const color = s.on ? 'var(--accent,#2e9e6b)' : 'var(--border,#d0d0d5)';
    const prev = steps[i - 1];
    const gap = (i > 0 && prev && prev.at && s.at) ? dur(prev.at, s.at) : '';
    return `${i > 0 ? `<div style="flex:1;height:2px;background:${s.on && prev.on ? 'var(--accent,#2e9e6b)' : 'var(--border,#d0d0d5)'};position:relative;min-width:24px">${gap ? `<span style="position:absolute;top:-14px;left:50%;transform:translateX(-50%);font-size:9px;color:var(--muted);white-space:nowrap">${escapeHtml(gap)}</span>` : ''}</div>` : ''}
      <div style="display:flex;flex-direction:column;align-items:center;min-width:56px">
        <div style="width:11px;height:11px;border-radius:50%;background:${color};border:2px solid ${color}"></div>
        <div style="font-size:9.5px;margin-top:3px;color:${s.on ? 'var(--text)' : 'var(--muted)'};text-align:center;white-space:nowrap">${escapeHtml(s.label)}</div>
        ${s.on && s.at ? `<div style="font-size:9px;color:var(--muted);white-space:nowrap">${escapeHtml(wlTrackFmt(s.at))}</div>` : ''}
      </div>`;
  };
  return `<div style="margin-bottom:10px;padding:12px 8px 6px;background:var(--card,#fff);border:1px solid var(--border);border-radius:8px">
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Patient journey${anyTracking ? '' : ' · <span title="Siratech hasn\'t recorded arrival/exam times for this order yet">arrival &amp; exam times not recorded yet</span>'}</div>
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:2px;overflow-x:auto">${steps.map(node).join('')}</div>
  </div>`;
}

// Read-only drill: expand a detail row that matches the finished DePACS report(s) to
// this patient's order(s).
async function wlToggle(key, mrno, site, btn) {
  const row = document.getElementById('wl-dr-' + key), box = document.getElementById('wl-d-' + key);
  if (!row || !box) return;
  if (row.style.display !== 'none') { row.style.display = 'none'; btn.textContent = 'Check'; wlState.openDrills.delete(key); return; }
  row.style.display = ''; btn.textContent = 'Hide'; box.innerHTML = LOADING_HTML;
  wlState.openDrills.add(key);
  wlState.drillHtml = wlState.drillHtml || new Map();
  // Re-entrancy guard: the match call is heavy (DePACS lookup); a second click while
  // it's in flight must not fire a duplicate request.
  wlState._drillLoading = wlState._drillLoading || new Set();
  if (wlState._drillLoading.has(key)) return;
  wlState._drillLoading.add(key);
  try {
    const d = await API.get(`/radiology/results/match/${encodeURIComponent(mrno)}${site ? `?site=${site}` : ''}`);
    const html = wlMatch(d);
    // Cache FIRST so wlRestoreOpenState paints the result (not a blank box) if a
    // 45s silent refresh already repainted the board while we were awaiting.
    wlState.drillHtml.set(key, html);
    // …and write to the CURRENT node — the one captured before the await may have
    // been detached by that repaint, which left the drill stuck on "loading".
    const live = document.getElementById('wl-d-' + key);
    if (live && wlState.openDrills.has(key)) live.innerHTML = html;
  } catch (e) {
    const live = document.getElementById('wl-d-' + key);
    if (live) live.innerHTML = `<div class="ho-note">${escapeHtml(e.message || 'Result match failed')}</div>`;
  } finally {
    wlState._drillLoading.delete(key);
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

// Live typeahead as the operator types: filter the board to MRNs that START WITH the
// typed digits. Empty box → back to the full board. Purely local (no network), so it
// updates on every keystroke.
function wlLiveFilter(v) {
  const digits = String(v || '').replace(/\D/g, '');
  wlState.searchView = false;
  wlState.filter = digits || null;
  wlRender();
}

// Enter: the live prefix filter already narrows the board. If the typed number
// matches nobody on THIS board, do a TARGETED cross-branch find (real identifier,
// ≥6 digits) — the patient's exam was ordered at another branch.
async function wlSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  const digits = q.replace(/\D/g, '');
  if (!digits) return;
  // On THIS board (prefix)? The live filter is already showing them — keep it.
  const items = (wlState.data && wlState.data.items) || [];
  if (items.some((it) => String(it.mrno || '').replace(/\D/g, '').startsWith(digits))) {
    wlState.searchView = false; wlState.filter = digits; wlRender(); return;
  }
  // Not on this board → cross-branch find needs a full identifier.
  if (digits.length < 6) {
    if (typeof toast === 'function') toast('Nobody on this board. Type the full file # / ID / iqama / mobile to search other branches', 'err');
    return;
  }
  try {
    const d = await API.get('/radiology/find?q=' + encodeURIComponent(q));
    const pts = (d && d.patients) || [];
    if (!pts.length) { if (typeof toast === 'function') toast('No patient with this number on any branch', 'err'); return; }
    wlShowMatches(pts);
  } catch (e) { if (typeof toast === 'function') toast(e.message || 'Search failed', 'err'); }
}
function wlClearFilter() {
  wlState.filter = null; wlState.searchView = false;
  const s = document.getElementById('wl-search'); if (s) s.value = '';
  wlRender();
}
// Cross-branch matches (patient not on this board): show each with a consent button
// (female) + Open, right here — no auto-jump. A live refresh won't clobber this view
// (searchView guard); "Back" returns to the board.
function wlShowMatches(pts) {
  wlState.searchView = true; wlState.filter = null;
  const body = document.getElementById('wl-body');
  if (!body) return;
  const rows = pts.slice(0, 25).map((p) => {
    const mrn = String(p.mrno || p.file_no || '');
    const nm = p.patientName || p.name || '—';
    const sub = [p.gender, p.birthDate || p.dob, p.branch].filter(Boolean).map(escapeHtml).join(' · ');
    const consent = wlIsFemale(p.gender)
      ? `<button class="btn btn-sm" style="background:#e0a800;color:#fff;border:none" onclick="wlConsent('${jsAttr(mrn)}','${jsAttr(nm)}','','','${jsAttr(p.branch || '')}')">⚠ Consent</button>` : '';
    return `<div class="card" style="margin-bottom:6px;padding:10px;display:flex;justify-content:space-between;align-items:center;gap:10px">
      <div><div style="font-weight:700">${escapeHtml(nm)} <span style="color:var(--muted);font-weight:500">· ${escapeHtml(mrn)}</span></div>
        ${sub ? `<div style="font-size:12px;color:var(--muted)">${sub}</div>` : ''}</div>
      <div style="display:flex;gap:6px;align-items:center">${consent}
        <button class="btn btn-sm btn-primary" onclick="wlOpenHandoff('${jsAttr(mrn)}')">Open →</button></div></div>`;
  }).join('');
  body.innerHTML = `<div style="margin:6px 2px 10px;font-weight:700">${pts.length} found on other branches — pick the patient</div>${rows}
    <button class="btn btn-sm btn-ghost" style="margin-top:6px" onclick="wlClearFilter()">← Back to worklist</button>`;
}
