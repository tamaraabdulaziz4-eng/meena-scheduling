// ── RIS Worklist — pure RIS panel + consent ───────────────────────────────────
// A clean radiology worklist mirroring the Siratech RIS panel: every order still
// AWAITING a result, one row each — patient, exam + modality, ordering doctor,
// priority, live pipeline stage, and turnaround age. Emergency first, newest first.
//
// It runs itself:
//  · the day is TODAY automatically (you can step to another day);
//  · the branch is YOUR branch automatically (org-wide roles can switch);
//  · it refreshes live, so a new order appears on its own;
//  · auto-file runs silently in the background — the moment a report is verified
//    it's filed into Siratech and the patient DROPS OFF this board by itself;
//  · a female patient shows a one-tap non-pregnancy consent right on her row.
// No knobs, no banners — just the board.

let wlState = { branches: [], site: '', data: null, loading: false, timer: null, liveTimer: null,
                seenEmerg: null, from: wlTodayLocal(), to: wlTodayLocal(), filter: null, searchView: false,
                // Persistent per-order caches so a live refresh paints INSTANTLY and the
                // heavy per-order HIS work (modality/exam + pipeline stage) runs in the
                // background, only for rows we don't already know — never blocking paint.
                modCache: new Map(), stageCache: new Map(), pregCache: new Map(),
                // Per-MRN clinical-indication index cache (bug #2 — inline row indication).
                indCache: new Map(),
                // Live-pill + watchdog bookkeeping (bug #3): the timestamp of the last
                // good load, a "reconnecting" flag, and a monotonic load generation so a
                // hung request that the watchdog gave up on can never paint stale data.
                lastGood: 0, reconnecting: false, _loadGen: 0,
                // ── Unified redesign render state (worklist UI v2) ──
                // A single status vocabulary per order, ratcheted forward; the active tab;
                // row density; the checkbox selection (by MRN) and expanded rows (by row uid);
                // and the left-panel filters (modality set / priority / doctor / sort).
                tab: 'all', density: 'compact',
                selMrns: new Set(), openRows: new Set(),
                fMods: new Set(), fPrio: '', fDoc: '', fSort: 'wait',
                _docSig: null, mobFilters: false,
                statusRatchet: new Map() };

// Live board: refresh on a timer so a newly-arrived order (or a just-filed one
// dropping off) shows without the operator touching anything. ~12s to feel like a live
// HIS terminal — the fast pass is light and shares one connector-cached fetch across all
// viewers (fast TTL ~12s), and the flicker-free repaint makes each tick seamless. Hidden
// tabs don't poll (see wlStartTimer), and the heavy DePACS pass stays throttled.
const WL_REFRESH_MS = 12000;

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
  if (btn) btn.className = 'tbtn' + (isToday ? ' today' : '');
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
  wlState._paintedOnce = false;                        // entrance animation once per visit
  wlState.reconnecting = false; wlState.lastGood = Date.now();
  wlState.from = wlTodayLocal(); wlState.to = wlTodayLocal();   // default: today only
  // Fresh redesign view state on every entry: default tab, compact rows, nothing
  // selected/expanded, no left-panel filters.
  wlState.tab = 'all'; wlState.density = 'compact';
  wlState.selMrns.clear(); wlState.openRows.clear();
  wlState.fMods.clear(); wlState.fPrio = ''; wlState.fDoc = ''; wlState.fSort = 'wait';
  wlState._docSig = null; wlState.mobFilters = false;
  // A "Open in Worklist" jump from the Orders page pre-seeds this — land straight on
  // that patient (search finds them even if they're not on today's board).
  const jumpMrn = window._wlPendingFilter; window._wlPendingFilter = null;
  const branch = (typeof currentUser !== 'undefined' && currentUser &&
    (currentUser.branchName || currentUser.branch || currentUser.siteName)) || '';
  const dateStr = new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const c = document.getElementById('content');
  // ── Slim top bar (approved mockup): brand · live pill · search · Today · Date ·
  //    branch · refresh. The controls live in the STATIC shell (not #wl-body) so a
  //    45s poll never interrupts typing or steals focus. ──
  c.innerHTML = `
    <div class="rw">
      <div class="rw-top">
        <div class="rw-title">
          <h1>Radiology Worklist</h1>
          <p>Live RIS board${branch ? ' · ' + escapeHtml(String(branch)) : ''} · ${escapeHtml(dateStr)}</p>
        </div>
        <span class="live" id="wl-live"><i></i>Live · updated 0s ago</span>
        <div class="rw-spacer"></div>
        <label class="rw-search">
          ${icon('search')}
          <input id="wl-search" placeholder="Name · MRN · accession" autocomplete="off"
                 oninput="wlLiveFilter(this.value)" onkeydown="if(event.key==='Enter')wlSearch(this.value)">
        </label>
        <div class="seg" title="Row density">
          <button id="rw-dCompact" class="on" onclick="wlSetDensity('compact')">Compact</button>
          <button id="rw-dDetailed" onclick="wlSetDensity('detailed')">Detailed</button>
        </div>
        <button class="ctrl mobfilter" onclick="wlToggleMobFilters()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M7 12h10M10 18h4"/></svg>Filters</button>
        <button class="ctrl tbtn today" id="wl-today-btn" onclick="wlTodayRange()">Today</button>
        <button class="ctrl" onclick="wlToggleDate()">${icon('calendar')}Date</button>
        <select id="wl-branch" class="ctrl wl-branchsel" onchange="wlOnBranch()">
          <option value="">All branches</option>
        </select>
        <button class="ctrl" title="Refresh now" onclick="wlLoad(true)">${icon('refresh')}</button>
        <div class="datepop rw-datepop" id="wl-datepop" style="display:none">
          <button class="ctrl icon" onclick="wlShiftDay(-1)" title="Previous day">‹</button>
          <span class="dl">From</span>
          <input type="date" id="wl-from" value="${wlState.from}" onchange="wlSetFrom(this.value)" title="From date">
          <span class="dl">To</span>
          <input type="date" id="wl-to" value="${wlState.to}" onchange="wlSetTo(this.value)" title="To date">
          <button class="ctrl icon" onclick="wlShiftDay(1)" title="Next day">›</button>
        </div>
      </div>

      <nav class="rw-tabs" id="rw-tabs"></nav>

      <div class="rw-main">
        <aside class="rw-filters" id="rw-filters">
          <div class="fgroup">
            <h4>Modality</h4>
            <div class="chips" id="rw-modchips"></div>
          </div>
          <div class="fgroup">
            <h4>Priority</h4>
            <div class="frow">
              <label class="fopt"><input type="radio" name="rw-prio" value="" checked onchange="wlSetPrio('')">All priorities</label>
              <label class="fopt"><input type="radio" name="rw-prio" value="stat" onchange="wlSetPrio('stat')">STAT / emergency only</label>
              <label class="fopt"><input type="radio" name="rw-prio" value="routine" onchange="wlSetPrio('routine')">Routine only</label>
            </div>
          </div>
          <div class="fgroup">
            <h4>Referring doctor</h4>
            <select class="fsel" id="rw-docsel" onchange="wlSetDoc(this.value)"><option value="">All doctors</option></select>
          </div>
          <div class="fgroup">
            <h4>Sort by</h4>
            <select class="fsel" id="rw-sortsel" onchange="wlSetSort(this.value)">
              <option value="wait">Oldest first</option>
              <option value="prio">Priority first</option>
              <option value="recent">Most recent order</option>
            </select>
          </div>
          <button class="fclear" onclick="wlResetFilters()">Clear all filters</button>
        </aside>

        <section class="rw-list">
          <div class="rw-scroll">
            <div class="rw-colhead" id="rw-colhead">
              <span></span>
              <span>Patient · MRN</span>
              <span>Exam</span>
              <span>Branch</span>
              <span>Status</span>
              <span style="text-align:right">Action</span>
            </div>
            <div class="rw-rows" id="wl-body"></div>
          </div>
        </section>
      </div>

      <div class="rw-actionbar" id="rw-actionbar">
        <div class="ab-info"></div>
        <span class="ab-count"></span>
        <div class="ab-acts"></div>
        <button class="ab-x" onclick="wlClearSel()" title="Clear selection"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
      </div>
    </div>`;

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
  wlStartLiveTicker();
}

// Reveal / hide the compact From–To date popover under the Date button.
function wlToggleDate() {
  const el = document.getElementById('wl-datepop');
  if (el) el.style.display = (el.style.display === 'none' ? '' : 'none');
}

