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
                // Modality is the only board filter now — the phase strip HIGHLIGHTS
                // + scrolls (bug #1), it never hides a patient. `phaseHi` is the currently
                // highlighted phase (or null).
                modFilter: null, phaseHi: null,
                // Live-pill + watchdog bookkeeping (bug #3): the timestamp of the last
                // good load, a "reconnecting" flag, and a monotonic load generation so a
                // hung request that the watchdog gave up on can never paint stale data.
                lastGood: 0, reconnecting: false, _loadGen: 0,
                // Bucket-per-order from the previous render → transient "moved from …" tag.
                prevPhase: new Map(), movedTags: new Map() };

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
  wlState.phaseHi = null;                              // no phase highlighted on entry
  wlState.reconnecting = false; wlState.lastGood = Date.now();
  wlState.from = wlTodayLocal(); wlState.to = wlTodayLocal();   // default: today only
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
    <div class="cc wl2">
      <div class="top">
        <div class="brand">
          <img class="wl-logo" src="/meena_logo.png" alt="Meena">
          <div>
            <h1>Meena RIS · Worklist</h1>
            <div class="sub">${branch ? escapeHtml(String(branch)) + ' · ' : ''}${escapeHtml(dateStr)}</div>
          </div>
        </div>
        <span class="live" id="wl-live"><i></i>Live · updated 0s ago</span>
        <div class="spacer"></div>
        <label class="search">
          ${icon('search')}
          <input id="wl-search" placeholder="Search patient, MRN, or accession" autocomplete="off"
                 oninput="wlLiveFilter(this.value)" onkeydown="if(event.key==='Enter')wlSearch(this.value)">
        </label>
        <button class="tbtn today" id="wl-today-btn" onclick="wlTodayRange()">Today</button>
        <button class="tbtn" onclick="wlToggleDate()">${icon('calendar')}Date</button>
        <select id="wl-branch" class="tbtn wl-branchsel" onchange="wlOnBranch()">
          <option value="">All branches</option>
        </select>
        <button class="tbtn icon" title="Refresh now" onclick="wlLoad(true)">${icon('refresh')}</button>
      </div>
      <div class="datepop" id="wl-datepop" style="display:none">
        <button class="tbtn icon" onclick="wlShiftDay(-1)" title="Previous day">‹</button>
        <span class="dl">From</span>
        <input type="date" id="wl-from" value="${wlState.from}" onchange="wlSetFrom(this.value)" title="From date">
        <span class="dl">To</span>
        <input type="date" id="wl-to" value="${wlState.to}" onchange="wlSetTo(this.value)" title="To date">
        <button class="tbtn icon" onclick="wlShiftDay(1)" title="Next day">›</button>
      </div>
      <div id="wl-body"></div>
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
    // Lanes are driven by the NATIVE Siratech status (it.hisStatus) via wlLane(), which
    // the connector stamps on the fast pass — so rows land in the right lane on the FIRST
    // paint with no DePACS wait (this is what removed the old "everyone sits in Waiting
    // then jumps" glitch). No stage-withholding needed.
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
function wlStageBadge(stage) {
  if (stage === 'reported') return '<span class="badge badge-green" title="Report signed — auto-file will file it, then it leaves the board">Report ready</span>';
  if (stage === 'draft')    return '<span class="badge" style="background:#7c5cff;color:#fff" title="A report exists but is NOT verified yet — radiologist mid-report">Not verified</span>';
  if (stage === 'imaged')   return '<span class="badge badge-orange" title="Images are in DePACS — nothing written yet">Imaged</span>';
  if (stage === 'ordered')  return '<span class="badge" title="Ordered — images not in DePACS yet">Ordered</span>';
  return '<span class="badge" style="opacity:.55">…</span>';
}

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
// The five workflow phases shown on the strip. Finer than the coarse RIS bucket
// (To scan splits into scheduled/arrived; In progress is the on-table state).
const _WL_PHASES = [
  { key: 'toscan',     label: 'To scan',     dot: 'var(--slate)' },
  { key: 'inprogress', label: 'In progress', dot: 'var(--amber)' },
  { key: 'imaged',     label: 'Imaged',      dot: 'var(--green)' },
  { key: 'reporting',  label: 'Reporting',   dot: 'var(--blue)' },
  { key: 'final',      label: 'Final',       dot: 'var(--green-ink)' },
];
const _WL_PHASE_RANK = { toscan: 0, inprogress: 1, imaged: 2, reporting: 3, final: 4 };
function wlPhaseLabel(k) { const p = _WL_PHASES.find((x) => x.key === k); return p ? p.label : k; }
// A row's workflow phase, derived from its RIS status state.
function wlPhase(it) {
  const s = (it.__ris || wlRisStatus(it)).state;
  if (s === 'progress') return 'inprogress';
  if (s === 'completed') return 'imaged';
  if (s === 'prelim') return 'reporting';
  if (s === 'final') return 'final';
  return 'toscan';   // scheduled / arrived
}
// BUG #1: clicking a phase HIGHLIGHTS it + scrolls to its first row — it never hides
// any patient. Clicking the active phase again clears the highlight.
function wlPhaseJump(key) {
  wlState.phaseHi = (wlState.phaseHi === key) ? null : key;
  wlRender();
  if (wlState.phaseHi) {
    const target = wlState.phaseHi;
    setTimeout(() => {
      const el = document.querySelector('.wl2 .row[data-phase="' + target + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 40);
  }
}
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
  // Classify every row once: RIS status, coarse bucket, and the finer workflow phase.
  // `scanned` = Siratech recorded an exam start/end (a hard fact) → imaged, even before
  // the DePACS pass and regardless of the demoted preliminary stage text.
  for (const it of items) { it.__ris = wlRisStatus(it); it.__bucket = it.__ris.bucket; it.__phase = wlPhase(it); }
  const counts = { toscan: 0, inprogress: 0, imaged: 0, reporting: 0, final: 0 };
  for (const it of items) counts[it.__phase] = (counts[it.__phase] || 0) + 1;

  // BUG #1: a row that ADVANCES a phase between renders gets a transient "moved from …"
  // tag (~8s) so the promotion is visible in place — the patient never vanishes.
  const _now = Date.now();
  for (const it of items) {
    const rk = wlRowKey(it); if (!rk) continue;
    const cur = it.__phase, prev = wlState.prevPhase.get(rk);
    if (prev !== undefined && prev !== cur && _WL_PHASE_RANK[cur] > _WL_PHASE_RANK[prev])
      wlState.movedTags.set(rk, { from: wlPhaseLabel(prev), at: _now });
    wlState.prevPhase.set(rk, cur);
  }
  // Drop expired "moved from …" tags so the Map can't grow across a long shift.
  for (const [k, v] of wlState.movedTags) if (_now - v.at > 8000) wlState.movedTags.delete(k);

  const body = document.getElementById('wl-body');
  if (!body) return;
  // A cross-branch search result view is showing — don't let a live refresh clobber it.
  if (wlState.searchView) return;
  // Entrance animation fires ONCE per visit. Every later repaint (45s poll, enrich
  // merge, chip/phase switch) recreates the board nodes, which would replay the row
  // stagger as a visible flicker — the .cc-still class pins those repaints.
  const ccRoot = document.querySelector('#content > .cc');
  if (ccRoot) { ccRoot.classList.toggle('cc-still', !!wlState._paintedOnce); wlState._paintedOnce = true; }
  // Live typeahead: as the operator types digits, filter the board to the MRNs that
  // START WITH what's typed (prefix), so the patient narrows down live — no need to
  // type the whole number or press Enter.
  if (wlState.filter) {
    const f = wlState.filter;
    const match = items.filter((it) => String(it.mrno || '').replace(/\D/g, '').startsWith(f));
    const banner = `<div class="wl-filterbar"><span>${match.length} on this board starting with "${escapeHtml(f)}"</span>
      <button class="tbtn" onclick="wlClearFilter()">← Back to full board</button></div>`;
    body.innerHTML = banner + (match.length
      ? wlTable(match)
      : `<div class="empty" style="padding:20px"><p>No patient on this board starts with "${escapeHtml(f)}".${f.length >= 6 ? ' Press Enter to search all branches.' : ''}</p></div>`);
    wlAutoPreg(); wlAutoIndication();
    return;
  }
  if (!items.length) { body.innerHTML = `<div class="empty" style="padding:26px"><p>No orders awaiting a result.</p></div>`; return; }

  // ── Modality filter chips (only modalities actually present) ────────────────
  const modCounts = {};
  for (const it of items) { const m = wlRowMod(it); if (m) modCounts[m] = (modCounts[m] || 0) + 1; }
  const present = new Set(Object.keys(modCounts));
  // If the active modality filter is no longer on the board (its rows all filed/dropped),
  // auto-clear it — otherwise the chip bar strands the board empty with no way to reset.
  if (wlState.modFilter && !present.has(wlState.modFilter)) wlState.modFilter = null;
  const MOD_ORDER = [['CT', 'CT'], ['MR', 'MRI'], ['US', 'US'], ['XR', 'X-Ray'], ['MG', 'Mammo']];
  const MOD_DOT = { CT: '#6B4EFF', MR: '#3BA0FF', US: '#00C896', XR: '#8358FD', MG: '#E4739B' };
  const modChips = present.size > 1 ? `<div class="mods">
      <span class="lbl">Modality</span>
      <button class="chip${!wlState.modFilter ? ' on' : ''}" onclick="wlSetMod('')">All</button>
      ${MOD_ORDER.filter(([k]) => present.has(k)).map(([k, lbl]) =>
        `<button class="chip${wlState.modFilter === k ? ' on' : ''}" onclick="wlSetMod('${k}')"><span class="dot" style="background:${MOD_DOT[k]}"></span>${lbl}<span class="c">${modCounts[k] || 0}</span></button>`).join('')}
    </div>` : '';

  // Modality is the only filter (a real, logical narrowing). Nobody is hidden by status.
  let rows = items;
  if (wlState.modFilter) rows = rows.filter((it) => wlRowMod(it) === wlState.modFilter);

  // ── Split into FOUR clear stage lanes driven by Siratech's OWN status
  //    (cpoeStatusDescription: Pending / Scan In Progress / Scan Done) + the native
  //    report flag — every patient sits under exactly one lane and moves to the next
  //    the moment its HIS status updates (live 45s refresh). Counts live in the headers.
  //      في الانتظار (waiting) · قيد التصوير (imaging) · تم التصوير (imaged) · تم التقرير (reported)
  wlState.collapsedSections = wlState.collapsedSections || new Set();   // all lanes open by default
  const grp = { waiting: [], imaging: [], imaged: [], reported: [] };
  for (const it of rows) grp[wlLane(it)].push(it);
  if (!rows.length) {
    body.innerHTML = modChips + `<div class="empty" style="padding:22px"><p>Nothing matches this modality.</p></div>`;
  } else {
    body.innerHTML = modChips
      + wlSection('waiting', 'Waiting', grp.waiting, 'w', 'var(--muted,#98a2b3)')
      + wlSection('imaging', 'In imaging', grp.imaging, 'g', 'var(--blue,#3BA0FF)')
      + wlSection('imaged', 'Imaged', grp.imaged, 'i', 'var(--yellow,#FFBA49)')
      + wlSection('reported', 'Reported', grp.reported, 'r', 'var(--green,#00C896)');
  }
  wlRestoreOpenState();   // a live refresh must not collapse drills the operator opened
  wlAutoPreg();           // auto-check pregnancy status for female rows (throttled, cached)
  wlAutoIndication();     // auto-fetch the clinical indication for waiting/in-progress rows
}

// One collapsible board section. Rows sort STAT→newest within the section. The done
// sections (imaged/reported) dim their rows via `.done`. Collapse state persists in
// wlState.collapsedSections across every repaint (poll, enrich, modality switch).
function wlSection(key, title, secRows, prefix, color) {
  const n = secRows.length;
  const collapsed = wlState.collapsedSections.has(key);
  const sorted = secRows.slice().sort((a, b) =>
    (Number(b.emergency) - Number(a.emergency)) || ((a.ageHours || 0) - (b.ageHours || 0)));
  const inner = collapsed ? ''
    : (n ? `<div class="board"><div class="rows">${sorted.map((it, i) => wlRow(it, prefix + i)).join('')}</div></div>`
         : `<div class="wl-sec-empty">No studies in this stage right now.</div>`);
  const dot = color ? ` style="background:${color}"` : '';
  const bar = color ? `box-shadow:inset 3px 0 0 ${color};` : '';
  return `<div class="wl-sec sec-${key}${collapsed ? ' collapsed' : ''}" data-sec="${key}" style="${bar}">
    <button class="wl-sec-h" onclick="wlToggleSection('${key}')">
      <span class="wl-sec-dot"${dot}></span>
      <span class="wl-sec-t">${title}</span>
      <span class="wl-sec-n">${n}</span>
      <span class="wl-sec-chev">${collapsed ? '›' : '⌄'}</span>
    </button>${inner}</div>`;
}

// Native Siratech workflow lane for the board. Driven by the HIS's own status text
// (hisStatus = cpoeStatusDescription: Pending / Scan In Progress / Scan Done) and its
// native report flag (hisReported), with safe fallbacks to the exam timestamps and
// the DePACS-grounded stage for rows the RIS panel hasn't stamped yet. One of:
//   waiting · imaging · imaged · reported
function wlLane(it) {
  const s = String(it.hisStatus || '').toLowerCase();
  if (it.hisReported || it.stage === 'reported' || it.readyToFile) return 'reported';
  if (/scan\s*done|complet|\bdone\b|acquir|imaged/.test(s) || it.scanned || it.stage === 'imaged' || it.examEndAt) return 'imaged';
  if (/in\s*progress|scanning|ongoing|started|arrived/.test(s) || it.examStartAt) return 'imaging';
  return 'waiting';   // Pending / Ordered / Scheduled
}

// The native Siratech status pill (the HIS's OWN cpoeStatusDescription text, e.g.
// "Scan Done" / "Scan In Progress" / "Pending"), coloured by its lane. Empty until
// the RIS-panel enrichment stamps the row — the derived badge shows meanwhile.
function wlHisBadge(it) {
  if (!it.hisStatus) return '';
  const lane = wlLane(it);
  const color = lane === 'reported' ? 'var(--green,#00C896)'
    : lane === 'imaged' ? 'var(--yellow,#FFBA49)'
      : lane === 'imaging' ? 'var(--blue,#3BA0FF)' : 'var(--muted,#98a2b3)';
  return `<span class="ris" title="Live status from Siratech"
     style="background:transparent;border:1px solid ${color};color:${color}">
     <span class="rd" style="background:${color}"></span>${escapeHtml(String(it.hisStatus))}</span>`;
}
function wlToggleSection(key) {
  wlState.collapsedSections = wlState.collapsedSections || new Set();
  if (wlState.collapsedSections.has(key)) wlState.collapsedSections.delete(key);
  else wlState.collapsedSections.add(key);
  wlRender();
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

// RIS worklist table. Sort: STAT / emergency pinned to the very top, then by workflow
// phase (to-scan → reported), then NEWEST first within a phase (freshest order on top —
// the operator's chosen order).
function wlTable(items, prefix) {
  const p = prefix || 'a';   // namespace row ids — several tables coexist
  const border = { waiting: 0, imaged: 1, reporting: 2, reported: 3 };
  const bk = (it) => border[it.__bucket != null ? it.__bucket : wlRisStatus(it).bucket] ?? 0;
  const rows = items.slice().sort((a, b) =>
    (Number(b.emergency) - Number(a.emergency))     // STAT / emergency always on top
    || (bk(a) - bk(b))                              // then by workflow phase (to-scan → reported)
    || ((a.ageHours || 0) - (b.ageHours || 0)));    // then NEWEST first (freshest order on top)
  return `<div class="board">
    <div class="bhead"><div>Patient &amp; indication</div><div>Exam</div><div>Ordered</div><div>RIS status</div><div class="r">Actions</div></div>
    <div class="rows">${rows.map((it, i) => wlRow(it, p + i)).join('')}</div>
  </div>`;
}

function wlAge(h) { return h == null ? '' : (h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`); }

// Friendly labels + colour per imaging modality so the board reads at a glance.
const WL_MOD = {
  CT: { label: 'CT', cls: 'ct' }, MR: { label: 'MRI', cls: 'mri' },
  US: { label: 'US', cls: 'us' }, XR: { label: 'X-Ray', cls: 'xr' },
  MG: { label: 'Mammo', cls: 'mm' },
};
function wlModBadges(modality) {
  if (!modality) return '';
  return String(modality).split(',').map((m) => {
    const k = m.trim().toUpperCase(), info = WL_MOD[k];
    if (!info) return `<span class="mod">${escapeHtml(k)}</span>`;
    return `<span class="mod ${info.cls}">${escapeHtml(info.label)}</span>`;
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
  if (it.consentOnFile) return '<span class="sc ok" title="Non-pregnancy consent signed">✓ Consent</span>';
  return `<button class="sc no" title="Sign the non-pregnancy consent before imaging" onclick="wlConsent('${jsAttr(it.mrno)}','${jsAttr(it.patientName || '')}','${jsAttr(it.exam || '')}','${jsAttr(it.doctorName || '')}','${jsAttr(it.branch || '')}')">⚠ Consent needed</button>`;
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
    if (!wlIsFemale(it.gender)) continue;
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
async function wlPregCheck(mrno, site, id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'checking…'; }
  try {
    const qs = new URLSearchParams({ mrno }); if (site) qs.set('site', String(site));
    const r = await API.get('/radiology/labs/pregnancy?' + qs.toString());
    wlState.pregCache.set(String(mrno), r);
    const el = document.getElementById(id);
    if (el) el.innerHTML = wlPregBadge(r);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Preg check'; }
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
  // Imaged-from-preliminary-only rows show a subtle pulsing dot ("confirming with PACS")
  // that clears in place the moment the DePACS ready pass sets it.stage — no row moves.
  const confirming = s.pending ? ' confirming' : '';
  const title = s.pending ? ' title="Imaged per HIS — confirming with PACS…"' : '';
  return `<span class="ris ${s.state}${confirming}"${title}><span class="rd"></span>${escapeHtml(s.label)}</span>`;
}
// Inline Feather SVGs for the few glyphs not in util.js's icon() map (link chain,
// send/handoff). Sized by the .wl2 scope like the shared .mi-ico icons.
const WL_SVG = {
  link: '<svg class="mi-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
  send: '<svg class="mi-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
};

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
  for (const it of items) {
    const b = it.__bucket || wlRisStatus(it).bucket;
    if (b === 'imaged' || b === 'reported') continue;   // done rows → skip (limit HIS load)
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
// Siratech report + images directly via odOpenStudy.)

function wlRow(it, key) {
  // Drill identity must be STABLE per order, NOT the row's position — otherwise a live
  // refresh that re-sorts the board (a new STAT order jumps to top) would re-open the
  // drill onto a DIFFERENT patient's row and show the previous patient's cached report.
  // Use the per-order key; fall back to the positional key only for keyless rows.
  const dkey = 'k' + String(wlRowKey(it) || key).replace(/[^A-Za-z0-9_-]/g, '');
  const rk = wlRowKey(it);
  const phase = it.__phase || wlPhase(it);
  const bucket = it.__bucket || wlRisStatus(it).bucket;
  const done = (bucket === 'imaged' || bucket === 'reported');   // dimmed, but STAYS (bug #1)
  const hl = wlState.phaseHi && phase === wlState.phaseHi;
  const age = wlAge(it.ageHours);
  // While the background HIS enrichment is still running, show a loading shimmer for
  // the exam instead of a bare "—" so the board reads as "loading", not broken.
  const p = wlState.enriching;
  const dash = '<span style="color:var(--ink-3)">—</span>';
  const acc = it.accession || it.accessionNumber || null;
  const demo = [it.age, (it.gender ? String(it.gender).charAt(0).toUpperCase() : '')].filter(Boolean).map((x) => escapeHtml(String(x))).join(' ');
  const ordered = it.orderedDate ? wlTrackFmt(it.orderedDate) : '';
  const consent = wlConsentEl(it), preg = wlPregEl(it);
  const proc = it.exam ? `<span class="proc">${escapeHtml(it.exam)}</span>`
    : (p ? `<span class="wl-shimmer" style="width:90px"></span>` : dash);
  // Transient "moved from …" tag (~8s) — bug #1.
  const mv = rk && wlState.movedTags.get(rk);
  const moved = (mv && (Date.now() - mv.at < 8000))
    ? `<div class="movedtag">${icon('check')}moved from “${escapeHtml(mv.from)}” just now</div>` : '';
  // Second action: native Siratech report + images (report text + cloud viewer) for
  // imaged-or-later rows; otherwise Handoff. Everything from Siratech, no DePACS.
  const secondBtn = (done || bucket === 'reporting' || wlLane(it) === 'imaged' || wlLane(it) === 'reported')
    ? `<button class="btn ghost" onclick="odOpenStudy(this,'${jsAttr(it.mrno)}','${jsAttr(acc || '')}','${jsAttr(it.invPatTestResultId || '')}')">${icon('file-text')}Report / Images</button>`
    : `<button class="btn ghost" onclick="wlOpenHandoff('${jsAttr(it.mrno)}')">${WL_SVG.send}Handoff</button>`;
  // Row-level one-click indication write — only where it matters: images are in PACS but
  // the report isn't filed yet. Hidden for waiting (no study) and reported/done (moot).
  const indBtn = (bucket === 'imaged')
    ? `<button class="btn ghost" title="Write indication to PACS" onclick="wlRowWriteIndication('${dkey}','${jsAttr(it.mrno)}',${Number(it.site) || 0},this)">${icon('edit')}Indication</button>`
    : '';
  const openLbl = bucket === 'reported' ? 'View ›' : 'Open ›';
  return `<div class="rowwrap">
    <div class="row${it.emergency ? ' stat' : ''}${done ? ' done' : ''}${hl ? ' hl' : ''}" data-phase="${phase}">
      <div class="pt">
        <div class="pname">${escapeHtml(it.patientName || '—')}${it.emergency ? ' <span class="stat-b"><i></i>STAT</span>' : ''}</div>
        <div class="pmeta">${escapeHtml(it.mrno || '')}${demo ? '<i></i>' + demo : ''}${it.branch ? '<i></i>' + escapeHtml(it.branch) : ''}${it.doctorName ? '<i></i><span class="dr">Dr ' + escapeHtml(it.doctorName) + '</span>' : ''}</div>
        ${wlIndEl(it)}
        ${(consent || preg) ? '<div class="safe">' + consent + preg + '</div>' : ''}
      </div>
      <div class="exam">
        <div class="exline">${wlModBadges(it.modality)}${proc}</div>
        ${acc ? `<span class="acc" title="DICOM accession">${WL_SVG.link}${escapeHtml(String(acc))}</span>` : ''}
      </div>
      <div class="when"><div class="big tnum">${wlTimeOnly(it.orderedDate)}</div>${(age && !done && bucket !== 'reported') ? '<div class="sm wait tnum">waiting ' + age + '</div>' : '<div class="sm tnum">' + (ordered ? escapeHtml(ordered) : '') + '</div>'}</div>
      <div>${wlHisBadge(it) || wlRisStatusBadge(it)}${moved}</div>
      <div class="acts">
        <button class="btn ${it.emergency ? 'solid' : 'primary'}" id="wl-open-${dkey}" onclick="wlToggle('${dkey}','${jsAttr(it.mrno)}',${Number(it.site) || 0},this)">${openLbl}</button>
        ${secondBtn}
        ${indBtn}
      </div>
    </div>
    <div class="rdetail" id="wl-dr-${dkey}" style="display:none"><div id="wl-d-${dkey}"></div></div>
  </div>`;
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
// HH:MM for the board's "Ordered" column; falls back to the raw-ish string when the
// timestamp doesn't parse.
function wlTimeOnly(s) {
  const t = wlParseTs(s);
  if (t) return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return s ? wlTrackFmt(s) : '';
}
// (Patient-journey stepper removed — this HIS never records arrival/exam times, so it
// only ever rendered the dead "arrival & exam times not recorded yet" state. The native
// stage lanes convey where each study is.)

// Read-only drill: expand a detail row that matches the finished DePACS report(s) to
// this patient's order(s).
async function wlToggle(key, mrno, site, btn) {
  const row = document.getElementById('wl-dr-' + key), box = document.getElementById('wl-d-' + key);
  if (!row || !box) return;
  if (row.style.display !== 'none') { row.style.display = 'none'; btn.textContent = btn.dataset.lbl || 'Open ›'; wlState.openDrills.delete(key); return; }
  if (!btn.dataset.lbl) btn.dataset.lbl = btn.textContent;   // remember "Open ›"/"View ›" to restore on close
  row.style.display = ''; btn.textContent = 'Hide'; box.innerHTML = LOADING_HTML;
  wlState.openDrills.add(key);
  wlState.drillHtml = wlState.drillHtml || new Map();
  // Re-entrancy guard: the match call is heavy (DePACS lookup); a second click while
  // it's in flight must not fire a duplicate request.
  wlState._drillLoading = wlState._drillLoading || new Set();
  if (wlState._drillLoading.has(key)) return;
  wlState._drillLoading.add(key);
  try {
    // Fetch the report match AND the order detail (which carries the clinical indication,
    // reason and remarks — the /match payload doesn't) in parallel. The lookup is
    // best-effort: if it fails, the drill still shows the report, just without indication.
    const [d, lk] = await Promise.all([
      API.get(`/radiology/results/match/${encodeURIComponent(mrno)}${site ? `?site=${site}` : ''}`),
      API.get(`/radiology/lookup/${encodeURIComponent(mrno)}`).catch(() => null),
    ]);
    const html = wlMatch(d, wlIndexIndications(lk), mrno);
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

// Build a lookup index of clinical indication keyed by bill (+ service), from the
// /radiology/lookup order detail, so wlMatch can show each exam's indication.
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
// Resolve ONE matched test to the fields the write action needs — the single source of
// truth shared by the drill render (wlMatch) and the row one-click (wlRowWriteIndication),
// so the safety-critical study/accession/indication resolution can never drift between them.
function wlResolveTest(t, o, indIdx) {
  indIdx = indIdx || {};
  const s = t.study || {}, test = t.test || {};
  const studyId = s.studyId != null ? s.studyId : (test.studyId != null ? test.studyId : null);
  const bn = String((o && o.billNo) || (t.order && t.order.billNo) || t.billNo || '').trim();
  const svc = String(test.serviceName || test.service || '').trim().toLowerCase();
  const ind = test.clinicalIndication || test.reasonForOrder || test.indication
    || t.clinicalIndication || t.reasonForOrder || t.indication
    || (bn && (indIdx['b:' + bn + '|' + svc] || indIdx['b:' + bn])) || '';
  // The ORDER's accession (independent of the study) so the backend mismatch gate is
  // meaningful — the study's own accession would trivially pass its own check.
  const accession = String(test.accession || (o && o.accession) || (t && t.accession) || '').trim();
  const isEmerg = !!(indIdx.__er && (indIdx.__er['b:' + bn + '|' + svc] != null
    ? indIdx.__er['b:' + bn + '|' + svc] : indIdx.__er['b:' + bn]));
  return { decision: t.decision, studyId, ind: String(ind || ''), accession, isEmerg,
           serviceName: test.serviceName || test.service || '' };
}
function wlResolveTests(d, indIdx) {
  const out = [];
  for (const o of ((d && d.orders) || [])) for (const t of (o.tests || [])) out.push(wlResolveTest(t, o, indIdx));
  return out;
}
function wlMatch(d, indIdx, mrno) {
  indIdx = indIdx || {};
  mrno = mrno || (d && (d.file || d.mrno)) || '';
  const orders = (d && d.orders) || [];
  if (!orders.length) return `<div class="ho-note">No order awaiting a result for this file.</div>`;
  const card = (t, o) => {
    const s = t.study || {}, rep = t.report || {}, test = t.test || {};
    const rr = wlResolveTest(t, o, indIdx);
    // studyId → Print report; cpacsUrl → View images. Both come straight off the
    // /radiology/results/match payload; render each action only when its data is present.
    const studyId = rr.studyId;
    const cpacsUrl = test.cpacsUrl || s.cpacsUrl || '';
    const ind = rr.ind;
    const indRow = ind ? `<div class="pmeta" style="margin-top:4px"><b>Indication:</b> ${escapeHtml(String(ind))}</div>` : '';
    const accession = rr.accession;
    const isEmerg = rr.isEmerg;
    const acts = [];
    // One-click: write THIS exam's indication straight into its PACS study. Only offered on
    // a UNIQUE study↔order match (never an ambiguous one — that could target the wrong exam);
    // the human picks the patient and the backend hard-gates patient + accession → fail closed.
    if (t.decision === 'unique' && studyId != null && ind) {
      // Collapse whitespace/newlines — the value rides an inline onclick attribute.
      const indClean = String(ind).replace(/\s+/g, ' ').trim();
      acts.push(`<button class="ghost" onclick="wlWriteIndication(${Number(studyId)}, '${jsAttr(String(mrno))}', '${jsAttr(indClean)}', '${jsAttr(accession)}', ${isEmerg ? 'true' : 'false'}, this)">${icon('edit')} Write indication → PACS</button>`);
    }
    if (cpacsUrl) acts.push(`<a class="ghost" target="_blank" rel="noopener" href="${escapeHtml(String(cpacsUrl))}">${icon('image')} View images</a>`);
    if (studyId != null) acts.push(`<button class="ghost" onclick="wlPrintReport(${Number(studyId)})">${icon('printer')} Print report</button>`);
    const actRow = acts.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">${acts.join('')}</div>` : '';
    if (t.decision === 'unique') {
      return `<div class="ho-de-box ok" style="display:block;margin-bottom:6px">
        <div><b>${escapeHtml(test.serviceName || '')}</b>${s.modality ? ' · ' + escapeHtml(s.modality) : ''} ${escapeHtml(s.desc || '')}</div>
        ${indRow}
        ${actRow}
      </div>`;
    }
    return `<div class="ho-de-box" style="display:block;margin-bottom:6px">
      <div><b>${escapeHtml(test.serviceName || '')}</b> — open <b>Report / Images</b> for the report &amp; images.</div>
      ${indRow}
      ${actRow}</div>`;
  };
  return orders.map(o => (o.tests || []).map(t => card(t, o)).join('')).join('');
}

// Open the study's rendered PDF report (style 2) in a new tab — the backend route
// /api/reports/study/:studyId/pdf?style=2 already serves it.
function wlPrintReport(studyId) {
  window.open('/api/reports/study/' + studyId + '/pdf?style=2', '_blank');
}

// One-click: write this exam's clinical indication into its DePACS study. Goes through
// /api/handoff/write-history, which re-reads the study and HARD-gates on patient +
// accession before writing (fails closed) — so the operator picking the patient makes
// this safe even on a PACS shared across branches. Emergency flag rides from the order.
async function wlWriteIndication(studyId, mrno, indication, accession, emergency, btn) {
  if (!studyId || !indication) return;
  if (!confirm('Write this indication into the PACS study?\n\n' + indication)) return;
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Writing…'; }
  try {
    await API.post('/handoff/write-history', {
      study_id: studyId, history: String(indication), file_no: String(mrno || ''),
      accession: accession || '', emergency: !!emergency,
      priority: emergency ? 'emergency' : 'routine',
    });
    if (typeof toast === 'function') toast('Indication written to PACS · تمت كتابة الاندكيشن');
    if (btn) { btn.disabled = true; btn.textContent = '✓ Written'; }
  } catch (e) {
    if (typeof toast === 'function') toast(e.message || 'Could not write the indication', 'err');
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

// Row-level one-click: run the same match the drill does, then write the indication ONLY
// when it resolves to exactly one unique study with an indication. Anything ambiguous (or
// nothing matched yet) opens the drill instead of guessing — the write itself still goes
// through wlWriteIndication → /api/handoff/write-history (hard patient + accession gate).
async function wlRowWriteIndication(dkey, mrno, site, btn) {
  if (!mrno) return;
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const restore = () => { if (btn) { btn.disabled = false; btn.innerHTML = orig; } };
  let d, lk;
  try {
    [d, lk] = await Promise.all([
      API.get(`/radiology/results/match/${encodeURIComponent(mrno)}${site ? `?site=${site}` : ''}`),
      API.get(`/radiology/lookup/${encodeURIComponent(mrno)}`).catch(() => null),
    ]);
  } catch (e) {
    if (typeof toast === 'function') toast(e.message || 'Match lookup failed', 'err');
    restore(); return;
  }
  const writable = wlResolveTests(d, wlIndexIndications(lk))
    .filter(x => x.decision === 'unique' && x.studyId != null && x.ind);
  if (writable.length === 1) {
    restore();
    const w = writable[0];
    return wlWriteIndication(w.studyId, mrno, w.ind, w.accession, w.isEmerg, btn);
  }
  restore();
  // 0 or >1 → let the operator review/pick inside the drill (never auto-write an ambiguous set).
  const openBtn = document.getElementById('wl-open-' + dkey);
  if (openBtn && (openBtn.textContent || '').indexOf('Hide') === -1) wlToggle(dkey, mrno, site, openBtn);
  if (typeof toast === 'function') {
    toast(writable.length > 1
      ? 'Several exams — pick one inside'
      : 'No matched study with an indication yet — opened for review');
  }
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
