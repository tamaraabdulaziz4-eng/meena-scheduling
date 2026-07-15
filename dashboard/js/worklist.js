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
                seenEmerg: null, from: wlDefaultFrom(), to: wlTodayLocal(), filter: null, searchView: false,
                // Persistent per-order caches so a live refresh paints INSTANTLY and the
                // heavy per-order HIS work (modality/exam + pipeline stage) runs in the
                // background, only for rows we don't already know — never blocking paint.
                modCache: new Map(), stageCache: new Map(), pregCache: new Map(), payCache: new Map(),
                // Per-MRN clinical-indication index cache (bug #2 — inline row indication).
                indCache: new Map(),
                // Detail the fast RIS board can't carry — restored from the patient lookup:
                // per-bill clinic + referring-doctor phone, and per-MRN age/gender.
                orderDetail: new Map(), cardDetail: new Map(),
                // Per-MRN vitals cache (auto-loaded when an order row is expanded).
                vitalsCache: new Map(),
                // Live-pill + watchdog bookkeeping (bug #3): the timestamp of the last
                // good load, a "reconnecting" flag, and a monotonic load generation so a
                // hung request that the watchdog gave up on can never paint stale data.
                lastGood: 0, reconnecting: false, _loadGen: 0,
                // ── Unified redesign render state (worklist UI v2) ──
                // A single status vocabulary per order, ratcheted forward; the active tab;
                // row density; the checkbox selection (by MRN) and expanded rows (by row uid);
                // and the left-panel filters (modality set / priority / doctor / sort).
                tab: 'ordered', density: 'compact',
                selMrns: new Set(), openRows: new Set(),
                fMods: new Set(), fPrio: '', fDoc: '', fSort: 'recent',
                _docSig: null, mobFilters: false,
                statusRatchet: new Map() };

// Live board: refresh on a timer so a newly-arrived order (or a just-filed one
// dropping off) shows without the operator touching anything. ~20s still feels live for a
// pending-orders board while roughly halving the poll load vs the old 12s — the fast pass
// shares one connector-cached fetch across all viewers, and the html-exact repaint guard
// (wlRender) makes an unchanged tick a no-op. Hidden tabs don't poll (see wlStartTimer),
// and the heavy DePACS pass stays throttled (~3 min on the silent timer).
const WL_REFRESH_MS = 12000;

// Board data source override (preview): localStorage['wl:src']='ris' renders the fast
// RIS-panel board for THIS browser only, so it can be verified before flipping the default.
// Returns '' (no override) unless the value is a known source.
function wlBoardSrc() {
  try { const s = (localStorage.getItem('wl:src') || '').trim().toLowerCase(); return (s === 'ris' || s === 'search') ? s : ''; }
  catch (e) { return ''; }
}

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
  // Discriminate siblings by the most stable per-exam value available; NEVER the response
  // array index (it can reorder between the fast and enrich passes). Falls through svc id →
  // exam name → the exam's own HIS/DePACS ids so two exams on one bill can't collide even
  // when svcId and exam are both absent.
  const svc = it.svcId != null ? it.svcId
    : it.exam ? 'x' + it.exam
    : it.invPatTestResultId != null ? 'i' + it.invPatTestResultId
    : it.accession ? 'a' + it.accession
    : null;
  return svc != null ? base + ':' + svc : base;
}

// The hospital's operational day in KSA (UTC+3, no DST) as YYYY-MM-DD — computed from UTC
// so a device whose timezone isn't Asia/Riyadh still shows the correct KSA day (a
// browser-local date would put the board on the wrong day and hide/duplicate orders).
function wlTodayLocal() {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
// Default board = TODAY only (day-by-day). Use the From/To pickers or the ‹ › day-step
// arrows to look at another day or a wider window.
function wlDefaultFrom() { return wlTodayLocal(); }
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
  wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlSwitchReload();
}
// Editing From/To only STAGES the change — the board reloads when you press Apply (so
// setting a range doesn't fire a fetch on each keystroke/pick).
function wlSetFrom(v) {
  if (!v) return;
  wlState.from = v;
  if (wlState.to < v) wlState.to = v;                       // keep from <= to
  wlSyncDayControls();
}
function wlSetTo(v) {
  if (!v) return;
  wlState.to = v;
  if (v < wlState.from) wlState.from = v;
  wlSyncDayControls();
}
function wlApplyDates() {
  wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlSwitchReload();
}
function wlTodayRange() {
  wlState.from = wlDefaultFrom(); wlState.to = wlTodayLocal();
  wlState.seenEmerg = null; wlExitSearch(); wlSyncDayControls(); wlSwitchReload();
}
function wlSyncDayControls() {
  const f = document.getElementById('wl-from'); if (f) f.value = wlState.from;
  const t = document.getElementById('wl-to'); if (t) t.value = wlState.to;
  const btn = document.getElementById('wl-today-btn');
  const isToday = wlState.from === wlDefaultFrom() && wlState.to === wlTodayLocal();
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
  _wlCardOpen = false;   // safety: a fresh board load always resumes the background pumps
  setTopbar('Radiology worklist', 'Live RIS status board · STAT first');
  wlState.filter = null; wlState.searchView = false;   // never reopen stuck in a search view
  wlState._paintedOnce = false;                        // entrance animation once per visit
  wlState.reconnecting = false; wlState.lastGood = Date.now();
  wlState.from = wlDefaultFrom(); wlState.to = wlTodayLocal();   // default: prior day + today (survive midnight)
  // Fresh redesign view state on every entry: default tab, compact rows, nothing
  // selected/expanded, no left-panel filters.
  wlState.tab = 'ordered'; wlState.density = 'compact';
  wlState.selMrns.clear(); wlState.openRows.clear();
  wlState.fMods.clear(); wlState.fPrio = ''; wlState.fDoc = ''; wlState.fSort = 'recent';
  wlState._docSig = null; wlState.mobFilters = false;
  wlState.site = '';   // reset branch scope to match the freshly-rebuilt "All branches" dropdown
  // A "Open in Worklist" jump from the Orders page pre-seeds this — land straight on
  // that patient (search finds them even if they're not on today's board).
  const jumpMrn = window._wlPendingFilter; window._wlPendingFilter = null;
  const branch = (typeof currentUser !== 'undefined' && currentUser &&
    (currentUser.branchName || currentUser.branch || currentUser.siteName)) || '';
  const dateStr = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
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
        <span class="live" id="wl-live"><i></i><b>LIVE</b><span class="live-ago">updated 0s ago</span></span>
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
        <button class="ctrl tbtn today" id="wl-today-btn" onclick="wlTodayRange()">Today</button>
        <button class="ctrl" onclick="wlToggleDate()">${icon('calendar')}Date</button>
        <select id="wl-branch" class="ctrl wl-branchsel" onchange="wlOnBranch()">
          <option value="">All branches</option>
        </select>
        <button class="ctrl" id="wl-refresh-btn" title="Check for new requests now" onclick="wlManualRefresh()">${icon('refresh')}Update</button>
        <div class="datepop rw-datepop" id="wl-datepop" style="display:none">
          <button class="ctrl icon" onclick="wlShiftDay(-1)" title="Previous day">‹</button>
          <span class="dl">From</span>
          <input type="date" id="wl-from" value="${wlState.from}" onchange="wlSetFrom(this.value)" title="From date">
          <span class="dl">To</span>
          <input type="date" id="wl-to" value="${wlState.to}" onchange="wlSetTo(this.value)" title="To date">
          <button class="ctrl icon" onclick="wlShiftDay(1)" title="Next day">›</button>
          <button class="ctrl tbtn today" onclick="wlApplyDates()" title="Apply the selected date range">Apply</button>
        </div>
      </div>

      <nav class="rw-tabs" id="rw-tabs"></nav>

      <div class="rw-main">
        <div class="rw-fbar" id="rw-filters">
          <div class="fgrp"><span class="fh4">Modality</span><div class="chips" id="rw-modchips"></div></div>
          <div class="fgrp"><span class="fh4">Priority</span>
            <div class="frow-h">
              <label class="fopt"><input type="radio" name="rw-prio" value="" checked onchange="wlSetPrio('')">All</label>
              <label class="fopt"><input type="radio" name="rw-prio" value="stat" onchange="wlSetPrio('stat')">STAT</label>
              <label class="fopt"><input type="radio" name="rw-prio" value="routine" onchange="wlSetPrio('routine')">Routine</label>
            </div>
          </div>
          <div class="fgrp"><span class="fh4">Doctor</span><select class="fsel" id="rw-docsel" onchange="wlSetDoc(this.value)"><option value="">All doctors</option></select></div>
          <div class="fgrp"><span class="fh4">Sort</span><select class="fsel" id="rw-sortsel" onchange="wlSetSort(this.value)">
            <option value="recent"${wlState.fSort === 'recent' ? ' selected' : ''}>Most recent order</option>
            <option value="wait"${wlState.fSort === 'wait' ? ' selected' : ''}>Oldest first</option>
            <option value="prio"${wlState.fSort === 'prio' ? ' selected' : ''}>Priority first</option>
          </select></div>
          <button class="fclear" onclick="wlResetFilters()">Clear filters</button>
        </div>

        <section class="rw-list">
          <div class="rw-scroll">
            <div class="rw-colhead" id="rw-colhead">
              <span></span>
              <span>Patient · MRN</span>
              <span>Exam · Accession</span>
              <span>Branch · Clinic</span>
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
    // Populate the branch picker in the BACKGROUND — don't hold the board waiting for it.
    API.get('/radiology/branches').then((b) => {
      wlState.branches = (b && b.branches) || [];
      const s2 = document.getElementById('wl-branch');
      if (s2) for (const br of wlState.branches) {
        const o = document.createElement('option');
        o.value = br.siteId; o.textContent = br.shortName || br.name || ('Branch ' + br.siteId);
        s2.appendChild(o);
      }
    }).catch(() => { /* picker optional; org-wide roles can still see all */ });
  }
  // Restore the last board for this scope (survives a hard reload) so the FIRST paint is
  // instant; wlLoad then refreshes underneath.
  if (!wlState.data || !((wlState.data.items || []).length)) {
    try { const raw = sessionStorage.getItem('wl:board:' + wlScopeKey()); if (raw) { const s = JSON.parse(raw); if (s && s.data) wlState.data = s.data; } } catch (e) { /* ignore */ }
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
    el.innerHTML = '<i></i><b>Reconnecting…</b>';
    return;
  }
  const secs = wlState.lastGood ? Math.max(0, Math.round((Date.now() - wlState.lastGood) / 1000)) : 0;
  el.className = 'live';
  el.innerHTML = `<i></i><b>LIVE</b><span class="live-ago">updated ${secs}s ago</span>`;
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
function wlOnBranch() { wlState.site = document.getElementById('wl-branch').value; wlState.seenEmerg = null; wlExitSearch(); wlSwitchBranch(); }