// ── Live pill (bug #3) ──────────────────────────────────────────────────────
// A light ticker keeps "#wl-live" honest — "Live · updated Xs ago" every few
// seconds, and "Reconnecting…" (amber) the moment a fetch aborts/fails, so the
// board never looks frozen. It recovers on its own on the next good poll.
function wlPaintLive() {
  const el = document.getElementById('wl-live');
  if (!el) return;
  if (wlState.reconnecting) {
    el.className = 'live recon';
    el.innerHTML = '<i></i>Reconnecting…';
    return;
  }
  const secs = wlState.lastGood ? Math.max(0, Math.round((Date.now() - wlState.lastGood) / 1000)) : 0;
  el.className = 'live';
  el.innerHTML = `<i></i>Live · updated ${secs}s ago`;
}
function wlStartLiveTicker() {
  if (wlState.liveTimer) clearInterval(wlState.liveTimer);
  wlPaintLive();
  wlState.liveTimer = setInterval(() => {
    if (!document.getElementById('wl-live')) { clearInterval(wlState.liveTimer); wlState.liveTimer = null; return; }
    wlPaintLive();
  }, 3000);
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
  const gen = ++wlState._loadGen;
  // WATCHDOG (bug #3): a hung /radiology/worklist must never wedge the board. If this
  // load hasn't settled in ~120s, release the lock so the next poll can retry and flip
  // the pill to "Reconnecting…". The stale request is then ignored (gen guard below).
  const watchdog = setTimeout(() => {
    if (wlState._loadGen === gen && wlState.loading) {
      wlState.loading = false;
      wlState.reconnecting = true; wlPaintLive();
    }
  }, 120000);
  if (!silent && !wlState.filter) body.innerHTML = LOADING_HTML;
  // FAST load: no ready/modality — just the pending list, so the board paints in one
  // round-trip. The pipeline stage + exam/modality (per-order HIS work) come in a
  // background pass right after, and never block the first paint.
  const qs = new URLSearchParams();
  if (wlState.site) qs.set('sites', wlState.site);
  qs.set('from', wlState.from); qs.set('to', wlState.to);   // explicit range (defaults to today only)
  if (force) qs.set('nocache', '1');
  try {
    const data = await API.get('/radiology/worklist?' + qs.toString());
    if (wlState._loadGen !== gen) return;         // superseded — the watchdog gave up, a newer load owns the board
    wlState.data = data;
    // Status is driven by the NATIVE Siratech status (it.hisStatus), which the connector
    // stamps on the fast pass — so rows land in the right status bucket on the FIRST paint
    // with no DePACS wait (this is what removed the old "everyone sits in Waiting then
    // jumps" glitch). No stage-withholding needed.
    wlState.lastGood = Date.now(); wlState.reconnecting = false; wlPaintLive();
    wlHydrate();                                  // paint known modality/exam/stage instantly from cache
    wlRender();
    wlEnrich(silent);                             // background: fill stage + modality for unknown rows
  } catch (e) {
    // A failed/aborted fetch flips the live pill to amber "Reconnecting…" instead of
    // freezing the board — the next good poll clears it on its own.
    wlState.reconnecting = true; wlPaintLive();
    if (!silent) {
      // In a search view, replacing the body with a retry card would wipe the results —
      // surface the failure as a toast instead so the operator still sees the error.
      if (wlState.filter || wlState.searchView) {
        if (typeof toast === 'function') toast(e.message || 'Refresh failed', 'err');
      } else {
        body.innerHTML = `<div class="empty" style="padding:24px"><div class="empty-icon">${icon('alert')}</div>
          <p>${escapeHtml(e.message || 'Failed to load the worklist')}</p>
          <button class="btn btn-sm" onclick="wlLoad(true)">Retry</button></div>`;
      }
    }
  } finally {
    clearTimeout(watchdog);
    if (wlState._loadGen === gen) wlState.loading = false;   // ALWAYS release our own lock
  }
}

// Paint modality/exam AND pipeline stage onto the freshly-loaded board from the
// persistent caches, so a live refresh shows everything INSTANTLY without waiting on
// the slow enrichment pass for rows we already resolved.
wlState.scannedSeen = wlState.scannedSeen || new Set();
function wlHydrate() {
  const items = (wlState.data && wlState.data.items) || [];
  for (const it of items) {
    // DePACS-confirmed Final from the server's lifecycle store (fast pass only): show it
    // as reported on a brand-new browser open, before any ready pass runs. The server
    // sets stageConfirmed strictly from state='reported' (DePACS-grounded), so trusting
    // it for Final is safe. Doesn't need a row key.
    if (!it.stage && it.stageConfirmed) it.stage = it.stageConfirmed;
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
  // WATCHDOG (bug #3): never let a hung enrichment pass wedge the busy lock forever —
  // release it after ~120s so a later refresh can retry the pipeline-stage lookups.
  const enrichWatch = setTimeout(() => { _wlEnrichBusy = false; }, 120000);
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
    // Modality/exam enrichment only. The pipeline STAGE now comes from the native
    // Siratech status (hisStatus) already on the fast pass, so the slow per-patient
    // DePACS "ready" pass is no longer fetched for the board (it drove the old glitch).
    await API.get('/radiology/worklist?' + mkQs({ modality: '1' })).then((d) => wlMergeEnrich(d, false)).catch(() => {});
    wlState.lastEnrich = Date.now();
  } finally {
    clearTimeout(enrichWatch);
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
// A row's PRELIMINARY stage (from the HIS RIS status text, carried on the fast pass as
// stagePrelim) is CAPPED at 'imaged': it may place a row in the Imaged strip on the first
// paint, but can never assert a draft/verified report — only the DePACS ready pass
// (it.stage) does that. So even a HIS "signed" status shows Imaged until PACS confirms.
function wlPrelimStage(it) {
  return (it.stagePrelim === 'imaged' || it.stagePrelim === 'draft' || it.stagePrelim === 'reported')
    ? 'imaged' : 'ordered';
}
// The highest stage we currently believe for a row, honouring the hard scan signal
// (scanned → at least imaged) and the capped preliminary stage, so a ready pass can't
// hide a scanned or HIS-imaged row back as "ordered".
function wlCurRank(it) {
  return Math.max(wlStageRank(it.stage),
                  it.scanned ? _WL_STAGE_RANK.imaged : -1,
                  wlPrelimStage(it) === 'imaged' ? _WL_STAGE_RANK.imaged : -1);
}

// Merge one enrichment pass onto the visible rows and repaint IMMEDIATELY — the
// sibling pass may still be running, but whatever this one filled shows now.
function wlMergeEnrich(d, isReady) {
  if (wlState.modCache.size > 3000) { wlState.modCache.clear(); wlState.stageCache.clear(); wlState.scannedSeen.clear(); wlState.statusRatchet.clear(); }
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
      // '>=' (not '>') so an equal-rank DePACS reading writes through and REPLACES a
      // provisional placement (scanned / preliminary), clearing the "confirming" dot;
      // ranks are unique per code, so this still never demotes a row.
      if (isReady && e.stage && wlStageRank(e.stage) >= wlCurRank(it)) it.stage = e.stage;
    }
  }
  if (document.getElementById('wl-body')) wlRender();
}

// Pipeline stage → badge. Each stage is detected from a specific signal:
//   ordered  — order line present in Siratech, no images yet
//   imaged   — a study exists in DePACS/PACS (scan done), not yet reported
//   reported — the DePACS study is VERIFIED (signed) → auto-file files it and it
//              then drops off this board on its own.
// The full radiology exam-status lifecycle, the way a real RIS (Epic Radiant, Sectra,
// Merge) models it, mapped onto the signals Meena has:
//   Scheduled/Ordered → Arrived → In progress → Completed(imaged) → Preliminary(draft)
//   → Final(reported)
// Returns { bucket, label, cls, icon, state } — bucket drives the status tabs,
// `state` the Clinical Calm `.ris` pill; cls/icon kept for legacy references.
function wlRisStatus(it) {
  if (it.stage === 'reported')
    return { bucket: 'reported', label: 'Final report', cls: 'wl-st-final', icon: '', state: 'final' };
  if (it.stage === 'draft')
    return { bucket: 'reporting', label: 'Preliminary', cls: 'wl-st-prelim', icon: '', state: 'prelim' };
  if (it.stage === 'imaged' || it.scanned || wlPrelimStage(it) === 'imaged')
    // `pending` = placed in Imaged from the preliminary HIS stage alone (no hard scan
    // signal, DePACS not yet confirmed) → the badge shows a "confirming with PACS" dot
    // that clears in place once the ready pass sets it.stage. Never blocks the paint.
    return { bucket: 'imaged', label: 'Imaged', cls: 'wl-st-done', icon: '', state: 'completed',
             pending: !it.stage && !it.scanned };
  if (it.examStartAt)
    return { bucket: 'waiting', label: 'In progress', cls: 'wl-st-prog', icon: '', state: 'progress' };
  if (it.arrivedAt)
    return { bucket: 'waiting', label: 'Arrived', cls: 'wl-st-arr', icon: '', state: 'arrived' };
  return { bucket: 'waiting', label: 'Scheduled', cls: 'wl-st-sched', icon: '', state: 'scheduled' };
}
// ── Unified status model (worklist UI v2) ──────────────────────────────────────
// One vocabulary for the whole board: ordered → received → progress → completed →
// reported. `wlStatusRaw` reads the freshest signal; `wlStatus` RATCHETS it forward
// (a row never moves backward on a live refresh — same guarantee the old lane ratchet
// gave). STAT/urgent (it.emergency) is a cross-cutting flag, not a status.
const WL_STATUS_LABEL = { ordered: 'Ordered', received: 'Received', progress: 'In progress',
                          completed: 'Completed', reported: 'Reported', notdone: 'Not done' };
const _WL_ST_RANK = { ordered: 0, received: 1, progress: 2, completed: 3, reported: 4 };
const _WL_ST_BY_RANK = ['ordered', 'received', 'progress', 'completed', 'reported'];
function wlStatusRaw(it) {
  // A Meena "Not Done" (locally cancelled) order is terminal and off the progress ladder.
  if (it.localStatus === 'cancelled') return 'notdone';
  const s = String(it.hisStatus || '').toLowerCase();
  if (it.hisReported || it.stage === 'reported' || it.readyToFile) return 'reported';
  // Operator overlay actions (completedAt/startedAt/receivedAt) advance the row alongside
  // the HIS signals, so a manually-driven exam moves even before Siratech reflects it.
  if (it.completedAt || /scan\s*done|complet|\bdone\b|acquir|imaged/.test(s) || it.scanned || it.stage === 'imaged' || it.examEndAt || it.stage === 'draft') return 'completed';
  if (it.startedAt || /in\s*progress|scanning|ongoing|started/.test(s) || it.examStartAt) return 'progress';
  if (it.receivedAt || it.arrivedAt || /arrived/.test(s)) return 'received';
  return 'ordered';
}
function wlStatus(it) {
  const raw = wlStatusRaw(it);
  if (raw === 'notdone') return 'notdone';             // terminal — never ratcheted
  const k = wlRowKey(it);
  if (!k) return raw;                                  // keyless → can't ratchet safely
  const rawRank = _WL_ST_RANK[raw];
  const prev = wlState.statusRatchet.get(k);
  if (prev == null || rawRank >= prev) { wlState.statusRatchet.set(k, rawRank); return raw; }
  return _WL_ST_BY_RANK[prev];                         // hold the furthest-along status seen
}
// The tabs across the top; counts are computed live in wlRenderTabs.
const WL_TABS = [['all', 'All', false], ['ordered', 'Ordered', false], ['received', 'Received', false],
  ['progress', 'In Progress', false], ['completed', 'Completed', false], ['reported', 'Reported', false],
  ['notdone', 'Not Done', false], ['urgent', 'Urgent', true]];
// A DOM-safe, stable-per-order id for the expand Set + onclick (mirrors the old drill key).
function wlRowUid(it) { return 'u' + String(wlRowKey(it) || ('m' + (it.mrno || ''))).replace(/[^A-Za-z0-9_-]/g, ''); }
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
  // Classify every row once with the SINGLE unified status, and stash the coarse bucket
  // the kept wlAutoIndication reads (completed/reported → imaged/reported so done rows
  // skip the indication auto-fetch; everything else → 'waiting').
  for (const it of items) {
    const st = wlStatus(it);
    it.__status = st;
    it.__bucket = st === 'reported' ? 'reported' : st === 'completed' ? 'imaged' : 'waiting';
  }
  const body = document.getElementById('wl-body');
  if (!body) return;
  // A cross-branch search result view is showing — don't let a live refresh clobber it.
  if (wlState.searchView) return;
  // Entrance animation fires ONCE per visit. Later repaints (12s poll, enrich merge,
  // tab/filter switch) recreate the board nodes; the .rw-still class pins the stagger.
  const rwRoot = document.querySelector('#content .rw');
  if (rwRoot) { rwRoot.classList.toggle('rw-still', !!wlState._paintedOnce); wlState._paintedOnce = true; }
  const colhead = document.getElementById('rw-colhead'); if (colhead) colhead.style.display = '';

  // Live typeahead: as the operator types digits, filter the board to the MRNs that
  // START WITH what's typed (prefix) — rendered in the SAME dense row format.
  if (wlState.filter) {
    const f = wlState.filter;
    const match = items.filter((it) => String(it.mrno || '').replace(/\D/g, '').startsWith(f));
    const banner = `<div class="rw-filterbar"><span>${match.length} on this board starting with “${escapeHtml(f)}”</span>
      <button class="btn" onclick="wlClearFilter()">← Back to full board</button></div>`;
    body.innerHTML = banner + (match.length
      ? wlRowsHtml(match)
      : `<div class="empty"><div class="ei">🔍</div><p>No patient on this board starts with “${escapeHtml(f)}”.${f.length >= 6 ? ' Press Enter to search all branches.' : ''}</p></div>`);
    wlRenderTabs(items);
    wlAutoPreg(); wlAutoIndication(); wlSyncActionbar();
    return;
  }

  wlRenderTabs(items);
  wlRenderFilters(items);
  if (!items.length) {
    body.innerHTML = `<div class="empty"><div class="ei">🗂️</div><p>No orders awaiting a result.</p></div>`;
    wlSyncActionbar(); return;
  }

  // Active tab → status filter (Urgent = emergency across all statuses; Not Done is a
  // Phase-2 backend feature and stays empty for now).
  let rows = items;
  if (wlState.tab === 'urgent') rows = rows.filter((it) => it.emergency);
  else if (wlState.tab !== 'all') rows = rows.filter((it) => it.__status === wlState.tab);

  // Left-panel filters (all client-side).
  if (wlState.fMods.size) rows = rows.filter((it) => wlState.fMods.has(wlRowMod(it)));
  if (wlState.fPrio === 'stat') rows = rows.filter((it) => it.emergency);
  else if (wlState.fPrio === 'routine') rows = rows.filter((it) => !it.emergency);
  if (wlState.fDoc) rows = rows.filter((it) => String(it.doctorName || '').trim() === wlState.fDoc);

  // Sort.
  rows = rows.slice();
  if (wlState.fSort === 'wait') rows.sort((a, b) => (b.ageHours || 0) - (a.ageHours || 0));
  else if (wlState.fSort === 'recent') rows.sort((a, b) => (a.ageHours || 0) - (b.ageHours || 0));
  else rows.sort((a, b) => (Number(!!b.emergency) - Number(!!a.emergency)) || ((b.ageHours || 0) - (a.ageHours || 0)));

  body.innerHTML = rows.length
    ? wlRowsHtml(rows)
    : `<div class="empty"><div class="ei">🗂️</div><p>No orders match this view.</p><div class="hint">Try clearing a filter or switching tabs.</div></div>`;

  // Selection + expanded state are re-derived from the wlState Sets while building the
  // row HTML, so they survive every 12s repaint with no separate restore pass.
  wlAutoPreg();           // auto-check pregnancy status for female rows (throttled, cached)
  wlAutoIndication();     // auto-fetch the clinical indication for waiting/in-progress rows
  wlSyncActionbar();      // reflect the current checkbox selection in the sticky action bar
}