// Branch switch (org-wide roles only). Unlike a DATE change — which fetches a genuinely
// different window — a branch is just a SUBSET of what's already on the board (the
// "All branches" load holds every branch's rows). So instead of blanking to the loading
// screen and force-refetching, we RE-FILTER and repaint INSTANTLY client-side (wlRender
// scopes items by wlState.site), then refresh SILENTLY in the background for fresh scoped
// data. This kills the "pick a branch → back to loading → loads again" flash.
//
// We deliberately DON'T clear the per-order caches/ratchet here (unlike wlSwitchReload):
// they're keyed per order, so keeping them lets the branch's rows keep their already-known
// modality/stage instead of blanking and re-shimmering. The per-order enrichment for the
// full board is still valid for the subset we now show.
function wlSwitchBranch() {
  wlState._loadGen++;             // supersede any in-flight (old-scope) load so it can't repaint
  wlState.loading = false;        // …so the silent refresh below isn't dropped by the lock
  _wlEnrichBusy = false;          // free the enrich lock for the (possibly narrower) new scope
  wlState.openRows.clear(); wlState.selMrns.clear();
  wlRender();                     // INSTANT: client-side site filter — branch rows if in hand,
                                  // else a brief empty (never a blank spinner or the wrong branch)
  wlLoad(false, true);            // silent background refresh — no loading flash
}

// Supersede any in-flight load and immediately fetch the new scope (branch/date). Without
// this, wlLoad early-returns while a poll is in flight, so the switch is silently dropped
// and the outstanding OLD-scope request repaints the previous branch until the next 12s
// tick — the "changing branch lags / keeps showing the previous branch" symptom. Bumping
// _loadGen neutralises the in-flight request's paint AND its lock release; clearing the
// per-scope caches/ratchet/enrich-lock stops the previous branch's rows and enrichment
// from lingering or starving the new branch.
function wlSwitchReload() {
  wlState._loadGen++;             // the in-flight load's gen is now stale → its paint is ignored
  wlState.loading = false;        // …and it won't touch the lock, so the new load isn't dropped
  _wlEnrichBusy = false;          // free the enrich lock so the new scope enriches immediately
  wlState.statusRatchet.clear();  // forward-only status is per-scope — don't carry it across
  wlState.modCache.clear(); wlState.stageCache.clear(); wlState.scannedSeen.clear();
  if (wlState.indCache) wlState.indCache.clear();
  wlState.openRows.clear(); wlState.selMrns.clear();
  // Instant repaint for a date window already viewed this session: restore its snapshot
  // and refresh underneath — stepping days back and forth never blanks the board. A
  // never-seen window clears the old scope's rows (showing them under a new date would
  // mislead) and paints the skeleton instead.
  wlState.data = null;
  try {
    const raw = sessionStorage.getItem('wl:board:' + wlScopeKey());
    if (raw) { const s = JSON.parse(raw); if (s && s.data) wlState.data = s.data; }
  } catch (e) { /* ignore */ }
  wlState.lastReady = null;       // new scope → let the ready pass re-fire right away
  // Ride the warm caches for the switch itself (server mirror / short caches / the
  // connector's board cache) instead of forcing a fresh HIS fan-out — this is what
  // made date changes feel slow. The 12s poll's ~30s nocache window still guarantees
  // HIS-side changes surface within half a minute.
  wlState.lastFresh = Date.now();
  wlLoad(false);
}

// Manual "Update" — the operator's instant check for NEW requests. Forces a fresh
// connector build (nocache) and re-runs the enrichment passes; the button spins while
// it works so the click visibly does something.
async function wlManualRefresh() {
  const btn = document.getElementById('wl-refresh-btn');
  if (btn) { btn.disabled = true; btn.classList.add('spin'); }
  try {
    await wlLoad(true);
    if (typeof toast === 'function') toast('Worklist updated');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('spin'); }
  }
}

// Cache key for the persisted board — keyed by the DATE window only. The board always holds
// every branch (the picker filters client-side), so it must NOT be keyed by wlState.site;
// otherwise switching branch would look for a different key, miss, and blank the board — the
// very "pick a branch → empty" bug. One superset per date window, filtered on render.
function wlScopeKey() { return `all|${wlState.from || ''}|${wlState.to || ''}`; }

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
  // OPEN INSTANTLY: if we already have a board in hand (this session, or restored from
  // sessionStorage on a fresh mount), paint it NOW and refresh underneath — a spinner only
  // shows when there is genuinely nothing to display. No more "press the button → spin".
  if (!silent && !wlState.filter) {
    if (wlState.data && ((wlState.data.items || []).length)) { wlHydrate(); wlRender(); }
    // Nothing in hand yet → paint the shimmer BOARD skeleton (row-cards), not a bare
    // "Loading…" spinner. Reads as "loading fast" and matches the board that lands.
    else { body.innerHTML = (typeof skeletonList === 'function') ? skeletonList(8) : LOADING_HTML; wlState._lastBodyHtml = null; }
  }
  // FAST load: no ready/modality — just the pending list, so the board paints in one
  // round-trip. The pipeline stage + exam/modality (per-order HIS work) come in a
  // background pass right after, and never block the first paint.
  const qs = new URLSearchParams();
  // ALWAYS fetch every branch (never scope the fetch to the picked branch). The branch
  // picker is a purely CLIENT-side filter (wlRender scopes by wlState.site), so the board
  // must always hold every branch's rows — otherwise picking branch A then switching to
  // branch B would filter A's data to zero (an instant blank board) and then hang on a
  // scoped refetch. A branch-locked team lead is still confined server-side (it ignores
  // any client sites), so this only widens what an org-wide role loads — which is exactly
  // the always-all-branches board they already start on.
  qs.set('from', wlState.from); qs.set('to', wlState.to);   // explicit range (prior day + today)
  // Opt-in preview of the fast RIS-panel board: set localStorage['wl:src']='ris' to test the
  // rendered board (lanes + buttons) before it becomes everyone's default.
  { const _s = wlBoardSrc(); if (_s) qs.set('src', _s); }
  // Silent polls are normally served from the connector's worklist cache, so a new/changed
  // order (or a new emergency) could lag up to the cache TTL + poll interval. Force a fresh
  // fetch on an explicit load AND at least every ~30s on the live timer, so HIS-side changes
  // surface within roughly half a minute without nocache-ing every 12s tick.
  // Don't force nocache on the very FIRST open (lastFresh unset) — let it hit the server's
  // 10s / connector's 12s worklist cache when any operator built this scope seconds ago,
  // turning a 28-call cold build into an instant cache hit. Explicit refresh + the ~30s
  // live-timer window still bypass the cache so HIS changes surface quickly.
  const fresh = force || (wlState.lastFresh && Date.now() - wlState.lastFresh > 30000);
  if (fresh) qs.set('nocache', '1');
  try {
    const data = await API.get('/radiology/worklist?' + qs.toString());
    if (wlState._loadGen !== gen) return;         // superseded — the watchdog gave up, a newer load owns the board
    if (fresh) wlState.lastFresh = Date.now();
    wlState.data = data;
    try { sessionStorage.setItem('wl:board:' + wlScopeKey(), JSON.stringify({ t: Date.now(), data })); } catch (e) { /* quota/private mode — ignore */ }
    // Status is driven by the NATIVE Siratech status (it.hisStatus), which the connector
    // stamps on the fast pass — so rows land in the right status bucket on the FIRST paint
    // with no DePACS wait (this is what removed the old "everyone sits in Waiting then
    // jumps" glitch). No stage-withholding needed.
    wlState.lastGood = Date.now(); wlState.reconnecting = false; wlPaintLive();
    wlHydrate();                                  // paint known modality/exam/stage instantly from cache
    wlRender();
    wlEnrich(silent, force);                      // background: fill stage + modality for unknown rows
    wlPrefetchCards();                            // warm the patient card for the top rows so opening is instant
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
        wlState._lastBodyHtml = null;
      }
    }
  } finally {
    clearTimeout(watchdog);
    if (wlState._loadGen === gen) wlState.loading = false;   // ALWAYS release our own lock
  }
}