// ── Tab bar with live counts (rendered into the static #rw-tabs shell node) ────
function wlRenderTabs(items) {
  const el = document.getElementById('rw-tabs'); if (!el) return;
  const cnt = { all: items.length, ordered: 0, received: 0, progress: 0, completed: 0, reported: 0, notdone: 0, urgent: 0 };
  for (const it of items) {
    if (it.__status) cnt[it.__status] = (cnt[it.__status] || 0) + 1;
    if (it.emergency) cnt.urgent++;
  }
  el.innerHTML = WL_TABS.map(([k, lbl, urg]) =>
    `<button class="rw-tab${urg ? ' urg' : ''}${wlState.tab === k ? ' on' : ''}" onclick="wlSetTab('${k}')">${urg ? '🚨 ' : ''}${lbl}<span class="cnt tnum">${cnt[k] || 0}</span></button>`
  ).join('');
}

// ── Left filter panel (modality chips from the modalities present + the distinct
//    referring doctors). Radios / sort stay static in the shell and drive wlState. ──
const _WL_MOD_META = { CT: ['CT', '#6B4EFF'], MR: ['MRI', '#3BA0FF'], US: ['US', '#00C896'], XR: ['X-Ray', '#8358FD'], MG: ['Mammo', '#E4739B'] };
function wlRenderFilters(items) {
  const modCounts = {};
  for (const it of items) { const m = wlRowMod(it); if (m) modCounts[m] = (modCounts[m] || 0) + 1; }
  // If a selected modality has left the board, drop it so the view can't strand empty.
  for (const m of [...wlState.fMods]) if (!modCounts[m]) wlState.fMods.delete(m);
  const order = ['CT', 'MR', 'US', 'XR', 'MG'].filter((k) => modCounts[k]);
  const chipsEl = document.getElementById('rw-modchips');
  if (chipsEl) chipsEl.innerHTML = order.length
    ? order.map((k) => {
        const [lbl, hex] = _WL_MOD_META[k]; const on = wlState.fMods.has(k);
        return `<span class="chip${on ? ' on' : ''}" data-m="${k}" onclick="wlToggleMod('${k}')"><span class="cdot" style="background:${hex}"></span>${lbl}</span>`;
      }).join('')
    : '<span class="fhint">None on this board</span>';

  const docs = [...new Set(items.map((it) => String(it.doctorName || '').trim()).filter(Boolean))].sort();
  const sig = docs.join('|');
  const docsel = document.getElementById('rw-docsel');
  if (docsel && wlState._docSig !== sig) {
    wlState._docSig = sig;
    docsel.innerHTML = '<option value="">All doctors</option>' +
      docs.map((dn) => `<option value="${escapeHtml(dn)}">Dr ${escapeHtml(dn)}</option>`).join('');
  }
  if (docsel) docsel.value = wlState.fDoc;
}

function wlRowsHtml(rows) { return rows.map(wlRowHtml).join(''); }

// One dense board row (compact or detailed) + its (hidden until open) expand card.
function wlRowHtml(it) {
  const det = wlState.density === 'detailed';
  const uid = wlRowUid(it);
  const mrn = String(it.mrno || '');
  const sel = wlState.selMrns.has(mrn);
  const open = wlState.openRows.has(uid);
  const st = it.__status || wlStatus(it);
  const stat = !!it.emergency;
  const enriching = wlState.enriching;
  const acc = it.accession || it.accessionNumber || '';
  const gender = it.gender ? String(it.gender).charAt(0).toUpperCase() : '';
  const ageg = [it.age, gender].filter((x) => x != null && x !== '').map((x) => escapeHtml(String(x))).join('');
  const dept = it.department || (it.doctorName ? 'Dr ' + it.doctorName : '');
  const consentChip = (wlNeedsRadSafety(it) && !it.consentOnFile) ? '<span class="consent-tag">CONSENT</span>' : '';
  const prelim = (st === 'completed' && it.stage === 'draft');
  const pillNote = prelim ? '<div class="prelim-note">Preliminary read</div>' : '';
  const examCell = it.exam
    ? `<span class="ename">${escapeHtml(it.exam)}</span>`
    : (enriching ? '<span class="wl-shimmer" style="width:120px"></span>' : '<span class="ename" style="color:var(--muted)">—</span>');
  const canReport = (st === 'completed' || st === 'reported');
  const primaryAct = canReport
    ? `<button class="iconbtn primary" title="Report & images" onclick="event.stopPropagation();openStudyViewer(this,'${jsAttr(mrn)}','${jsAttr(acc)}','${jsAttr(it.invPatTestResultId || '')}')">${icon('file-text')}</button>`
    : `<button class="iconbtn" title="Handoff" onclick="event.stopPropagation();wlOpenHandoff('${jsAttr(mrn)}')">${icon('inbox')}</button>`;
  return `<div class="rw-row${sel ? ' sel' : ''}${stat ? ' stat' : ''}${open ? ' open' : ''}" onclick="wlToggleRow('${uid}',event)">
    <span class="rw-check${sel ? ' on' : ''}" onclick="wlToggleSel('${jsAttr(mrn)}',event)">${icon('check')}</span>
    <div class="pt">
      <div class="l1"><span class="pname">${escapeHtml(it.patientName || '—')}</span>${stat ? '<span class="stat-tag">STAT</span>' : ''}${consentChip}</div>
      <div class="l2 tnum"><span>MRN ${escapeHtml(mrn)}</span>${ageg ? `<span>${ageg}</span>` : ''}${det && it.doctorName ? `<span>Dr ${escapeHtml(it.doctorName)}</span>` : ''}</div>
    </div>
    <div class="exam">
      <div class="l1">${modBadges(it.modality) || ''}${examCell}</div>
      <div class="l2">${acc ? escapeHtml(String(acc)) : '<span style="color:var(--muted)">no accession</span>'}</div>
    </div>
    <div class="branch-cell">${escapeHtml(it.branch || '—')}${dept ? `<div class="dept">${escapeHtml(dept)}</div>` : ''}</div>
    <div><span class="ris ${st}"><span class="rd"></span>${WL_STATUS_LABEL[st]}</span>${pillNote}${it.assignedTechName ? `<div class="prelim-note">🧑‍🔬 ${escapeHtml(String(it.assignedTechName))}</div>` : ''}</div>
    <div class="acts">
      ${primaryAct}
      <button class="iconbtn" title="Expand" onclick="wlToggleRow('${uid}',event)"><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></button>
    </div>
  </div>
  <div class="rw-expand">${wlExpandHtml(it, st)}</div>`;
}

// The expand card built from the real item fields.
function wlExpandHtml(it, st) {
  const mrn = String(it.mrno || '');
  const nm = it.patientName || '—';
  const initials = String(nm).trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
  const gender = it.gender ? String(it.gender).charAt(0).toUpperCase() : '';
  const genderFull = gender === 'F' ? 'Female' : gender === 'M' ? 'Male' : '';
  const dept = it.department || '';
  const acc = it.accession || it.accessionNumber || '';
  const age = wlAge(it.ageHours);
  const canReport = (st === 'completed' || st === 'reported');
  const needConsent = wlNeedsRadSafety(it) && !it.consentOnFile;
  const demo = [it.age != null ? escapeHtml(String(it.age)) + 'y' : '', genderFull].filter(Boolean).join(' · ');
  const chips = [`MRN ${escapeHtml(mrn)}`, demo, it.branch ? escapeHtml(it.branch) : '', dept ? escapeHtml(dept) : '']
    .filter(Boolean).map((c) => `<span class="xchip">${c}</span>`).join('');
  const preg = wlPregEl(it);
  return `<div class="xcard" onclick="event.stopPropagation()">
    <div class="xhead">
      <div class="xavatar">${escapeHtml(initials)}</div>
      <div style="flex:1;min-width:0">
        <div class="xname">${escapeHtml(nm)}</div>
        <div class="xchips">${chips}</div>
      </div>
      <span class="ris ${st}"><span class="rd"></span>${WL_STATUS_LABEL[st]}</span>
    </div>
    ${needConsent ? `<div class="alert">${icon('alert')}Non-pregnancy consent required before imaging a female patient of childbearing age.</div>` : ''}
    ${(st === 'notdone' && it.cancelReason) ? `<div class="alert" style="color:var(--danger-ink);background:var(--danger-wash)">${icon('alert')}Not done · ${escapeHtml(it.cancelReason)}</div>` : ''}
    ${it.note ? `<div class="alert" style="color:var(--text);background:var(--surface-2)">${icon('edit')}${escapeHtml(it.note)}</div>` : ''}
    ${preg ? `<div class="rw-preg">${preg}</div>` : ''}
    <div class="xgrid">
      <div class="xf"><div class="k">Exam</div><div class="v">${it.modality ? escapeHtml(String(it.modality)) + ' · ' : ''}${it.exam ? escapeHtml(it.exam) : '<span style="color:var(--muted)">—</span>'}</div></div>
      <div class="xf"><div class="k">Accession</div><div class="v tnum">${acc ? escapeHtml(String(acc)) : '—'}</div></div>
      <div class="xf"><div class="k">Ordering doctor</div><div class="v">${it.doctorName ? 'Dr ' + escapeHtml(it.doctorName) : '—'}${dept ? ' · ' + escapeHtml(dept) : ''}</div></div>
      <div class="xf"><div class="k">Ordered</div><div class="v tnum">${it.orderedDate ? escapeHtml(wlTrackFmt(it.orderedDate)) : (age ? age + ' ago' : '—')}</div></div>
      <div class="xf"><div class="k">Technologist</div><div class="v">${it.assignedTechName ? escapeHtml(String(it.assignedTechName)) : '<span style="color:var(--muted)">Unassigned</span>'}</div></div>
      <div class="xf"><div class="k">Priority</div><div class="v">${it.emergency ? '<span style="color:var(--danger-ink);font-weight:800">STAT / Emergency</span>' : 'Routine'}</div></div>
    </div>
    <div class="xsec-title">Clinical indication</div>
    <div class="rw-xind">${wlIndEl(it)}</div>
    <div class="xsec-title">Exam history</div>
    <div class="hist"><div class="hist-muted">History opens in the full patient card.</div></div>
    <div class="xbtns">
      ${canReport ? `<button class="btn solid" onclick="openStudyViewer(this,'${jsAttr(mrn)}','${jsAttr(acc)}','${jsAttr(it.invPatTestResultId || '')}')">${icon('file-text')}View report &amp; images</button>` : ''}
      <button class="btn" onclick="wlOpenPatientCard('${jsAttr(mrn)}')">${icon('user')}Full patient card</button>
      ${needConsent ? `<button class="btn" onclick="wlConsent('${jsAttr(mrn)}','${jsAttr(it.patientName || '')}','${jsAttr(it.exam || '')}','${jsAttr(it.doctorName || '')}','${jsAttr(it.branch || '')}')">${icon('id-card')}Send consent QR</button>` : ''}
      ${wlWorkflowBtns(it, st)}
    </div>
  </div>`;
}

// Sticky action bar — appears when ≥1 row is checkbox-selected. Real buttons (Patient
// card / Report / Images) are enabled for a single selection; the Phase-2 workflow
// actions render disabled with a SOON tag.
function wlSyncActionbar() {
  const bar = document.getElementById('rw-actionbar');
  if (!bar) return;
  const sel = [...wlState.selMrns];
  if (!sel.length) { bar.classList.remove('show'); return; }
  const items = (wlState.data && wlState.data.items) || [];
  const single = sel.length === 1;
  const it = single ? items.find((x) => String(x.mrno) === sel[0]) : null;
  const name = single ? (it ? (it.patientName || ('MRN ' + sel[0])) : ('MRN ' + sel[0])) : (sel.length + ' patients selected');
  const sub = (single && it) ? `MRN ${escapeHtml(it.mrno || '')}${it.exam ? ' · ' + escapeHtml(it.exam) : ''}` : '';
  const canReport = single && it && (it.__status === 'completed' || it.__status === 'reported');
  const acc = it ? (it.accession || it.accessionNumber || '') : '';
  const real = [
    single ? `<button class="btn" onclick="wlOpenPatientCard('${jsAttr(sel[0])}')">${icon('user')}Patient card</button>` : '',
    canReport ? `<button class="btn solid" onclick="openStudyViewer(this,'${jsAttr(it.mrno)}','${jsAttr(acc)}','${jsAttr(it.invPatTestResultId || '')}')">${icon('file-text')}Report / Images</button>` : '',
  ].join('');
  // Workflow actions apply to a single order; a multi-select keeps just the count.
  const soon = (single && it) ? wlWorkflowBtns(it, it.__status || wlStatus(it)) : '';
  const info = bar.querySelector('.ab-info'); if (info) info.innerHTML = `<span class="n">${escapeHtml(name)}</span><span class="s">${sub}</span>`;
  const count = bar.querySelector('.ab-count'); if (count) count.textContent = sel.length > 1 ? sel.length : '';
  const acts = bar.querySelector('.ab-acts'); if (acts) acts.innerHTML = real + soon;
  bar.classList.add('show');
}

// ── Redesign view-state handlers (all repaint via wlRender) ────────────────────
function wlSetTab(k) { wlState.tab = k; wlRender(); }
function wlToggleMod(m) { if (wlState.fMods.has(m)) wlState.fMods.delete(m); else wlState.fMods.add(m); wlRender(); }
function wlSetPrio(p) { wlState.fPrio = p; wlRender(); }
function wlSetDoc(v) { wlState.fDoc = v; wlRender(); }
function wlSetSort(v) { wlState.fSort = v; const s = document.getElementById('rw-sortsel'); if (s && s.value !== v) s.value = v; wlRender(); }
function wlSetDensity(dn) {
  wlState.density = dn;
  const a = document.getElementById('rw-dCompact'), b = document.getElementById('rw-dDetailed');
  if (a) a.classList.toggle('on', dn === 'compact');
  if (b) b.classList.toggle('on', dn === 'detailed');
  wlRender();
}
function wlResetFilters() {
  wlState.fMods.clear(); wlState.fPrio = ''; wlState.fDoc = '';
  const r = document.querySelector('input[name="rw-prio"][value=""]'); if (r) r.checked = true;
  const ds = document.getElementById('rw-docsel'); if (ds) ds.value = '';
  wlRender();
}
function wlToggleRow(uid, e) { if (e) e.stopPropagation(); if (wlState.openRows.has(uid)) wlState.openRows.delete(uid); else wlState.openRows.add(uid); wlRender(); }
function wlToggleSel(mrn, e) { if (e) e.stopPropagation(); const k = String(mrn); if (wlState.selMrns.has(k)) wlState.selMrns.delete(k); else wlState.selMrns.add(k); wlRender(); }
function wlClearSel() { wlState.selMrns.clear(); wlRender(); }
function wlToggleMobFilters() { const f = document.getElementById('rw-filters'); if (f) f.classList.toggle('open'); }

// ── Phase-2 workflow actions (Meena-owned local overlay) ──────────────────────
// receive / start / complete / assign / note / cancel — POST to the order endpoint,
// then a forced refresh repaints the row with the new state. genPatBillingId is the
// order key; mrno/site ride along so an order the ledger hasn't persisted yet upserts.
async function wlPostOrder(gpb, action, body, okMsg) {
  if (gpb == null || gpb === '') { if (typeof toast === 'function') toast('This order has no id yet — try again in a moment', 'err'); return; }
  try {
    await API.post(`/radiology/orders/${encodeURIComponent(gpb)}/${action}`, body || {});
    if (okMsg && typeof toast === 'function') toast(okMsg);
    wlLoad(true);
  } catch (e) { if (typeof toast === 'function') toast(e.message || 'Action failed', 'err'); }
}
function wlActReceive(gpb, mrno, site)  { wlPostOrder(gpb, 'receive',  { mrno, site }, 'Patient received'); }
function wlActStart(gpb, mrno, site)    { wlPostOrder(gpb, 'start',    { mrno, site }, 'Exam started'); }
function wlActComplete(gpb, mrno, site) { wlPostOrder(gpb, 'complete', { mrno, site }, 'Exam completed'); }
function wlActAssign(gpb, mrno, site) { wlOpenTechPicker(gpb, mrno, site); }
function wlActNote(gpb, mrno, site) {
  const n = prompt('Add a note for this order:');
  if (!n || !n.trim()) return;
  wlPostOrder(gpb, 'note', { mrno, site, note: n.trim() }, 'Note saved');
}
function wlActCancel(gpb, mrno, site) {
  const r = prompt('Mark this order Not Done — reason (e.g. patient no-show, cancelled):');
  if (!r || !r.trim()) return;
  wlPostOrder(gpb, 'cancel', { mrno, site, reason: r.trim() }, 'Marked not done');
}