// PREDICTIVE WARM: once the board lands, quietly pre-load the patient card for the top
// rows into psLookupCache so tapping "Full patient card" (or a row) opens INSTANTLY with
// no spinner. Runs on idle at low concurrency so the 2GB HIS box is never stressed — this
// only warms the lightweight /radiology/lookup panel (same call the card's first paint
// makes). The first DEEP_WARM rows additionally get their heavy sections (clinical
// history, visits, labs, appointments) prefetched via psPrefetchCard, and hovering
// any row warms that patient's full card — so one click opens complete, no spinners.
let _wlCardWarmGen = 0;
function wlPrefetchCards() {
  if (typeof psPrefetchLookup !== 'function') return;        // patientsearch.js not loaded — nothing to warm
  const items = (wlState.data && wlState.data.items) || [];
  if (!items.length) return;
  // Unique MRNs in board order, capped — the rows the operator is most likely to open first.
  const seen = new Set(); const mrns = [];
  for (const it of items) {
    const m = String(it.mrno || '').trim();
    if (!m || seen.has(m)) continue;
    seen.add(m); mrns.push(m);
    if (mrns.length >= 20) break;
  }
  if (!mrns.length) return;
  const myGen = ++_wlCardWarmGen;                            // a newer board load cancels this sweep
  const CONC = 2; let idx = 0;
  // Deep-warm budget: the FIRST few rows also get their card's heavy sections
  // (clinical history, visits, labs, appointments) prefetched, so opening them is one
  // paint with zero spinners. Kept small — the connector caches + single-flights these
  // per patient now, but the 2 GB box still shouldn't see 20 patients × 4 sections.
  const DEEP_WARM = 5; let deep = 0;
  const pump = () => {
    if (myGen !== _wlCardWarmGen) return;                    // superseded — stop warming stale rows
    if (idx >= mrns.length) return;
    const mrno = mrns[idx++];
    let done = false;
    const next = () => { if (done) return; done = true; pump(); };
    try {
      const p = psPrefetchLookup(mrno);                      // no-op if already warm/in-flight
      if (p && typeof p.then === 'function') {
        // As each warm-up lands, backfill the clinic/phone/age/gender the fast board can't carry
        // so the VISIBLE (collapsed) rows show them too — not only expanded ones.
        p.then((lk) => {
          try { wlBackfillDetail(mrno, lk); } catch (e) {}
          if (myGen === _wlCardWarmGen && deep < DEEP_WARM && typeof psPrefetchCard === 'function') {
            deep++;
            psPrefetchCard(mrno);                            // sections ride the fresh lookup
          }
        }, () => {});
        p.then(next, next);
      } else next();
    } catch (e) { next(); }
  };
  const kick = () => { for (let i = 0; i < CONC; i++) pump(); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(kick, { timeout: 1500 });
  else setTimeout(kick, 250);
}

// HOVER-WARM (instant.page for the board): the moment the operator's pointer settles on
// a row — a strong "about to open" signal — warm that patient's FULL card (lookup +
// clinical/visits/labs/appointments). All layers dedupe and single-flight (client
// section cache → server → connector per-patient caches), so lingering or re-hovering
// costs nothing, and a hover typically buys 200-600ms of head start before the click.
let _wlHoverTimer = null, _wlHoverMrn = null;
document.addEventListener('pointerover', (e) => {
  const row = e.target && e.target.closest && e.target.closest('.rw-row[data-mrn]');
  if (!row) return;
  const mrn = row.getAttribute('data-mrn');
  if (!mrn || mrn === _wlHoverMrn) return;
  _wlHoverMrn = mrn;
  clearTimeout(_wlHoverTimer);
  // Small settle delay so skimming the pointer down the board doesn't warm every row.
  _wlHoverTimer = setTimeout(() => {
    if (typeof psPrefetchCard === 'function') psPrefetchCard(mrn);
  }, 120);
}, { passive: true });

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
    // Restore the pipeline stage FORWARD-ONLY from cache. The fast RIS board carries no PACS
    // data, so it stamps every non-reported row 'ordered' — without this ratchet, each fast
    // poll would overwrite an 'imaged'/'reported' stage the PACS pass had established, and the
    // Pending Report lane would flash in (on the ready pass) then vanish (on the next poll).
    // A genuinely-newer higher stage on the incoming row still wins (rank comparison).
    { const s = wlState.stageCache.get(k); if (s && wlStageRank(s) > wlStageRank(it.stage)) it.stage = s; }
    // Payment (patient-outstanding) is read on the opt-in pay pass; restore it from cache
    // so a plain refresh keeps the paid/unpaid badge instead of blanking it.
    if (it.paymentKnown == null) { const p = wlState.payCache.get(k); if (p) { it.paymentKnown = true; it.unpaid = p.unpaid; it.patientDue = p.patientDue; it.sponsorAmt = p.sponsorAmt; it.billed = p.billed; if (p.payer && !it.payer) it.payer = p.payer; } }
    // "scanned" is a hard fact (Siratech recorded the exam start/end) — once true it
    // stays true, so a later load where the RIS panel omitted the times can't drop the
    // row back off the Imaged strip.
    if (it.scanned) wlState.scannedSeen.add(k);
    else if (wlState.scannedSeen.has(k)) it.scanned = true;
  }
  // Re-apply the lookup-derived clinic/phone/age/gender so a fast poll (which brings none of
  // it) doesn't blank the columns the patient lookup already filled in.
  wlApplyDetail();
}