// ── Technologist picker (elegant modal; styles injected once, not in style.css) ──
function wlEnsureTechStyles() {
  if (document.getElementById('wl-tech-css')) return;
  const s = document.createElement('style');
  s.id = 'wl-tech-css';
  s.textContent = `
    .wl-tech-ov{position:fixed;inset:0;z-index:1300;background:rgba(20,17,40,.5);backdrop-filter:blur(2px);
      display:flex;align-items:flex-start;justify-content:center;padding:60px 14px;overflow:auto;animation:wltFade .14s ease}
    @keyframes wltFade{from{opacity:0}to{opacity:1}}
    .wl-tech-sheet{width:100%;max-width:420px;background:var(--card,#fff);border:1px solid var(--border,#e7e4f0);
      border-radius:16px;box-shadow:0 24px 70px rgba(20,17,40,.4);overflow:hidden;margin:auto 0}
    .wl-tech-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border,#eee)}
    .wl-tech-head b{font-size:15px;flex:1}
    .wl-tech-x{border:0;background:transparent;font-size:18px;cursor:pointer;color:var(--muted,#7a7690);width:30px;height:30px;border-radius:8px}
    .wl-tech-x:hover{background:var(--surface-2,#f0eef7)}
    .wl-tech-search{margin:12px 16px 8px}
    .wl-tech-search input{width:100%;padding:9px 12px;border:1px solid var(--border-strong,#ddd);border-radius:10px;
      background:var(--card,#fff);color:var(--text);font:inherit;font-size:14px;outline:none}
    .wl-tech-search input:focus{border-color:var(--accent,#6B4EFF);box-shadow:0 0 0 3px rgba(107,78,255,.14)}
    .wl-tech-list{max-height:46vh;overflow:auto;padding:0 10px 8px}
    .wl-tech-item{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;background:none;
      font:inherit;font-size:14px;color:var(--text);padding:10px 12px;border-radius:10px;cursor:pointer}
    .wl-tech-item:hover{background:var(--violet-wash,#f0edff)}
    .wl-tech-item.cur{background:var(--violet-wash,#f0edff);font-weight:700}
    .wl-tech-av{width:30px;height:30px;border-radius:9px;background:var(--violet-wash,#f0edff);color:var(--accent,#6B4EFF);
      display:grid;place-items:center;font-weight:800;font-size:12px;flex:none}
    .wl-tech-foot{display:flex;gap:8px;padding:10px 16px 14px;border-top:1px solid var(--border,#eee)}
    .wl-tech-foot .btn{flex:1;justify-content:center}
    .wl-tech-empty{padding:24px;text-align:center;color:var(--muted)}`;
  document.head.appendChild(s);
}
async function wlOpenTechPicker(gpb, mrno, site) {
  if (gpb == null) return;
  wlEnsureTechStyles();
  const items = (wlState.data && wlState.data.items) || [];
  const cur = items.find((x) => Number(x.genPatBillingId) === Number(gpb)) || {};
  wlState._techPick = { gpb, mrno, site, curName: cur.assignedTechName || '' };
  let ov = document.getElementById('wl-tech');
  if (!ov) { ov = document.createElement('div'); ov.id = 'wl-tech'; document.body.appendChild(ov); }
  ov.className = 'wl-tech-ov';
  ov.onclick = (e) => { if (e.target === ov) wlCloseTechPicker(); };
  ov.innerHTML = `<div class="wl-tech-sheet">
    <div class="wl-tech-head"><b>Assign technologist</b><button class="wl-tech-x" title="Close" onclick="wlCloseTechPicker()">✕</button></div>
    <div class="wl-tech-search"><input id="wl-tech-q" placeholder="Search staff…" oninput="wlTechFilter(this.value)" autocomplete="off"></div>
    <div class="wl-tech-list" id="wl-tech-list">${typeof LOADING_HTML !== 'undefined' ? LOADING_HTML : 'Loading…'}</div>
    <div class="wl-tech-foot">
      <button class="btn" onclick="wlPickTech(0, '')">Clear assignment</button>
      <button class="btn" onclick="wlCloseTechPicker()">Cancel</button>
    </div>
  </div>`;
  document.body.style.overflow = 'hidden';
  setTimeout(() => { const q = document.getElementById('wl-tech-q'); if (q) q.focus(); }, 40);
  if (!wlState.techs) {
    try { const d = await API.get('/radiology/technologists'); wlState.techs = (d && d.technologists) || []; }
    catch (e) { wlState.techs = []; }
  }
  if (document.getElementById('wl-tech')) wlTechFilter('');
}
function wlTechRender(list) {
  const box = document.getElementById('wl-tech-list'); if (!box) return;
  const cur = (wlState._techPick && wlState._techPick.curName) || '';
  if (!list.length) { box.innerHTML = '<div class="wl-tech-empty">No staff found.</div>'; return; }
  box.innerHTML = list.map((t) => {
    const nm = String(t.name || '');
    const ini = nm.trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
    return `<button class="wl-tech-item${nm === cur ? ' cur' : ''}" onclick="wlPickTech(${Number(t.id) || 0}, '${jsAttr(nm)}')">
      <span class="wl-tech-av">${escapeHtml(ini)}</span>${escapeHtml(nm)}${nm === cur ? ' · current' : ''}</button>`;
  }).join('');
}
function wlTechFilter(v) {
  const term = String(v || '').trim().toLowerCase();
  const all = wlState.techs || [];
  wlTechRender(term ? all.filter((t) => String(t.name || '').toLowerCase().includes(term)) : all);
}
function wlPickTech(id, name) {
  const p = wlState._techPick; if (!p) return;
  wlCloseTechPicker();
  wlPostOrder(p.gpb, 'assign', { mrno: p.mrno, site: p.site, staff_id: id || null, tech_name: name || '' },
    name ? 'Technologist assigned' : 'Assignment cleared');
}
function wlCloseTechPicker() {
  const ov = document.getElementById('wl-tech'); if (ov) ov.remove();
  document.body.style.overflow = '';
}

// Contextual workflow buttons for the expand card + action bar, gated by current status.
function wlWorkflowBtns(it, st) {
  const gpb = it.genPatBillingId;
  if (gpb == null) return '';
  const g = Number(gpb), mr = jsAttr(String(it.mrno || '')), site = Number(it.site) || 0;
  const b = [];
  if (st === 'ordered')       b.push(`<button class="btn solid" onclick="wlActReceive(${g},'${mr}',${site})">${icon('check')}Receive patient</button>`);
  else if (st === 'received') b.push(`<button class="btn solid" onclick="wlActStart(${g},'${mr}',${site})">Start exam</button>`);
  else if (st === 'progress') b.push(`<button class="btn solid" onclick="wlActComplete(${g},'${mr}',${site})">Mark completed</button>`);
  if (st !== 'notdone') {
    b.push(`<button class="btn" onclick="wlActAssign(${g},'${mr}',${site})">${icon('user')}Assign tech</button>`);
    b.push(`<button class="btn" onclick="wlActNote(${g},'${mr}',${site})">${icon('edit')}Add note</button>`);
    b.push(`<button class="btn" style="color:var(--danger-ink);border-color:var(--danger-wash)" onclick="wlActCancel(${g},'${mr}',${site})">Not done</button>`);
  }
  return b.join('');
}