// Background pass: fetch the board WITH ready=1 (pipeline stage) + modality=1 (exam +
// modality) — the heavy per-order HIS work — and merge it onto the visible rows.
// Always runs on a manual/explicit load; on a silent live refresh it runs when a new
// row still lacks a stage OR it's been >2 min since the last enrich — so pipeline
// progress (ordered→imaged→report-ready) actually keeps updating on the live board,
// while a steady board stays light. Never blocks paint; caches results so paints are
// instant. Cache-restored stages are refreshed by the periodic re-check.
let _wlEnrichBusy = false;
let _wlEnrichSeq = 0;   // per-invocation token: a hung pass's watchdog/finally must not clobber a newer pass
async function wlEnrich(silent, force) {
  if (_wlEnrichBusy) return;
  const items = (wlState.data && wlState.data.items) || [];
  if (!items.length) return;
  const anyMissing = items.some((it) => !it.stage || !it.exam);
  // Only the exam/modality cells drive the modality pass — the stage pass is gated below.
  const examMissing = items.some((it) => !it.exam);
  // Re-check the pipeline stage on (almost) every live refresh so promotions
  // (ordered→imaged→reported) show within a poll — the DePACS lookups are now
  // short-window + cached on the connector, so this is cheap. The ratchet in
  // wlMergeEnrich guarantees a row never moves backward, so more-frequent checks
  // only ever fill in progress, never cause flicker.
  if (silent && !anyMissing && (Date.now() - (wlState.lastEnrich || 0) < 12000)) return;
  _wlEnrichBusy = true;
  const myEnrich = ++_wlEnrichSeq;   // this pass owns the lock/shimmer only while it's the latest
  // Tie this enrich to the load generation that started it: if the operator switches
  // branch/date mid-flight (which bumps _loadGen), a late old-scope enrich response must
  // NOT merge onto the new scope's board.
  const enrichGen = wlState._loadGen;
  // WATCHDOG (bug #3): never let a hung enrichment pass wedge the busy lock forever —
  // release it after ~120s so a later refresh can retry the pipeline-stage lookups. Only
  // release if THIS pass is still the latest, else it would free a newer pass's lock.
  const enrichWatch = setTimeout(() => { if (myEnrich === _wlEnrichSeq) _wlEnrichBusy = false; }, 120000);
  // Show the loading shimmer on the not-yet-filled cells while this pass runs.
  if (anyMissing) { wlState.enriching = true; if (document.getElementById('wl-body')) wlRender(); }
  const mkQs = (flags) => {
    const qs = new URLSearchParams();
    // All branches (the picker is a client-side filter) — must match the fast-pass fetch
    // scope so enrichment keys line up with the rows on the board.
    qs.set('from', wlState.from); qs.set('to', wlState.to);
    { const _s = wlBoardSrc(); if (_s) qs.set('src', _s); }   // keep the RIS preview consistent across passes
    for (const k of Object.keys(flags)) qs.set(k, flags[k]);
    return qs.toString();
  };
  // Two INDEPENDENT passes in parallel — this is what makes the board feel like the
  // native RIS panel. exam+modality is pure HIS work and returns quickly; the
  // pipeline stage does per-patient DePACS matching and is the slow one. The old
  // single combined request made the Exam/Type columns shimmer until the SLOWEST
  // work finished; now each pass merges + repaints the moment it lands.
  try {
    const passes = [];
    // Modality/exam enrichment — fast HIS work. After PR #252 the bulk FetchRISPanel fills
    // exam+modality for the whole board on the fast pass, so this per-order fallback only
    // needs to run when a row is ACTUALLY missing an exam (usually none). Skipping it on a
    // healthy board removes a whole round-trip from every open/refresh.
    if (examMissing) {
      passes.push(API.get('/radiology/worklist?' + mkQs({ modality: '1' })).then((d) => { if (wlState._loadGen === enrichGen) wlMergeEnrich(d, false); }).catch(() => {}));
    }
    // Pipeline STAGE — the slow per-patient DePACS "ready" pass. It NO LONGER withholds the
    // first paint (the fast pass already placed rows by native hisStatus, and the stage
    // ratchet in wlMergeEnrich keeps it flicker-free), so the old "everyone waits then jumps"
    // glitch can't return. But it must run, throttled, because it's the ONLY signal that
    // advances the Meena ledger to state='reported'/reported_at on the server — which powers
    // orphan detection (a verified report that never reached the patient file), TAT stats,
    // and the cold-open Final seed. Run it on an explicit load, and at most every ~3 min on
    // the live timer so it stays light on the connector.
    //
    // NOT on page open: the fast pass already seeds DePACS-confirmed Final from the server
    // store, so the board is correct without paying the slow ready pass on the very first
    // paint. It runs on an EXPLICIT refresh (force — the Refresh button / an action reload)
    // and, on the silent live timer, at most every ~3 min to keep the Meena ledger
    // (state='reported', TAT, orphan detection) advancing. A plain page-open load is neither
    // force nor silent, so it skips ready entirely — the biggest cut to first-open latency.
    // On the FAST RIS board we DO want the ready pass right after the first instant paint —
    // it's a light background DePACS enrichment that fills the middle of the pipeline (imaged
    // exams → Completed lane) that the panel alone can't see. So fire it once on the first RIS
    // load, then throttle to ~3 min like the live timer. The legacy search board keeps its
    // "not on open" behaviour (its ready pass is the slow per-patient work we defer).
    // The server now keeps a warm ready-mirror (the DePACS stage board refreshed by a
    // background loop), so a ready request normally returns from the DB in a few ms —
    // fire it unconditionally right after the FIRST paint on any board so the Pending
    // Report lane fills instantly, and keep the usual throttle afterwards. When the
    // mirror is cold it simply costs what the first-load pass always cost.
    const _firstReady = wlState.lastReady == null;
    const readyDue = force || (silent && (Date.now() - (wlState.lastReady || 0) > 25000)) || _firstReady;
    if (readyDue) {
      passes.push(API.get('/radiology/worklist?' + mkQs({ ready: '1' }))
        .then((d) => { if (wlState._loadGen === enrichGen) { wlMergeEnrich(d, true); wlState.lastReady = Date.now(); } }).catch(() => {}));
    }
    // Payment/billing pass removed — the board no longer fetches patient outstanding
    // balances (bill/revenue isn't needed on the worklist). This also drops the heavy
    // per-bill GetDueBillDetailsByID fan-out on the connector (hundreds of HIS calls per
    // board load for heavy-billing patients). The paid/unpaid badge is guarded on
    // `paymentKnown`, so it simply stops rendering — no other change needed.
    await Promise.all(passes);
    wlState.lastEnrich = Date.now();
  } finally {
    clearTimeout(enrichWatch);
    // Only the LATEST pass owns the lock/shimmer — a superseded pass settling late must not
    // free a newer pass's lock or kill its shimmer.
    if (myEnrich === _wlEnrichSeq) {
      _wlEnrichBusy = false;
      // Settle: turn the shimmer off and repaint with whatever filled in (rows still
      // empty after this pass fall back to "—" — that's the connector's per-order cap).
      wlState.enriching = false;
      if (document.getElementById('wl-body')) wlRender();
    }
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
  // Prune the enrichment caches when they get large. The statusRatchet is deliberately NOT
  // cleared here: clearing it lets a row whose momentary fast-pass status is ambiguous
  // recompute backward (e.g. Completed → Ordered) and jump tabs. It carries the forward-only
  // guarantee, so prune it only on its own far-higher watermark as a last-resort memory cap.
  if (wlState.modCache.size > 3000) { wlState.modCache.clear(); wlState.stageCache.clear(); wlState.scannedSeen.clear(); }
  if (wlState.statusRatchet.size > 8000) wlState.statusRatchet.clear();
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

// Merge the payment pass (patient-outstanding) onto the visible rows + cache it, so the
// paid/unpaid badge survives a plain refresh. Only rows with paymentKnown are stamped —
// an unread bill leaves the row unmarked (never a false "unpaid").
function wlMergePay(d) {
  if (wlState.payCache.size > 4000) wlState.payCache.clear();
  const enr = new Map();
  for (const it of ((d && d.items) || [])) {
    const k = wlRowKey(it); if (!k || !it.paymentKnown) continue;
    const rec = { unpaid: !!it.unpaid, patientDue: it.patientDue, sponsorAmt: it.sponsorAmt, billed: it.billed, payer: it.payer };
    enr.set(k, rec); wlState.payCache.set(k, rec);
  }
  if (enr.size && wlState.data && Array.isArray(wlState.data.items)) {
    for (const it of wlState.data.items) {
      const k = wlRowKey(it); if (!k) continue;
      const e = enr.get(k); if (!e) continue;
      it.paymentKnown = true; it.unpaid = e.unpaid; it.patientDue = e.patientDue;
      it.sponsorAmt = e.sponsorAmt; it.billed = e.billed;
      if (e.payer && !it.payer) it.payer = e.payer;
    }
  }
  if (document.getElementById('wl-body')) wlRender();
}

// Pipeline stage → badge. Each stage is detected from a specific signal:
//   ordered  — order line present in Siratech, no images yet
//   imaged   — a study exists in DePACS/PACS (scan done), not yet reported
//   reported — the DePACS study is VERIFIED (signed) → auto-file files it and it
//              then drops off this board on its own.
// (The legacy wlRisStatus() lane-badge mapper was removed — the unified status model
// below is the single source of truth for the board; it.stage still drives that model.)
// ── Unified status model (worklist UI v2) ──────────────────────────────────────
// One vocabulary for the whole board: ordered → received → progress → completed →
// reported. `wlStatusRaw` reads the freshest signal; `wlStatus` RATCHETS it forward
// (a row never moves backward on a live refresh — same guarantee the old lane ratchet
// gave). STAT/urgent (it.emergency) is a cross-cutting flag, not a status.
const WL_STATUS_LABEL = { ordered: 'Ordered', received: 'Received', progress: 'In progress',
                          completed: 'Pending report', reported: 'Reported', notdone: 'Not done' };
const _WL_ST_RANK = { ordered: 0, received: 1, progress: 2, completed: 3, reported: 4 };
const _WL_ST_BY_RANK = ['ordered', 'received', 'progress', 'completed', 'reported'];
function wlStatusRaw(it) {
  // A Meena "Not Done" (locally cancelled) order is terminal and off the progress ladder.
  if (it.localStatus === 'cancelled') return 'notdone';
  const s = String(it.hisStatus || '').toLowerCase();
  // A NEGATED HIS status ("Not Started", "Not Done", "Incomplete") must not trip the
  // positive substring tests below (which would read "started"/"done"/"complet") — those
  // wrongly advance a fresh order and the forward ratchet then locks it there. The reliable
  // overlay/stage signals stay authoritative regardless.
  const neg = /\bnot\b|incomplete/.test(s);
  if (it.hisReported || it.stage === 'reported' || it.readyToFile) return 'reported';
  // Operator overlay actions (completedAt/startedAt/receivedAt) advance the row alongside
  // the HIS signals, so a manually-driven exam moves even before Siratech reflects it.
  if (it.completedAt || it.scanned || it.stage === 'imaged' || it.examEndAt || it.stage === 'draft'
      || (!neg && /scan\s*done|complet|\bdone\b|acquir|imaged/.test(s))) return 'completed';
  if (it.startedAt || it.examStartAt || (!neg && /in\s*progress|scanning|ongoing|started/.test(s))) return 'progress';
  if (it.receivedAt || it.arrivedAt || (!neg && /arrived/.test(s))) return 'received';
  return 'ordered';
}
// True only when a real study exists to open. An operator's overlay "Complete" advances the
// lane but does NOT mean PACS has a study — without this a Report/Images button on an
// un-imaged 'completed' row fires openStudyViewer with an empty accession and surfaces the
// wrong exam (or a dead end) for a multi-exam patient. Mirrors the orders.js study predicate.
function wlHasStudy(it) {
  return !!(it.accession || it.accessionNumber || it.invPatTestResultId || it.imagedAt || it.scanned
            || it.stage === 'imaged' || it.stage === 'draft' || it.stage === 'reported');
}
function wlStatus(it) {
  const raw = wlStatusRaw(it);
  if (raw === 'notdone') return 'notdone';             // terminal — never ratcheted
  const k = wlRowKey(it);
  if (!k) return raw;                                  // keyless → can't ratchet safely
  const rawRank = _WL_ST_RANK[raw];
  const r = wlState.statusRatchet.get(k);
  if (r == null || rawRank >= r.rank) {                // forward (or first sight) → accept
    wlState.statusRatchet.set(k, { rank: rawRank, low: 0 });
    return raw;
  }
  // raw is BELOW the furthest-along status seen. A bare FAST poll cannot see PACS, so an
  // imaged row (Pending Report) reads back as 'ordered' every ~30s between the throttled DePACS
  // passes — that is NOT a genuine revert, and counting it is exactly what made Pending Report
  // flash in then DISAPPEAR. So only count a lower read toward the revert when it is
  // DePACS-GROUNDED (the ready pass ran → readyToFile is defined) or a terminal cancel; on a
  // plain fast poll, HOLD the higher status without counting it.
  const grounded = (it.readyToFile !== undefined && it.readyToFile !== null) || it.localStatus === 'cancelled';
  if (!grounded) return _WL_ST_BY_RANK[r.rank];         // fast poll can't demote — hold
  // A genuine revert (order re-opened, report un-verified) stays lower across GROUNDED reads —
  // accept it after a few so the row isn't pinned at a stale higher status forever.
  const low = (r.low || 0) + 1;
  if (low >= 3) { wlState.statusRatchet.set(k, { rank: rawRank, low: 0 }); return raw; }
  wlState.statusRatchet.set(k, { rank: r.rank, low });
  return _WL_ST_BY_RANK[r.rank];                        // hold the furthest-along status (for now)
}
// The tabs across the top; counts are computed live in wlRenderTabs.
const WL_TABS = [['all', 'All', false], ['ordered', 'Ordered', false], ['received', 'Received', false],
  ['progress', 'In Progress', false], ['completed', 'Pending Report', false], ['reported', 'Reported', false],
  ['notdone', 'Not Done', false], ['urgent', 'Urgent', true]];
// A DOM-safe, stable-per-order id for the expand Set + onclick (mirrors the old drill key).
function wlRowUid(it) {
  const k = wlRowKey(it);
  if (k) return 'u' + String(k).replace(/[^A-Za-z0-9_-]/g, '');
  // Keyless order (no genPatBillingId / billNo): still disambiguate per exam so two exams for
  // the same MRN don't share a uid (which made them co-expand and cross-talk on status).
  const disc = it.invPatTestResultId || it.accession || it.exam || '';
  return 'u' + ('m' + (it.mrno || '') + (disc ? '_' + disc : '')).replace(/[^A-Za-z0-9_-]/g, '');
}
// Modality of a row, normalised to the coarse RIS bucket for filtering.
function wlRowMod(it) {
  // Word-boundary matching (a plain substring wrongly read "SINUS" as US, hiding the
  // consent/pregnancy safety prompt on a radiation exam). Kept in step with psModBucket.
  const raw = String(it.modality || it.exam || '').toUpperCase();
  if (/\bMRI?\b|MAGNET/.test(raw)) return 'MR';
  if (/ULTRA|SONO|\bUS\b|DOPPLER/.test(raw)) return 'US';
  if (/\bDEXA\b|\bDXA\b|\bBMD\b|BONE\s*DENSIT|DENSITOMET/.test(raw)) return 'BMD';  // ionizing (low-dose)
  if (/\bCT\b|COMPUTED|TOMOGRAPH/.test(raw)) return 'CT';
  if (/MAMMO|\bMG\b/.test(raw)) return 'MG';
  if (/X.?RAY|\bXR\b|\bCR\b|\bDX\b|\bDR\b|RADIOGRAPH/.test(raw)) return 'XR';
  return null;
}

function wlRender() {
  const d = wlState.data || {};
  let items = d.items || [];
  // Client-side branch scope: the board may hold ALL branches (an org-wide "All branches"
  // load) while the operator has picked one branch — filter to that site so switching
  // branch repaints INSTANTLY from data already in hand, with no refetch/loading flash.
  // When the server already scoped the fetch (branch team lead, or after the silent scoped
  // refresh lands) this is a harmless no-op.
  if (wlState.site) items = items.filter((it) => String(it.site) === String(wlState.site));
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
    wlState._lastBodyHtml = null;   // typeahead view — next full-board render must repaint
    wlRenderTabs(items);
    wlAutoPreg(); wlAutoIndication(); wlAutoVitals(); wlSyncActionbar();
    return;
  }

  wlRenderTabs(items);
  wlRenderFilters(items);
  if (!items.length) {
    body.innerHTML = `<div class="empty"><div class="ei">🗂️</div><p>No orders awaiting a result.</p></div>`;
    wlState._lastBodyHtml = null;
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

  const html = rows.length
    ? wlRowsHtml(rows)
    : `<div class="empty"><div class="ei">🗂️</div><p>No orders match this view.</p><div class="hint">Try clearing a filter or switching tabs.</div></div>`;
  // Skip the DOM teardown when the board is byte-identical to what's already painted. On a
  // steady board the silent poll produces the same HTML every tick, and rebuilding hundreds
  // of rows each time is the visible flicker/scroll-jump. Any real change (new order, stage
  // promotion, tab/filter/selection) alters the HTML and repaints normally; skipping the
  // no-op assignment also PRESERVES async-injected cell content (vitals/indication) instead
  // of wiping and re-fetching it every tick.
  if (html !== wlState._lastBodyHtml || !body.firstChild) {
    body.innerHTML = html;
    wlState._lastBodyHtml = html;
  }

  // Selection + expanded state are re-derived from the wlState Sets while building the
  // row HTML, so they survive every repaint with no separate restore pass.
  wlAutoPreg();           // auto-check pregnancy status for female rows (throttled, cached)
  wlAutoIndication();     // auto-fetch the clinical indication for waiting/in-progress rows
  wlAutoVitals();         // auto-fetch vitals for any EXPANDED order row (throttled, cached)
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
  // Received / In Progress can't be populated from the branch-wide RIS feed — Siratech only
  // exposes patient-arrived / actively-scanning per-patient, not in the whole-board call. So
  // hide those two lanes while empty (self-adjusting: if a row ever lands there, or it's the
  // active tab, it reappears) instead of showing permanently-0 dead tabs. The real pipeline on
  // this feed is Ordered → Completed (images in PACS, report pending) → Reported.
  const _dead = (k) => (k === 'received' || k === 'progress') && !cnt[k] && wlState.tab !== k;
  el.innerHTML = WL_TABS.filter(([k]) => !_dead(k)).map(([k, lbl, urg]) =>
    `<button class="rw-tab${urg ? ' urg' : ''}${wlState.tab === k ? ' on' : ''}" onclick="wlSetTab('${k}')">${urg ? '🚨 ' : ''}${lbl}<span class="cnt tnum">${cnt[k] || 0}</span></button>`
  ).join('');
}

// ── Left filter panel (modality chips from the modalities present + the distinct
//    referring doctors). Radios / sort stay static in the shell and drive wlState. ──
const _WL_MOD_META = { CT: ['CT', '#6B4EFF'], MR: ['MRI', '#3BA0FF'], US: ['US', '#00C896'], XR: ['X-Ray', '#8358FD'], MG: ['Mammo', '#E4739B'], BMD: ['BMD', '#14B8A6'] };
function wlRenderFilters(items) {
  const modCounts = {};
  for (const it of items) { const m = wlRowMod(it); if (m) modCounts[m] = (modCounts[m] || 0) + 1; }
  // If a selected modality has left the board, drop it so the view can't strand empty.
  for (const m of [...wlState.fMods]) if (!modCounts[m]) wlState.fMods.delete(m);
  const order = ['CT', 'MR', 'US', 'XR', 'MG', 'BMD'].filter((k) => modCounts[k]);
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

const wlSAR = (n) => Math.round(Number(n) || 0).toLocaleString('en-US') + ' SAR';

// Payment cell for the expand grid: who pays, what's billed, and any patient balance due.
function wlPayHtml(it) {
  if (!it.paymentKnown) return '';
  const meta = [it.payer ? escapeHtml(it.payer) : '', it.billed != null ? 'billed ' + wlSAR(it.billed) : '']
    .filter(Boolean).join(' · ');
  const v = it.unpaid
    ? `<span style="color:var(--danger-ink);font-weight:800">Patient owes ${wlSAR(it.patientDue)}</span>`
    : `<span style="color:var(--ok-ink,#0a7d38);font-weight:700">✓ No patient balance</span>`;
  // Superadmin-only diagnostic: how "owes" was derived + one bill line's amount fields.
  // Lets us confirm on-device whether the figure is the true outstanding vs the total share.
  let diag = '';
  if (typeof currentUser !== 'undefined' && currentUser && currentUser.role === 'superadmin') {
    const parts = [];
    if (it.dueSource) parts.push('src: ' + escapeHtml(String(it.dueSource)));
    if (wlState.payDiag && wlState.payDiag.sample) parts.push('bill fields: ' + escapeHtml(JSON.stringify(wlState.payDiag.sample)));
    if (parts.length) diag = `<div class="dept" style="margin-top:3px;opacity:.7;font-size:10px;word-break:break-all">${parts.join(' · ')}</div>`;
  }
  return `<div class="xf"><div class="k">Payment</div><div class="v">${v}${meta ? `<div class="dept" style="margin-top:2px">${meta}</div>` : ''}${diag}</div></div>`;
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
  // Ordered rows have no DICOM accession yet (it's assigned at imaging) — fall back to the
  // HIS order/request number so every row carries a traceable identifier.
  const accCell = acc ? escapeHtml(String(acc))
    : (it.billNo ? '<span title="HIS order number (no accession until imaged)">Order #' + escapeHtml(String(it.billNo)) + '</span>'
                 : '<span style="color:var(--muted)">no accession</span>');
  const gender = it.gender ? String(it.gender).charAt(0).toUpperCase() : '';
  const ageg = [it.age, gender].filter((x) => x != null && x !== '').map((x) => escapeHtml(String(x))).join('');
  // The referring clinic (Family Medicine, ENT, …) — its own line, distinct from the doctor.
  const clinic = it.department || '';
  const consentChip = (wlNeedsRadSafety(it) && !it.consentOnFile) ? '<span class="consent-tag">CONSENT</span>' : '';
  // Payment: red "UNPAID" chip when the patient still owes a portion on this order's bill.
  // Only shown when the bill was actually read (paymentKnown) — never a false flag.
  const payChip = (it.paymentKnown && it.unpaid)
    ? `<span class="pay-tag unpaid" title="Patient portion still due${it.patientDue ? ' — ' + wlSAR(it.patientDue) : ''}">UNPAID${it.patientDue ? ' · ' + wlSAR(it.patientDue) : ''}</span>`
    : '';
  const prelim = (st === 'completed' && it.stage === 'draft');
  const pillNote = prelim ? '<div class="prelim-note">Preliminary read</div>' : '';
  const examCell = it.exam
    ? `<span class="ename">${escapeHtml(it.exam)}</span>`
    : (enriching ? '<span class="wl-shimmer" style="width:120px"></span>' : '<span class="ename" style="color:var(--muted)">—</span>');
  const canReport = (st === 'completed' || st === 'reported') && wlHasStudy(it);
  const primaryAct = canReport
    ? `<button class="iconbtn primary" title="Report & images" onclick="event.stopPropagation();openStudyViewer(this,'${jsAttr(mrn)}','${jsAttr(acc)}','${jsAttr(it.invPatTestResultId || '')}')" onmouseenter="studyPrefetch('${jsAttr(mrn)}','${jsAttr(acc)}','${jsAttr(it.invPatTestResultId || '')}')" ontouchstart="studyPrefetch('${jsAttr(mrn)}','${jsAttr(acc)}','${jsAttr(it.invPatTestResultId || '')}')">${icon('file-text')}</button>`
    : `<button class="iconbtn" title="Handoff" onclick="event.stopPropagation();wlOpenHandoff('${jsAttr(mrn)}')">${icon('inbox')}</button>`;
  return `<div class="rw-row${sel ? ' sel' : ''}${stat ? ' stat' : ''}${open ? ' open' : ''}" data-mrn="${escapeHtml(mrn)}" onclick="wlToggleRow('${uid}',event)">
    <span class="rw-check${sel ? ' on' : ''}" onclick="wlToggleSel('${jsAttr(mrn)}',event)">${icon('check')}</span>
    <div class="pt">
      <div class="l1"><span class="pname">${escapeHtml(it.patientName || '—')}</span>${stat ? '<span class="stat-tag">STAT</span>' : ''}${consentChip}${payChip}</div>
      <div class="l2 tnum"><span class="mrn-chip">MRN <b>${escapeHtml(mrn)}</b></span>${ageg ? `<span>${ageg}</span>` : ''}${det && it.doctorName ? `<span>Dr ${escapeHtml(it.doctorName)}</span>` : ''}</div>
    </div>
    <div class="exam">
      <div class="l1">${modBadges(it.modality) || ''}${examCell}</div>
      <div class="l2">${accCell}</div>
    </div>
    <div class="branch-cell"><span class="branch-name">${escapeHtml(it.branch || '—')}</span>${clinic ? `<div class="dept" title="Referring clinic">${icon('clinic') || ''}<span>${escapeHtml(clinic)}</span></div>` : '<div class="dept dept-none">No clinic</div>'}</div>
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
  const canReport = (st === 'completed' || st === 'reported') && wlHasStudy(it);
  const needConsent = wlNeedsRadSafety(it) && !it.consentOnFile;
  const demo = [it.age != null ? escapeHtml(String(it.age)) + 'y' : '', genderFull].filter(Boolean).join(' · ');
  const chips = [`MRN ${escapeHtml(mrn)}`, demo, it.branch ? escapeHtml(it.branch) : '']
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
    ${(!needConsent && wlNeedsRadSafety(it) && it.consentOnFile) ? (it.consentFiled
      ? `<div class="alert" style="color:var(--success-ink,#0a7d38);background:var(--ok-wash,#e6f6ec)">${icon('check')}Non-pregnancy consent on the Siratech file ✓</div>`
      : `<div class="alert" style="color:var(--warn-ink,#7a4b00);background:#fffaf2">${icon('alert')}Consent signed — filing to the Siratech file…</div>`) : ''}
    ${(st === 'notdone' && it.cancelReason) ? `<div class="alert" style="color:var(--danger-ink);background:var(--danger-wash)">${icon('alert')}Not done · ${escapeHtml(it.cancelReason)}</div>` : ''}
    ${it.note ? `<div class="alert" style="color:var(--text);background:var(--surface-2)">${icon('edit')}${escapeHtml(it.note)}</div>` : ''}
    ${preg ? `<div class="rw-preg">${preg}</div>` : ''}
    <div class="xgrid">
      <div class="xf"><div class="k">Exam</div><div class="v">${it.modality ? escapeHtml(String(it.modality)) + ' · ' : ''}${it.exam ? escapeHtml(it.exam) : '<span style="color:var(--muted)">—</span>'}</div></div>
      <div class="xf"><div class="k">${acc ? 'Accession' : 'Order no.'}</div><div class="v tnum">${acc ? escapeHtml(String(acc)) : (it.billNo ? escapeHtml(String(it.billNo)) : '—')}</div></div>
      <div class="xf"><div class="k">Referring clinic</div><div class="v">${dept ? escapeHtml(dept) : '<span style="color:var(--muted)">—</span>'}</div></div>
      <div class="xf"><div class="k">Ordering doctor</div><div class="v">${it.doctorName ? 'Dr ' + escapeHtml(it.doctorName) : '—'}${it.doctorPhone ? ` · <a href="tel:${escapeHtml(String(it.doctorPhone).replace(/[^0-9+]/g, ''))}" onclick="event.stopPropagation()" style="color:var(--accent);text-decoration:none;font-variant-numeric:tabular-nums" dir="ltr">${escapeHtml(String(it.doctorPhone))}</a>` : ''}</div></div>
      <div class="xf"><div class="k">Ordered</div><div class="v tnum">${it.orderedDate ? escapeHtml(wlTrackFmt(it.orderedDate)) : (age ? age + ' ago' : '—')}</div></div>
      <div class="xf"><div class="k">Technologist</div><div class="v">${it.assignedTechName ? escapeHtml(String(it.assignedTechName)) : '<span style="color:var(--muted)">Unassigned</span>'}</div></div>
      <div class="xf"><div class="k">Priority</div><div class="v">${it.emergency ? '<span style="color:var(--danger-ink);font-weight:800">STAT / Emergency</span>' : 'Routine'}</div></div>
      ${wlPayHtml(it)}
    </div>
    <div class="xsec-title">Clinical indication</div>
    <div class="rw-xind">${wlIndEl(it)}</div>
    <div class="xsec-title">Vital signs</div>
    <div class="rw-xvitals xchips">${wlVitalsEl(it)}</div>
    <div class="xsec-title">Exam history</div>
    <div class="hist"><div class="hist-muted">History opens in the full patient card.</div></div>
    <div class="xbtns">
      ${canReport ? `<button class="btn solid" onclick="openStudyViewer(this,'${jsAttr(mrn)}','${jsAttr(acc)}','${jsAttr(it.invPatTestResultId || '')}')" onmouseenter="studyPrefetch('${jsAttr(mrn)}','${jsAttr(acc)}','${jsAttr(it.invPatTestResultId || '')}')">${icon('file-text')}View report &amp; images</button>` : ''}
      <button class="btn" onclick="wlOpenPatientCard('${jsAttr(mrn)}')" onmouseenter="if(typeof psPrefetchLookup==='function')psPrefetchLookup('${jsAttr(mrn)}')" ontouchstart="if(typeof psPrefetchLookup==='function')psPrefetchLookup('${jsAttr(mrn)}')">${icon('user')}Full patient card</button>
      <button class="btn" onclick="wlStampIndication('${jsAttr(mrn)}',this)" title="Write this patient's clinical indication onto the DePACS study now">🖊 Stamp now</button>
      <button class="btn" onclick="wlFlagCritical('${jsAttr(mrn)}','${jsAttr(it.patientName || '')}','${jsAttr(it.exam || '')}','${jsAttr(acc)}',${it.genPatBillingId != null ? it.genPatBillingId : 'null'},${it.site != null ? "'" + jsAttr(String(it.site)) + "'" : 'null'},'${jsAttr(it.doctorName || '')}')">🚨 Flag critical</button>
      ${needConsent ? `<button class="btn" onclick="wlConsent('${jsAttr(mrn)}','${jsAttr(it.patientName || '')}','${jsAttr(it.exam || '')}','${jsAttr(it.doctorName || '')}','${jsAttr(it.branch || '')}','${jsAttr(it.billNo || '')}','${jsAttr(it.site || '')}')">${icon('id-card')}Send consent QR</button>` : ''}
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
  const canReport = single && it && (it.__status === 'completed' || it.__status === 'reported') && wlHasStudy(it);
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
function wlToggleRow(uid, e) {
  if (e) e.stopPropagation();
  if (wlState.openRows.has(uid)) { wlState.openRows.delete(uid); }
  else {
    wlState.openRows.add(uid);
    // Expanding a row = clear intent to open THIS patient. Warm the card lookup NOW (works
    // for any row, not just the prefetched top-10, and gives a head start before the tap
    // reaches "Full patient card"), so the card opens from cache instead of spinning.
    try {
      if (typeof psPrefetchLookup === 'function') {
        const items = (wlState.data && wlState.data.items) || [];
        const it = items.find((x) => wlRowUid(x) === uid);
        if (it && it.mrno) psPrefetchLookup(String(it.mrno));
      }
    } catch (_e) { /* prefetch is best-effort */ }
  }
  wlRender();
}
function wlToggleSel(mrn, e) { if (e) e.stopPropagation(); const k = String(mrn); if (wlState.selMrns.has(k)) wlState.selMrns.delete(k); else wlState.selMrns.add(k); wlRender(); }
function wlClearSel() { wlState.selMrns.clear(); wlRender(); }

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
function wlActReopen(gpb, mrno, site) {
  if (!confirm('Reopen this order? It returns to the active workflow.')) return;
  wlPostOrder(gpb, 'reopen', { mrno, site }, 'Order reopened');
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
  } else {
    b.push(`<button class="btn solid" onclick="wlActReopen(${g},'${mr}',${site})">${icon('refresh')}Reopen</button>`);
  }
  return b.join('');
}

function wlAge(h) { return h == null ? '' : (h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`); }

// A female patient needs a signed non-pregnancy consent BEFORE imaging. Detect
// female from the HIS gender and surface the consent state right on the row.
// Delegates to the shared isFemaleGender (util.js) so the board and patient card never drift.
function wlIsFemale(g) { return isFemaleGender(g); }
// Patient age in years from whatever the row carries (explicit age, else ageHours), or null.
function wlAgeYears(it) {
  if (it.age != null && String(it.age).trim() !== '') { const n = parseInt(it.age, 10); if (!isNaN(n)) return n; }
  if (it.ageHours != null && it.ageHours !== '') { const n = Number(it.ageHours); if (!isNaN(n)) return Math.floor(n / 8760); }
  return null;
}
// Non-pregnancy consent + β-hCG check are RADIATION-safety measures: they apply
// only to a female patient having an IONISING-radiation exam. Ultrasound (US)
// and MRI (MR) use no ionising radiation, so they never need either. An unknown
// modality is treated as radiation until enrichment resolves it — we never hide
// a safety prompt when unsure.
const WL_NONRAD_MODS = new Set(['US', 'MR']);
function wlNeedsRadSafety(it) {
  if (!wlIsFemale(it.gender)) return false;
  if (WL_NONRAD_MODS.has(wlRowMod(it))) return false;
  // Childbearing-age band: a paediatric or post-menopausal female needs neither the
  // non-pregnancy consent nor a β-hCG check. Unknown age stays safe-side (still prompt).
  const yrs = wlAgeYears(it);
  if (yrs != null && (yrs < 12 || yrs > 55)) return false;
  return true;
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
// Open the critical-result flag form pre-filled from a worklist row (criticalresults.js).
function wlFlagCritical(mrno, name, exam, acc, gpb, site, doctor) {
  if (typeof crFlagForm !== 'function') { toast('Critical Results module not loaded', 'err'); return; }
  crFlagForm({ mrno, patientName: name, exam, accession: acc, gpb: gpb, site: site, notifyTo: doctor });
}

// Arab (local) patients see their name in ARABIC on the consent; foreigners in English.
// Decide from the registered nationality + whether an Arabic name exists.
const WL_ARAB_NAT = /saudi|egypt|jordan|syria|yemen|sudan|emirat|kuwait|qatar|bahrain|oman|iraq|leban|palestin|libya|tunis|algeria|morocc|maurit|somal|djibouti|comoros|سعود|مصر|أردن|سوري|يمن/;
function wlPickConsentName(patient, fallbackEn) {
  const en = ((patient && patient.name) || fallbackEn || '').trim();
  const ar = ((patient && patient.nameArabic) || '').trim();
  const nat = ((patient && patient.nationality) || '').toLowerCase();
  const arScript = /[؀-ۿ]/.test(ar);
  // Arab if the Arabic name is real script AND nationality is Arab (or unknown = local default).
  const isArab = arScript && (!nat || WL_ARAB_NAT.test(nat));
  return { display: (isArab && ar) ? ar : (en || ar), en: en || ar };
}
async function wlConsent(mrno, name, exam, doctor, branch, bill, site) {
  // QR flow: her data is pre-printed on the official form, she scans the QR, signs
  // on HER OWN phone, and it reflects straight back (the board refreshes to ✓ Consent).
  // Keys must match the /consent/link backend: physician (not referring_doctor),
  // plus bill_no/site so the signed PDF auto-files against the right radiology order.
  // Fetch the patient's Arabic name + nationality so an Arab patient sees her name in
  // Arabic (name_en is kept for the Siratech filing name-match). Best-effort.
  let display = name, en = name, pat = {};
  try {
    const d = await API.get(`/radiology/lookup/${encodeURIComponent(mrno)}`);
    pat = (d && d.patient) || {};
    const picked = wlPickConsentName(pat, name);
    display = picked.display; en = picked.en;
  } catch (e) { /* keep the English board name */ }
  // Carry the identity + vitals the HIS already has (DOB, weight, height) so the form
  // prints COMPLETE — the worklist row alone doesn't have these, and without them the
  // signed PDF came out with blank patient fields.
  const prefill = { file_no: mrno, mrno: mrno, mrn: mrno, name: display, name_en: en, procedure: exam,
                    physician: doctor || '', branch: branch || '',
                    dob: (pat.dob || '').trim ? (pat.dob || '').trim() : (pat.dob || ''),
                    gender: pat.gender || '',
                    weight: (pat.weight != null ? String(pat.weight) : ''),
                    height: (pat.height != null ? String(pat.height) : ''),
                    patient_type: 'outpatient',   // radiology default → ticks the Outpatient box
                    bill_no: bill || '', site: (Number(site) || null) };
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
// While a patient card/modal is open, PAUSE the board's background enrichment pumps so
// the foreground card's live HIS fetches aren't starved on the single-core connector.
// Isolated, the card's sections load in ~2-3s; the board pump running alongside pushed
// that to ~7s. Resumed on card close.
let _wlCardOpen = false;
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
  while (_wlIndBusy < _WL_IND_MAX && _wlIndQueue.length && !_wlCardOpen) {
    const { mr } = _wlIndQueue.shift();
    if (wlState.indCache.has(mr) || _wlIndInflight.has(mr)) continue;
    _wlIndBusy++; _wlIndInflight.add(mr);
    // Board rows use the LIGHT lookup: RIS-panel enrichment (clinical indication + ER +
    // doctor name) but NOT the slow RadiologySearch (ordering-clinic name + referring-
    // doctor phone). That keeps the indication column while cutting ~3-4x the per-row HIS
    // work — the dominant board load. Clinic/phone still fill in when a row is expanded or
    // the full patient card is opened (those fire the full /radiology/lookup on demand).
    const _lk = API.get('/radiology/lookup-light/' + encodeURIComponent(mr));
    Promise.resolve(_lk)
      .then((lk) => { wlState.indCache.set(mr, wlIndexIndications(lk)); wlBackfillDetail(mr, lk); wlIndSet(mr); })
      .catch(() => { /* leave the shimmer; a later refresh retries */ })
      .finally(() => { _wlIndBusy--; _wlIndInflight.delete(mr); wlIndPump(); });
  }
}

// ── Vitals in the expanded order card (auto-loaded on expand) ──────────────────
// Mirrors the clinical-indication pattern: when a row is open, fetch the patient's
// vitals once (cached per MRN, throttled) and fill every matching cell in place —
// never a full re-render, so expanded rows don't collapse mid-fetch.
const _wlVitalsQueue = [];
const _wlVitalsInflight = new Set();
let _wlVitalsBusy = 0;
const _WL_VITALS_MAX = 3;
function wlVitalsChips(v) {
  if (!v) return '<span style="color:var(--muted);font-size:12px">No vitals on file</span>';
  const chip = (label, val, unit) => (val != null && String(val).trim() !== '')
    ? `<span class="xchip">${escapeHtml(label)} <b>${escapeHtml(String(val))}${unit || ''}</b></span>` : '';
  const bp = (v.systolic && v.diastolic)
    ? `<span class="xchip">BP <b>${escapeHtml(String(v.systolic))}/${escapeHtml(String(v.diastolic))}</b></span>` : '';
  const chips = [
    chip('Ht', v.height, v.height && Number(v.height) > 3 ? 'cm' : ''),
    chip('Wt', v.weight, 'kg'), chip('BMI', v.bmi, ''), bp,
    chip('Pulse', v.pulse, ''), chip('Temp', v.temperature, '°'), chip('SpO₂', v.spo2, '%'),
  ].filter(Boolean).join('');
  return chips || '<span style="color:var(--muted);font-size:12px">No vitals on file</span>';
}
function wlVitalsEl(it) {
  const mr = String(it.mrno || '');
  if (!mr) return '';
  const attr = ` class="wl-vitalscell" data-mr="${escapeHtml(mr)}"`;
  if (wlState.vitalsCache.has(mr)) return `<div${attr}>${wlVitalsChips(wlState.vitalsCache.get(mr))}</div>`;
  return `<div${attr}><span class="wl-shimmer" style="width:180px"></span></div>`;
}
function wlVitalsSet(mr) {
  const sel = '.wl-vitalscell[data-mr="' + String(mr).replace(/["\\]/g, '\\$&') + '"]';
  document.querySelectorAll(sel).forEach((el) => { el.innerHTML = wlVitalsChips(wlState.vitalsCache.get(mr)); });
}
function wlAutoVitals() {
  const items = (wlState.data && wlState.data.items) || [];
  const seen = new Set(_wlVitalsQueue.map((x) => x.mr));
  for (const it of items) {
    if (!wlState.openRows.has(wlRowUid(it))) continue;   // only expanded rows
    const mr = String(it.mrno || '');
    if (!mr || wlState.vitalsCache.has(mr) || seen.has(mr) || _wlVitalsInflight.has(mr)) continue;
    seen.add(mr);
    _wlVitalsQueue.push({ mr });
  }
  wlVitalsPump();
}
function wlVitalsPump() {
  while (_wlVitalsBusy < _WL_VITALS_MAX && _wlVitalsQueue.length && !_wlCardOpen) {
    const { mr } = _wlVitalsQueue.shift();
    if (wlState.vitalsCache.has(mr) || _wlVitalsInflight.has(mr)) continue;
    _wlVitalsBusy++; _wlVitalsInflight.add(mr);
    API.get('/radiology/patient/' + encodeURIComponent(mr) + '/clinical')
      .then((d) => { wlState.vitalsCache.set(mr, (d && d.vitals) || null); wlVitalsSet(mr); })
      .catch(() => { /* leave the shimmer; a later expand retries */ })
      .finally(() => { _wlVitalsBusy--; _wlVitalsInflight.delete(mr); wlVitalsPump(); });
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
  // Force English formatting (en-GB) — the default device locale rendered the month/AM-PM
  // and digits in Arabic ("يوليو، 06:35 م") on an Arabic phone. The board stays English.
  return d.toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
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
// Restore the detail the fast RIS board can't carry (clinic + referring-doctor phone per bill,
// age/gender per patient) from the patient lookup, cache it, and paint it onto the matching
// rows. Cached so it survives the next fast poll (which replaces wlState.data) — wlHydrate
// re-applies it. Fires when a row's lookup lands (expand / prefetch).
function wlBackfillDetail(mr, lk) {
  const orders = (lk && lk.orders) || [];
  let changed = false;
  for (const o of orders) {
    const bn = String(o.billNo || '').trim();
    if (!bn || (!o.department && !o.doctorPhone)) continue;
    const cur = wlState.orderDetail.get(bn) || {};
    const next = { department: o.department || cur.department || null, doctorPhone: o.doctorPhone || cur.doctorPhone || null };
    if (next.department !== cur.department || next.doctorPhone !== cur.doctorPhone) { wlState.orderDetail.set(bn, next); changed = true; }
  }
  const p = lk && lk.patient;
  if (p && (p.age != null || p.gender)) {
    const key = String(mr || '').trim();
    const cur = wlState.cardDetail.get(key) || {};
    if (cur.age !== p.age || cur.gender !== p.gender) { wlState.cardDetail.set(key, { age: p.age != null ? p.age : cur.age, gender: p.gender || cur.gender }); changed = true; }
  }
  if (changed) {
    wlApplyDetail();
    // Debounced repaint — a warm-up sweep backfills many rows in quick succession, so coalesce
    // into one render instead of repainting per row.
    clearTimeout(_wlDetailRenderT);
    _wlDetailRenderT = setTimeout(() => { if (document.getElementById('wl-body')) wlRender(); }, 120);
  }
}
let _wlDetailRenderT = null;
// Copy the cached clinic/phone/age/gender onto the rows currently in hand. Idempotent — a row
// only gains detail, never loses it — so it's safe to call on every hydrate/backfill.
function wlApplyDetail() {
  const items = (wlState.data && wlState.data.items) || [];
  for (const it of items) {
    const bn = String(it.billNo || '').trim();
    const od = bn ? wlState.orderDetail.get(bn) : null;
    if (od) { if (od.department && !it.department) it.department = od.department; if (od.doctorPhone && !it.doctorPhone) it.doctorPhone = od.doctorPhone; }
    const cd = wlState.cardDetail.get(String(it.mrno || '').trim());
    if (cd) { if (cd.age != null && (it.age == null || it.age === '')) it.age = cd.age; if (cd.gender && !it.gender) it.gender = cd.gender; }
  }
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
      padding:24px 14px;overflow:auto;animation:wlpcFade .18s ease;transition:opacity .16s ease}
    .wl-pcard-ov.closing{opacity:0}
    @keyframes wlpcFade{from{opacity:0}to{opacity:1}}
    .wl-pcard-sheet{width:100%;max-width:660px;background:var(--bg,#f4f2fc);border-radius:18px;
      box-shadow:0 24px 70px rgba(20,17,40,.4);overflow:hidden;margin:auto 0;
      animation:wlpcSheetIn .3s cubic-bezier(.16,1,.3,1) both;
      transition:transform .16s ease,opacity .16s ease}
    .wl-pcard-ov.closing .wl-pcard-sheet{transform:translateY(8px) scale(.985);opacity:0}
    @keyframes wlpcSheetIn{from{opacity:0;transform:translateY(16px) scale(.97)}to{opacity:1;transform:none}}
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
// Manual "Stamp now": write THIS patient's clinical indication onto their DePACS study
// immediately (same matcher/safety as the background auto-stamp). Auto keeps running.
async function wlStampIndication(mrno, btn) {
  mrno = String(mrno || '').trim();
  if (!mrno) return;
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Stamping…'; }
  try {
    const d = await API.post(`/radiology/patient/${encodeURIComponent(mrno)}/autostamp`, {});
    const n = d && d.stamped || 0;
    toast(n ? `Stamped ${n} stud${n === 1 ? 'y' : 'ies'}` : 'Nothing to stamp (already stamped, or no fresh study matched)');
  } catch (e) {
    toast(e.message || 'Stamp failed', 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label || '🖊 Stamp now'; }
  }
}

async function wlOpenPatientCard(mrno) {
  mrno = String(mrno || '').trim();
  if (!mrno || typeof renderPsDetail !== 'function') return;
  _wlCardOpen = true;   // pause the board's background enrichment so the card isn't starved
  wlEnsurePcardStyles();
  let ov = document.getElementById('wl-pcard');
  if (!ov) { ov = document.createElement('div'); ov.id = 'wl-pcard'; document.body.appendChild(ov); }
  // Reopened while a previous close was mid-exit? Cancel that pending removal and clear the
  // closing state so the fresh card can't be wiped by the old exit timer.
  if (ov._closeTimer) { clearTimeout(ov._closeTimer); ov._closeTimer = null; }
  ov._closing = false;
  ov.className = 'wl-pcard-ov';
  ov.dataset.mrno = mrno;   // identity stamp: a slower lookup for a PREVIOUS patient must not paint here
  ov.onclick = (e) => { if (e.target === ov) wlClosePatientCard(); };
  // If this patient was prefetched (board warm-up or hover), paint instantly — no spinner.
  const warm = (typeof psLookupCache !== 'undefined') ? psLookupCache.get(mrno) : null;
  const isWarm = warm && Date.now() - warm.ts < 90000;
  // Not warm yet? Don't show a bare spinner — we already KNOW this patient (name/MRN/age are
  // on the worklist row), so paint their identity + a shimmer skeleton immediately. The card
  // reads as "here, filling in" instead of "loading nothing"; renderPsDetail swaps in the
  // full card the instant the lookup lands.
  let placeholder = (typeof LOADING_HTML !== 'undefined') ? LOADING_HTML : '<div class="card" style="padding:26px;text-align:center">Loading…</div>';
  if (!isWarm) {
    const row = (((wlState && wlState.data && wlState.data.items) || []).find((x) => String(x.mrno) === mrno)) || {};
    const nm = (row.patientName || '').trim();
    if (nm) {
      const sub = [row.mrno ? 'MRN ' + row.mrno : '', row.age || '', row.gender || ''].filter(Boolean).join(' · ');
      const skel = (typeof skeletonList === 'function') ? skeletonList(4) : '';
      placeholder = `<div class="card" style="padding:16px 16px 18px">
        <div style="font-weight:800;font-size:17px;color:var(--text)">${escapeHtml(nm)}</div>
        <div style="color:var(--muted);font-size:13px;margin-top:3px">${escapeHtml(sub)}</div>
        <div style="margin-top:14px">${skel}</div></div>`;
    }
  }
  ov.innerHTML = `<div class="wl-pcard-sheet">
    <div class="wl-pcard-head"><b>Patient card</b><button class="wl-pcard-x" title="Close" onclick="wlClosePatientCard()">✕</button></div>
    <div class="wl-pcard-body"><div id="ps-detail">${isWarm ? '' : placeholder}</div></div>
  </div>`;
  document.body.style.overflow = 'hidden';
  if (!window._wlPcardEsc) {
    window._wlPcardEsc = (e) => { if (e.key === 'Escape') wlClosePatientCard(); };
    document.addEventListener('keydown', window._wlPcardEsc);
  }
  try {
    // Warm (already enriched in cache) → paint the full card. Otherwise fetch the FAST
    // base card (~0.5s) so the modal fills in immediately; renderPsDetail then shows the
    // "Load full details" button for the on-demand enrichment (same as the lookup page),
    // instead of blocking this modal on the ~100-call full lookup.
    const d = isWarm ? warm.data
      : (typeof psFetchLookupFast === 'function' ? await psFetchLookupFast(mrno)
        : (typeof psPrefetchLookup === 'function' ? await psPrefetchLookup(mrno)
          : await API.get(`/radiology/lookup/${encodeURIComponent(mrno)}`)));
    const _cur = document.getElementById('wl-pcard');
    if (!_cur || _cur.dataset.mrno !== mrno) return;                  // closed, or a newer patient was opened
    if (typeof psNoteCache !== 'undefined') { try { psNoteCache = new Map(); psReportStore = {}; } catch (e) {} }
    const pat = (d.patient && d.patient.mrno) ? d.patient : { ...(d.patient || {}), mrno };
    psState.lookup = { ...d, patient: pat };
    renderPsDetail();
  } catch (e) {
    const _cur = document.getElementById('wl-pcard');
    if (!_cur || _cur.dataset.mrno !== mrno) return;                  // a newer patient owns the card now
    const b = document.querySelector('#wl-pcard #ps-detail');
    if (b) b.innerHTML = `<div class="card"><div class="empty" style="padding:22px 16px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(e.message || 'Could not load the patient')}</p></div></div>`;
  }
}
function wlClosePatientCard() {
  const ov = document.getElementById('wl-pcard');
  document.body.style.overflow = '';
  _wlCardOpen = false;   // resume the board's background enrichment
  try { wlIndPump(); wlVitalsPump(); } catch (e) {}
  if (window._wlPcardEsc) { document.removeEventListener('keydown', window._wlPcardEsc); window._wlPcardEsc = null; }
  if (!ov) return;
  // Play the exit (fade + settle) before removing, instead of a hard snap-out. Guard
  // against a double-close and honour reduced-motion (remove immediately).
  if (ov._closing) return;
  ov._closing = true;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { ov.remove(); return; }
  ov.classList.add('closing');
  ov._closeTimer = setTimeout(() => { try { ov.remove(); } catch (e) {} }, 180);
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
  wlState._lastBodyHtml = null;   // cross-branch match view — next full-board render must repaint
}