function wlAge(h) { return h == null ? '' : (h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`); }

// A female patient needs a signed non-pregnancy consent BEFORE imaging. Detect
// female from the HIS gender and surface the consent state right on the row.
function wlIsFemale(g) {
  const s = String(g || '').trim().toLowerCase();
  return s.startsWith('f') || /أنث|انث/.test(s);
}
// Non-pregnancy consent + β-hCG check are RADIATION-safety measures: they apply
// only to a female patient having an IONISING-radiation exam. Ultrasound (US)
// and MRI (MR) use no ionising radiation, so they never need either. An unknown
// modality is treated as radiation until enrichment resolves it — we never hide
// a safety prompt when unsure.
const WL_NONRAD_MODS = new Set(['US', 'MR']);
function wlNeedsRadSafety(it) {
  return wlIsFemale(it.gender) && !WL_NONRAD_MODS.has(wlRowMod(it));
}
// Radiation-safety decision support: for a female patient of child-bearing age,
// let the tech check β-hCG / pregnancy lab status BEFORE imaging — on demand, per
// patient (never auto for the whole board: each check is 2 HIS lab searches). The
// verdict is cached so a live refresh keeps it. This never blocks imaging — it just
// surfaces what Siratech's lab module already knows.
function wlPregEl(it) {
  if (!wlNeedsRadSafety(it)) return '';
  const mr = String(it.mrno || '');
  const cached = wlState.pregCache.get(mr);
  // A patient can occupy several rows (one per exam on a bundled bill), so key the cell
  // by a data attribute (not a DOM id) — an id would be duplicated and only the first
  // row's badge would ever resolve. wlPregSet() updates EVERY cell for the MRN.
  const attr = ` class="wl-pregcell" data-mr="${escapeHtml(mr)}"`;
  if (cached) return `<span${attr}>${wlPregBadge(cached)}</span>`;
  // Auto-checks in the background (wlAutoPreg) — no click needed.
  return `<span${attr}><span class="sc warn" title="Checking pregnancy / β-hCG status…">${icon('droplet')} <span class="wl-shimmer" style="width:36px"></span></span></span>`;
}
// Paint the pregnancy verdict into EVERY row that belongs to this MRN (CSS-escape the
// value for the attribute selector).
function wlPregSet(mr, r) {
  const sel = '.wl-pregcell[data-mr="' + String(mr).replace(/["\\]/g, '\\$&') + '"]';
  document.querySelectorAll(sel).forEach((el) => { el.innerHTML = wlPregBadge(r); });
}
// Automatically check pregnancy status for every female row on the visible board —
// no button. Throttled (small concurrency) and cached, so a 30-row board makes a
// steady trickle of calls instead of a burst, and a live refresh never re-fetches
// a patient we already know.
let _wlPregBusy = 0;
const _WL_PREG_MAX = 2;
const _wlPregQueue = [];
const _wlPregInflight = new Set();   // MRNs currently being fetched — never double-request
function wlAutoPreg() {
  const items = (wlState.data && wlState.data.items) || [];
  const seen = new Set(_wlPregQueue.map((x) => x.mr));
  for (const it of items) {
    if (!wlNeedsRadSafety(it)) continue;         // radiation exams only (skip US / MRI)
    const mr = String(it.mrno || '');
    if (!mr || wlState.pregCache.has(mr) || seen.has(mr) || _wlPregInflight.has(mr)) continue;
    seen.add(mr);
    _wlPregQueue.push({ mr, site: Number(it.site) || 0 });
  }
  wlPregPump();
}
function wlPregPump() {
  while (_wlPregBusy < _WL_PREG_MAX && _wlPregQueue.length) {
    const { mr, site } = _wlPregQueue.shift();
    if (wlState.pregCache.has(mr) || _wlPregInflight.has(mr)) continue;
    _wlPregBusy++; _wlPregInflight.add(mr);
    const qs = new URLSearchParams({ mrno: mr }); if (site) qs.set('site', String(site));
    API.get('/radiology/labs/pregnancy?' + qs.toString())
      .then((r) => { wlState.pregCache.set(mr, r); wlPregSet(mr, r); })
      .catch(() => { /* leave the shimmer; a later refresh retries */ })
      .finally(() => { _wlPregBusy--; _wlPregInflight.delete(mr); wlPregPump(); });
  }
}
function wlPregBadge(r) {
  if (!r || !r.found || !r.hasPregnancyTest) {
    return `<span class="sc warn" title="No recent pregnancy / β-hCG lab found in Siratech — confirm status before imaging">${icon('droplet')} No recent test</span>`;
  }
  const when = r.resultDate || r.orderDate;
  const dstr = when ? (' · ' + escapeHtml(String(when).slice(0, 10))) : '';
  const nm = r.testName ? escapeHtml(String(r.testName)) : 'pregnancy test';
  if (r.verdict === 'positive') {
    return `<span class="sc no" title="${nm}${r.resultText ? ' = ' + escapeHtml(String(r.resultText)) : ''} — POSITIVE. Do NOT irradiate without physician review.">⚠ Pregnancy: positive${dstr}</span>`;
  }
  if (r.verdict === 'negative') {
    return `<span class="sc ok" title="${nm}${r.resultText ? ' = ' + escapeHtml(String(r.resultText)) : ''} — negative">✓ Pregnancy: negative${dstr}</span>`;
  }
  if (r.resulted) {
    return `<span class="sc warn" title="${nm} resulted${r.resultText ? ' = ' + escapeHtml(String(r.resultText)) : ''} — read the value">${icon('droplet')} Resulted${dstr}</span>`;
  }
  return `<span class="sc warn" title="${nm} ordered but result still pending">${icon('droplet')} Test pending${dstr}</span>`;
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

// (The old per-phase status badge + inline SVG map are gone — the redesign renders the
// unified .ris pill and util.js icon() glyphs directly; see the row/expand builders.)

// ── BUG #2: inline clinical indication on the row ───────────────────────────
// The cell is keyed by MRN (like the pregnancy cell) so a live refresh keeps it and
// one patient can span several rows. It ALSO carries the row's bill + service so the
// per-exam indication resolves correctly for a bundled (multi-exam) bill.
function wlIndCellHtml(idx, mr, bill, svc) {
  const ind = (bill && (idx['b:' + bill + '|' + svc] || idx['b:' + bill])) || '';
  const attr = ` class="ind${ind ? '' : ' none'} wl-indcell" data-mr="${escapeHtml(mr)}" data-bill="${escapeHtml(bill)}" data-svc="${escapeHtml(svc)}"`;
  return `<div${attr}><b>Indication</b>${ind ? escapeHtml(String(ind)) : 'not recorded in the order'}</div>`;
}
function wlIndEl(it) {
  const mr = String(it.mrno || '');
  if (!mr) return '';                                  // no MRN → can't look it up
  const bill = String(it.billNo || '');
  const svc = String(it.exam || '').trim().toLowerCase();
  const idx = wlState.indCache.get(mr);
  if (idx) return wlIndCellHtml(idx, mr, bill, svc);   // resolved from cache
  // Loading — a throttled wlAutoIndication() pass fills it in.
  return `<div class="ind wl-indcell" data-mr="${escapeHtml(mr)}" data-bill="${escapeHtml(bill)}" data-svc="${escapeHtml(svc)}"><b>Indication</b><span class="wl-shimmer" style="width:130px"></span></div>`;
}
// Paint the resolved indication into EVERY cell that belongs to this MRN, resolving
// each cell's own bill+service against the index (CSS-escape the attribute value).
function wlIndSet(mr) {
  const idx = wlState.indCache.get(mr) || {};
  const sel = '.wl-indcell[data-mr="' + String(mr).replace(/["\\]/g, '\\$&') + '"]';
  document.querySelectorAll(sel).forEach((el) => {
    const bill = el.getAttribute('data-bill') || '';
    const svc = (el.getAttribute('data-svc') || '').toLowerCase();
    const ind = (bill && (idx['b:' + bill + '|' + svc] || idx['b:' + bill])) || '';
    el.className = 'ind' + (ind ? '' : ' none') + ' wl-indcell';
    el.innerHTML = '<b>Indication</b>' + (ind ? escapeHtml(String(ind)) : 'not recorded in the order');
  });
}
// Auto-fetch the clinical indication for the visible board — mirrors wlAutoPreg
// exactly (concurrency 2, per-MRN cache, in-flight dedupe). Only for non-`.done`
// rows (waiting / in-progress / reporting) to limit HIS load: an imaged/reported
// study's indication is already viewable in the drill.
let _wlIndBusy = 0;
const _WL_IND_MAX = 2;
const _wlIndQueue = [];
const _wlIndInflight = new Set();
function wlAutoIndication() {
  const items = (wlState.data && wlState.data.items) || [];
  const seen = new Set(_wlIndQueue.map((x) => x.mr));
  // On-demand: only fetch the clinical indication for an EXPANDED card, not the whole
  // board — the per-MRN HIS lookup was what made the indication lag on the list.
  for (const it of items) {
    if (!wlState.openRows.has(wlRowUid(it))) continue;
    const mr = String(it.mrno || '');
    if (!mr || wlState.indCache.has(mr) || seen.has(mr) || _wlIndInflight.has(mr)) continue;
    seen.add(mr);
    _wlIndQueue.push({ mr });
  }
  wlIndPump();
}
function wlIndPump() {
  while (_wlIndBusy < _WL_IND_MAX && _wlIndQueue.length) {
    const { mr } = _wlIndQueue.shift();
    if (wlState.indCache.has(mr) || _wlIndInflight.has(mr)) continue;
    _wlIndBusy++; _wlIndInflight.add(mr);
    API.get('/radiology/lookup/' + encodeURIComponent(mr))
      .then((lk) => { wlState.indCache.set(mr, wlIndexIndications(lk)); wlIndSet(mr); })
      .catch(() => { /* leave the shimmer; a later refresh retries */ })
      .finally(() => { _wlIndBusy--; _wlIndInflight.delete(mr); wlIndPump(); });
  }
}

// (wlRowPdf removed — the row's "Report / Images" button now opens the native
// Siratech report + images directly via openStudyViewer.)

// (The old table-style row builder is gone — the dense redesign rows are built by
// wlRowHtml / wlExpandHtml above.)

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
// Build a lookup index of clinical indication keyed by bill (+ service), from the
// /radiology/lookup order detail, consumed by the background indication auto-fetch.
function wlIndexIndications(lk) {
  const idx = {}, er = {};
  const orders = (lk && lk.orders) || [];
  for (const o of orders) {
    const bn = String(o.billNo || '').trim();
    if (!bn) continue;
    const svc = String(o.service || '').trim().toLowerCase();
    // Emergency flag per exam — so the "Write indication" button sets the same ER
    // state the auto-stamp would (the match payload doesn't carry it; the lookup does).
    const isER = !!o.isER;
    er['b:' + bn + '|' + svc] = isER;
    if (er['b:' + bn] === undefined) er['b:' + bn] = isER;
    const ind = (o.clinicalIndication || o.reasonForOrder || '').toString().trim();
    if (!ind) continue;
    idx['b:' + bn + '|' + svc] = ind;          // exact exam
    if (!idx['b:' + bn]) idx['b:' + bn] = ind;  // bill-level fallback (single-exam bill)
  }
  Object.defineProperty(idx, '__er', { value: er, enumerable: false });
  return idx;
}
// Deep-link into the trusted Handoff wizard, pre-loaded with this patient's file.
function wlOpenHandoff(mrno) {
  window._handoffPreload = mrno;
  showPage('handoff');
}

// Open the FULL patient card (labs · problem list · allergies · visits · appointments ·
// exams · upload) in a modal straight from the worklist — click a patient's name to get
// everything at a glance without leaving the board. Reuses the Patient-Lookup renderer:
// renderPsDetail() paints into the #ps-detail we drop inside the modal, and every
// psLoad* enrichment then fills its own section. Read-only.
function wlEnsurePcardStyles() {
  if (document.getElementById('wl-pcard-css')) return;
  const s = document.createElement('style');
  s.id = 'wl-pcard-css';
  s.textContent = `
    .wl-pcard-ov{position:fixed;inset:0;z-index:1200;background:rgba(20,17,40,.5);
      backdrop-filter:blur(2px);display:flex;justify-content:center;align-items:flex-start;
      padding:24px 14px;overflow:auto;animation:wlpcFade .15s ease}
    @keyframes wlpcFade{from{opacity:0}to{opacity:1}}
    .wl-pcard-sheet{width:100%;max-width:660px;background:var(--bg,#f4f2fc);border-radius:18px;
      box-shadow:0 24px 70px rgba(20,17,40,.4);overflow:hidden;margin:auto 0}
    .wl-pcard-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;
      gap:10px;padding:13px 16px;background:var(--card,#fff);border-bottom:1px solid var(--border,#e7e4f0)}
    .wl-pcard-head b{font-size:15px}
    .wl-pcard-x{border:0;background:transparent;font-size:19px;cursor:pointer;color:var(--muted,#7a7690);
      width:32px;height:32px;border-radius:9px;line-height:1}
    .wl-pcard-x:hover{background:var(--card-alt,#f4f4f8)}
    .wl-pcard-body{padding:14px;max-height:calc(100vh - 120px);overflow:auto}
    .pname-link{cursor:pointer}
    .pname-link:hover{color:var(--accent,#6B4EFF);text-decoration:underline}`;
  document.head.appendChild(s);
}
async function wlOpenPatientCard(mrno) {
  mrno = String(mrno || '').trim();
  if (!mrno || typeof renderPsDetail !== 'function') return;
  wlEnsurePcardStyles();
  let ov = document.getElementById('wl-pcard');
  if (!ov) { ov = document.createElement('div'); ov.id = 'wl-pcard'; document.body.appendChild(ov); }
  ov.className = 'wl-pcard-ov';
  ov.onclick = (e) => { if (e.target === ov) wlClosePatientCard(); };
  ov.innerHTML = `<div class="wl-pcard-sheet">
    <div class="wl-pcard-head"><b>Patient card</b><button class="wl-pcard-x" title="Close" onclick="wlClosePatientCard()">✕</button></div>
    <div class="wl-pcard-body"><div id="ps-detail">${typeof LOADING_HTML !== 'undefined' ? LOADING_HTML : '<div class="card" style="padding:26px;text-align:center">Loading…</div>'}</div></div>
  </div>`;
  document.body.style.overflow = 'hidden';
  if (!window._wlPcardEsc) {
    window._wlPcardEsc = (e) => { if (e.key === 'Escape') wlClosePatientCard(); };
    document.addEventListener('keydown', window._wlPcardEsc);
  }
  try {
    const d = await API.get(`/radiology/lookup/${encodeURIComponent(mrno)}`);
    if (!document.getElementById('wl-pcard')) return;                 // closed while loading
    const pat = (d.patient && d.patient.mrno) ? d.patient : { ...(d.patient || {}), mrno };
    psState.lookup = { ...d, patient: pat };
    renderPsDetail();
  } catch (e) {
    const b = document.querySelector('#wl-pcard #ps-detail');
    if (b) b.innerHTML = `<div class="card"><div class="empty" style="padding:22px 16px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(e.message || 'Could not load the patient')}</p></div></div>`;
  }
}
function wlClosePatientCard() {
  const ov = document.getElementById('wl-pcard');
  if (ov) ov.remove();
  document.body.style.overflow = '';
  if (window._wlPcardEsc) { document.removeEventListener('keydown', window._wlPcardEsc); window._wlPcardEsc = null; }
}
window.wlOpenPatientCard = wlOpenPatientCard;
window.wlClosePatientCard = wlClosePatientCard;

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
  const isPureDigits = /^\d+$/.test(q);
  // Pure-digit query keeps the fast local behaviour: if it prefix-matches an MRN on
  // THIS board, the live filter is already showing them — keep it and don't hit network.
  if (isPureDigits) {
    const items = (wlState.data && wlState.data.items) || [];
    if (items.some((it) => String(it.mrno || '').replace(/\D/g, '').startsWith(digits))) {
      wlState.searchView = false; wlState.filter = digits; wlRender(); return;
    }
    // Not on this board → cross-branch find needs a full identifier.
    if (digits.length < 6) {
      if (typeof toast === 'function') toast('Nobody on this board. Type a full file # / ID / iqama / mobile, a name, or an accession to search other branches', 'err');
      return;
    }
  }
  // Name, accession (e.g. SIRA2599), or a full ID not on this board → cross-branch find.
  try {
    const d = await API.get('/radiology/find?q=' + encodeURIComponent(q));
    const pts = (d && d.patients) || [];
    if (!pts.length) { if (typeof toast === 'function') toast('No patient found on any branch for "' + escapeHtml(q) + '"', 'err'); return; }
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
  const colhead = document.getElementById('rw-colhead'); if (colhead) colhead.style.display = 'none';
  const rows = pts.slice(0, 25).map((p) => {
    const mrn = String(p.mrno || p.file_no || '');
    const nm = p.patientName || p.name || '—';
    const sub = [p.gender, p.birthDate || p.dob, p.branch].filter(Boolean).map(escapeHtml).join(' · ');
    const consent = wlIsFemale(p.gender)
      ? `<button class="btn" onclick="wlConsent('${jsAttr(mrn)}','${jsAttr(nm)}','','','${jsAttr(p.branch || '')}')">${icon('alert')}Consent</button>` : '';
    return `<div class="rw-match">
      <div class="rw-match-id"><div class="n">${escapeHtml(nm)} <span class="mrn">· ${escapeHtml(mrn)}</span></div>
        ${sub ? `<div class="s">${sub}</div>` : ''}</div>
      <div class="rw-match-acts">${consent}
        <button class="btn solid" onclick="wlOpenHandoff('${jsAttr(mrn)}')">Open →</button></div></div>`;
  }).join('');
  body.innerHTML = `<div class="rw-filterbar"><span>${pts.length} found on other branches — pick the patient</span>
    <button class="btn" onclick="wlClearFilter()">← Back to worklist</button></div>${rows}`;
}
