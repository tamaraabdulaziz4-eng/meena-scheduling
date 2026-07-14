// ── Patient / Exam lookup ─────────────────────────────────────────────────────
// One search box that accepts a file/MRN number, a national ID (Saudi/Iqama), or a
// phone — resolves the patient in Siratech, then aggregates EVERYTHING scattered
// across the HIS (demographics + every radiology exam with its origin, clinical,
// billing and imaging/report status) into one screen. Read-only.

let psState = { q: '', patients: null, loading: false, sel: null, lookup: null, reqSeq: 0 };
// Client-side cache of fetched visit notes, keyed by `${mrno}|${encounterId}`, so an
// expand is INSTANT once prefetched in the background. Value is the notes[] array (or
// null = fetched-but-empty). Reset per patient lookup so it never leaks across patients.
let psNoteCache = new Map();
// Loaded radiology reports keyed by their DOM id, so the Print button can rebuild a
// clean Meena-letterhead printout without re-fetching. { txt, who, when, exam }.
let psReportStore = {};
// PREDICTIVE PREFETCH — a step ahead of the tap. Hovering/touching a search result (an
// intent signal) warms the patient's full lookup into this cache, so the actual open is
// INSTANT (like instant.page). Keyed by mrno → { ts, data }; short TTL keeps it live.
const psLookupCache = new Map();
const psLookupInflight = new Map();   // mrno → Promise, so hover+click don't double-fetch
const PS_LOOKUP_TTL = 90000;
function psPrefetchLookup(mrno) {
  mrno = String(mrno || '').trim();
  if (!mrno) return null;
  const hit = psLookupCache.get(mrno);
  if (hit && Date.now() - hit.ts < PS_LOOKUP_TTL) return Promise.resolve(hit.data);
  if (psLookupInflight.has(mrno)) return psLookupInflight.get(mrno);
  const pr = API.get(`/radiology/lookup/${encodeURIComponent(mrno)}`)
    .then((d) => { psLookupCache.set(mrno, { ts: Date.now(), data: d }); if (psLookupCache.size > 300) psLookupCache.delete(psLookupCache.keys().next().value); psLookupInflight.delete(mrno); return d; })
    .catch((e) => { psLookupInflight.delete(mrno); throw e; });
  psLookupInflight.set(mrno, pr);
  return pr;
}

// Fast base card (no RadiologySearch/RIS-panel enrichment) — used to paint the card in
// ~0.5s before the full enriched lookup lands. Deliberately NOT cached in psLookupCache
// (that cache holds the ENRICHED card); this is a transient first-paint fetch.
function psFetchLookupFast(mrno) {
  mrno = String(mrno || '').trim();
  if (!mrno) return Promise.resolve(null);
  return API.get(`/radiology/lookup-fast/${encodeURIComponent(mrno)}`);
}

// ── Per-SECTION prefetch cache ────────────────────────────────────────────────
// Same idea as psLookupCache but for the card's lazy sections (clinical history,
// visits, labs, appointments): a section warmed here paints with ZERO spinner when
// the card opens. Keyed `${section}|${mrno}`; single-flight so a hover-warm and the
// click it precedes share one request (the connector also caches + single-flights
// these per patient now, so warming is cheap on the HIS box).
const psSectionCache = new Map();
const psSectionInflight = new Map();
const PS_SECTION_TTL = 90000;
function psFetchSection(section, mrno, path) {
  const key = `${section}|${mrno}`;
  const hit = psSectionCache.get(key);
  if (hit && Date.now() - hit.ts < PS_SECTION_TTL) return Promise.resolve(hit.data);
  if (psSectionInflight.has(key)) return psSectionInflight.get(key);
  const pr = API.get(path)
    .then((d) => {
      psSectionCache.set(key, { ts: Date.now(), data: d });
      if (psSectionCache.size > 400) psSectionCache.delete(psSectionCache.keys().next().value);
      psSectionInflight.delete(key);
      return d;
    })
    .catch((e) => { psSectionInflight.delete(key); throw e; });
  psSectionInflight.set(key, pr);
  return pr;
}
// Warm EVERYTHING the card shows for one patient — the lookup panel plus the four
// lazy sections — so the eventual click is one paint with no spinners at all.
// Sections fire only AFTER the lookup lands (the strongest intent signal and the
// card's own blocking call), keeping a stray hover from bursting the HIS box.
// Warm the WHOLE card in a single round-trip via the bundled /card endpoint. Each
// slot (lookup + the four sections) is registered as in-flight so a concurrent card
// open joins THIS one request instead of firing its own; if the bundle omits or
// fails a slot, that slot transparently falls back to its individual endpoint — so
// an older server or a transient error degrades to the old 5-call behaviour, never
// a broken card. Data is identical and still live from Siratech.
function psPrefetchCardBundle(mrno) {
  mrno = String(mrno || '').trim();
  if (!mrno) return null;
  const enc = encodeURIComponent(mrno);
  const okData = (x) => (x && x.ok !== false && (x.status == null || x.status < 400)) ? x.data : undefined;
  const bundleP = API.get(`/radiology/patient/${enc}/card`);
  bundleP.catch(() => {});
  if (!psLookupCache.get(mrno) && !psLookupInflight.has(mrno)) {
    const lp = bundleP.then((b) => { const d = okData(b && b.patient); return d !== undefined ? d : API.get(`/radiology/lookup/${enc}`); },
                            () => API.get(`/radiology/lookup/${enc}`))
      .then((d) => { psLookupCache.set(mrno, { ts: Date.now(), data: d }); psLookupInflight.delete(mrno); return d; },
            (e) => { psLookupInflight.delete(mrno); throw e; });
    psLookupInflight.set(mrno, lp); lp.catch(() => {});
  }
  [['clinical', 'clinical', 'clinical'], ['visits', 'visits', 'visits'],
   ['labs', 'labs', 'labs'], ['appts', 'appointments', 'appointments']].forEach(([section, field, seg]) => {
    const key = `${section}|${mrno}`;
    if (psSectionCache.get(key) || psSectionInflight.has(key)) return;
    const path = `/radiology/patient/${enc}/${seg}`;
    const sp = bundleP.then((b) => { const d = okData(b && b[field]); return d !== undefined ? d : API.get(path); },
                            () => API.get(path))
      .then((d) => { psSectionCache.set(key, { ts: Date.now(), data: d }); psSectionInflight.delete(key);
                     if (section === 'visits') { try { psWarmVisitNotes(mrno, d); } catch (e) {} } return d; },
            (e) => { psSectionInflight.delete(key); throw e; });
    psSectionInflight.set(key, sp); sp.catch(() => {});
  });
  return bundleP;
}

// Warm EVERYTHING the card shows for one patient — now a single bundled round-trip.
function psPrefetchCard(mrno) {
  mrno = String(mrno || '').trim();
  if (!mrno) return null;
  return psPrefetchCardBundle(mrno);
}
// Warm the DOCTOR-NOTE renders for the patient's most recent visits at the SERVER/
// CONNECTOR layer (the connector caches a rendered note for 10 min). The client's own
// psNoteCache is reset on every card open, so this is what actually makes expanding a
// visit instant. Sequential + top-3 only — note rendering is the heaviest per-visit
// call — and deduped here so the 12s board polls don't re-fire it.
const _psNoteWarmed = new Map();   // `${mrno}|${enc}` -> ts
function psWarmVisitNotes(mrno, visitsPayload) {
  const encs = (((visitsPayload || {}).visits) || []).slice(0, 3)
    .map((v) => v.encounterId).filter((e) => e != null);
  const due = encs.filter((e) => {
    const ts = _psNoteWarmed.get(`${mrno}|${e}`);
    return !ts || Date.now() - ts > 8 * 60 * 1000;
  });
  if (!due.length) return;
  if (_psNoteWarmed.size > 600) _psNoteWarmed.clear();
  let i = 0;
  const pump = () => {
    if (i >= due.length) return;
    const e = due[i++];
    _psNoteWarmed.set(`${mrno}|${e}`, Date.now());
    API.get(`/radiology/patient/${encodeURIComponent(mrno)}/visit-note?encounterId=${encodeURIComponent(e)}`)
      .then(pump, pump);
  };
  pump();
}
let psPendingQuery = '';   // set by openPatientLookup() so the page auto-searches on open

// Deep-link into this page for a specific file/MRN (e.g. from the Home drill-down).
function openPatientLookup(q) {
  psPendingQuery = String(q || '').trim();
  if (typeof showPage === 'function') showPage('patientsearch');
}

function renderPatientSearchPage() {
  setTopbar('Patient lookup', 'Find a patient and see all their exams in one place');
  // Honour a pending deep-link query (from a Home tile / request row).
  if (psPendingQuery) { psState = { ...psState, q: psPendingQuery, patients: null, sel: null, lookup: null }; }
  const c = document.getElementById('content');
  c.innerHTML = `<div class="cc">
    ${pageHero('Lookup', 'Patient / exam lookup', 'Search by file number, national ID, Iqama, or mobile — then see the patient and every radiology exam, fully aggregated')}
    <div class="card">
      <div style="display:flex;gap:9px;flex-wrap:wrap">
        <input id="ps-q" class="input" placeholder="File / MRN · National ID · Iqama · Mobile" value="${escapeHtml(psState.q)}"
               style="flex:1;min-width:220px" onkeydown="if(event.key==='Enter')psSearch()">
        <button class="open pri" style="width:auto" onclick="psSearch()">Search</button>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-top:8px">Type any one of: the patient file/MRN, their national ID / Iqama, or their mobile number.</div>
      <div id="ps-results" style="margin-top:14px"></div>
    </div>
    <div id="ps-detail"></div>
  </div>`;
  if (psState.patients) renderPsResults();
  if (psState.lookup) renderPsDetail();
  // Auto-run a deep-link search once the input is on screen.
  if (psPendingQuery) { psPendingQuery = ''; psSearch(); }
}

async function psSearch() {
  const q = (document.getElementById('ps-q').value || '').trim();
  if (!q) return;
  psState = { ...psState, q, patients: null, sel: null, lookup: null, loading: true };
  const box = document.getElementById('ps-results');
  const det = document.getElementById('ps-detail');
  if (det) det.innerHTML = '';
  if (box) box.innerHTML = LOADING_HTML;
  const seq = ++psState.reqSeq;
  try {
    const d = await API.get(`/radiology/find?q=${encodeURIComponent(q)}`);
    if (seq !== psState.reqSeq) return;          // a newer search superseded this one
    psState.patients = (d && d.patients) || [];
    renderPsResults();
    // Exactly one hit → open it straight away (the common case for a file/ID lookup).
    if (psState.patients.length === 1) psOpen(0);
  } catch (e) {
    if (seq !== psState.reqSeq) return;
    if (box) box.innerHTML = `<div class="empty" style="padding:22px 16px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(e.message || 'Search failed')}</p>
      <small>Check the number, or that the HIS connector is reachable.</small></div>`;
  } finally { psState.loading = false; }
}

// ELM / Nafath identity-verification chip. The HIS marks a patient whose national
// identity was verified through Nafath (ELM · Absher/Yakeen) with `elmVerified`.
function psElmChip(p) {
  if (!p || !p.elmVerified) return '';
  return '<span class="nafath-chip" title="Identity verified via Nafath (ELM · Absher)">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V5z"/><path d="M9 12l2 2 4-4"/></svg>'
    + 'Nafath</span>';
}
function renderPsResults() {
  const box = document.getElementById('ps-results');
  if (!box) return;
  const pts = psState.patients || [];
  if (!pts.length) {
    box.innerHTML = `<div class="empty" style="padding:22px 16px"><p>No patient matched “${escapeHtml(psState.q)}”.</p>
      <small>Try the file/MRN number instead — some HIS records aren't searchable by phone or ID.</small></div>`;
    return;
  }
  if (pts.length === 1) { box.innerHTML = ''; return; }   // single match auto-opens; no picker
  const ICON_ID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><circle cx="8" cy="12" r="2.2"/><path d="M13 10.5h5M13 14h3.2"/></svg>';
  const ICON_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v2.9a2 2 0 0 1-2.2 2 19.6 19.6 0 0 1-8.5-3 19.3 19.3 0 0 1-6-6 19.6 19.6 0 0 1-3-8.6A2 2 0 0 1 4.1 2H7a2 2 0 0 1 2 1.7c.1.9.3 1.7.6 2.5a2 2 0 0 1-.5 2.1L7.9 9.5a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.4c.8.3 1.6.5 2.5.6A2 2 0 0 1 22 16.9z"/></svg>';
  const ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  const initials = (nm) => String(nm || '').trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '؟';
  const chip = (ic, val) => val ? `<span class="ps-res-chip">${ic}<span>${escapeHtml(String(val))}</span></span>` : '';
  box.innerHTML = `<div class="ps-res-head">${pts.length} matches — pick the patient</div>
    <div class="ps-reslist">` +
    pts.map((p, i) => `
      <button class="ps-rescard${i === psState.sel ? ' on' : ''}" onclick="psOpen(${i})"
              onkeydown="if(event.key==='Enter'){psOpen(${i})}"
              onmouseenter="psPrefetchLookup('${escapeHtml(String(p.mrno || ''))}')"
              onfocus="psPrefetchLookup('${escapeHtml(String(p.mrno || ''))}')"
              ontouchstart="psPrefetchLookup('${escapeHtml(String(p.mrno || ''))}')">
        <span class="ps-res-av">${escapeHtml(initials(p.name || p.nameArabic))}</span>
        <span class="ps-res-main">
          <span class="ps-res-name">${escapeHtml(p.name || p.nameArabic || '—')}${psElmChip(p)}</span>
          ${p.nameArabic && p.name ? `<span class="ps-res-ar">${escapeHtml(p.nameArabic)}</span>` : ''}
          <span class="ps-res-chips">
            ${chip(ICON_ID, 'MRN ' + (p.mrno || '—'))}
            ${chip(ICON_PHONE, p.phone)}
            ${p.age ? `<span class="ps-res-chip"><span>${escapeHtml(String(p.age))}</span></span>` : ''}
          </span>
        </span>
        <span class="ps-res-chev">${ICON_CHEV}</span>
      </button>`).join('') + '</div>';
}

async function psOpen(i) {
  const p = (psState.patients || [])[i];
  if (!p || !p.mrno) return;
  psState.sel = i;
  renderPsResults();
  // Warm the whole card in ONE bundled round-trip. The lookup + section fetches
  // below then join these in-flight promises instead of firing 5 separate requests.
  psPrefetchCardBundle(p.mrno);
  const det = document.getElementById('ps-detail');
  // Skip the loading flash entirely when the patient was prefetched on hover/touch — it's
  // already in hand, so the card paints on the very next line (feels instant).
  const cached = psLookupCache.get(String(p.mrno));
  const warm = cached && Date.now() - cached.ts < PS_LOOKUP_TTL;
  if (det && !warm) det.innerHTML = LOADING_HTML;
  const seq = ++psState.reqSeq;
  psNoteCache = new Map();   // fresh patient → drop any prefetched notes from the last one
  psReportStore = {};        // and any stored reports (Print rebuilds from these)
  // Keep the search-row patient as a fallback when the lookup's own patient block is thin.
  const paint = (d) => { psState.lookup = { ...d, patient: d.patient || p }; renderPsDetail(); };
  try {
    if (warm) { paint(cached.data); return; }
    // FAST first: paint the base card (~0.5s — no RadiologySearch/RIS-panel enrichment) so the
    // card is visible immediately, then upgrade to the full enriched card when it lands (fills
    // in clinical indication, ordering branch, referring doctor, ER flag).
    let painted = false;
    const fast = await psFetchLookupFast(p.mrno).catch(() => null);
    if (seq !== psState.reqSeq) return;
    if (fast) { paint(fast); painted = true; }
    try {
      const full = await psPrefetchLookup(p.mrno);
      if (seq !== psState.reqSeq) return;
      paint(full);
    } catch (e2) { if (!painted) throw e2; }   // enrichment failed but the fast card is up → keep it
  } catch (e) {
    if (seq !== psState.reqSeq) return;
    if (det) det.innerHTML = `<div class="card"><div class="empty" style="padding:22px 16px"><div class="empty-icon">⚠️</div>
      <p>${escapeHtml(e.message || 'Could not load the patient\'s exams')}</p></div></div>`;
  }
}

// A labelled field cell; hidden entirely when the value is empty so the card stays clean.
function psField(label, val, opts) {
  opts = opts || {};
  const v = (val == null || String(val).trim() === '') ? '' : String(val);
  if (!v && !opts.always) return '';
  return `<div class="ps-field">
    <div class="ps-field-l">${escapeHtml(label)}</div>
    <div class="ps-field-v"${opts.accent ? ' style="color:var(--accent)"' : ''}>${opts.html ? v : escapeHtml(v || '—')}</div>
  </div>`;
}

// A big, glanceable stat tile (height / weight / BMI / blood group) — Clinical Calm
// .kpi card (accent variants: a=amber b=blue c=green d=violet).
const PS_TILE_DOT = { a: 'var(--yellow,#FFBA49)', b: 'var(--blue,#3BA0FF)', c: 'var(--green,#00C896)', d: 'var(--accent,#6B4EFF)' };
function psTile(label, value, unit, accent) {
  const v = (value == null || String(value).trim() === '') ? '' : String(value);
  if (!v) return '';
  const acc = accent || 'b';
  return `<div class="kpi ${acc}">
    <div class="kl"><span class="kd" style="background:${PS_TILE_DOT[acc] || PS_TILE_DOT.b}"></span>${escapeHtml(label)}</div>
    <div class="kv">${escapeHtml(v)}${unit ? `<small>${escapeHtml(unit)}</small>` : ''}</div>
  </div>`;
}

function renderPsDetail() {
  const det = document.getElementById('ps-detail');
  if (!det) return;
  const d = psState.lookup || {};
  const p = d.patient || {};
  const orders = d.orders || [];
  const tiles = [
    psTile('Height', p.height, p.height && Number(p.height) > 3 ? 'cm' : '', 'b'),
    psTile('Weight', p.weight, p.weight ? 'kg' : '', 'c'),
    psTile('BMI', p.bmi, '', 'd'),
    psTile('Blood', p.bloodGroup, '', 'a'),
  ].filter(Boolean).join('');
  // Contrast-safety: a known allergy must be impossible to miss on a radiology screen.
  const allergyAlert = p.allergy
    ? `<div class="ps-alert">⚠️ <b>Allergy:</b> ${escapeHtml(p.allergy)}</div>` : '';
  // A polished masthead (header band) + body: safety zone → stats → clinical → demographics
  // → async sections → consent footer. Async psLoad* helpers fill their own #id below.
  const patCard = `
    <div class="card ps-pt-card">
      <div class="ps-head">
        <div class="ps-id-main">
          <div class="ps-pt-name">${escapeHtml(p.name || '—')}</div>
          ${p.nameArabic ? `<div class="ps-pt-ar">${escapeHtml(p.nameArabic)}</div>` : ''}
          <div class="ps-id-chips">
            ${p.gender ? `<span class="ps-chip ps-chip-strong">${escapeHtml(p.gender)}</span>` : ''}
            ${p.age ? `<span class="ps-chip">${escapeHtml(p.age)}</span>` : ''}
            ${p.nationality ? `<span class="ps-chip">${escapeHtml(p.nationality)}</span>` : ''}
            ${psElmChip(p)}
          </div>
        </div>
        <div class="ps-id-mrn">
          <div class="ps-id-mrn-l">FILE / MRN</div>
          <div class="ps-id-mrn-v">${escapeHtml(p.mrno || '—')}</div>
        </div>
      </div>
      <div class="ps-body">
        <div class="ps-safety">
          <div id="ps-labs"></div>
          ${allergyAlert}
        </div>
        <!-- Everything we ALREADY have from the lookup renders instantly, together, at the top —
             so the card reads as complete immediately. The heavy Siratech history sections all
             sit below and fill their skeletons in parallel, instead of popping in one by one. -->
        <div class="ps-sec ps-demog">
          <div class="ps-sec-l">Demographics</div>
          <div class="ps-grid ps-idgrid">
            ${psField('National ID / Iqama', p.nationalId)}
            ${psField('Phone', p.phone)}
            ${psField('Date of birth', p.dob)}
            ${psField('Marital status', p.maritalStatus)}
          </div>
        </div>
        ${tiles ? `<div class="kpis">${tiles}</div>` : ''}
        <div id="ps-clinical"></div>
        <div id="ps-labresults"></div>
        <div id="ps-visits"></div>
        <div id="ps-appts"></div>
        <div class="ps-consent">
          <div class="ps-actions">
            <!-- Non-pregnancy consent is raised/filed ONLY from the Worklist now — removed
                 from the patient card so there's a single place that files it to the record. -->
            <button class="btn btn-ghost" onclick="psUploadDocument()">📎 Upload document</button>
          </div>
          <div id="ps-doc-list" class="ps-consent-list"></div>
        </div>
      </div>
    </div>`;

  let examBlock;
  if (!orders.length) {
    examBlock = `<div class="card"><div class="empty" style="padding:22px 16px"><p>No radiology exam on this file.</p></div></div>`;
  } else {
    // Newest first — a patient with many visits should read top-down by recency.
    const sorted = orders.map((o, i) => ({ o, i }))
      .sort((a, b) => (psOrderTime(b.o) - psOrderTime(a.o)) || (a.i - b.i))
      .map((x) => x.o);
    // Collapsible rows keep a long history scannable: only the most recent exam is
    // expanded by default; the rest show a one-line summary you can tap open.
    examBlock = `<div class="ps-sec-l ps-examhead">Radiology exams · ${sorted.length}<span>newest first</span></div>` +
      sorted.map((o, i) => psExamCard(o, i === 0)).join('');
  }
  det.innerHTML = patCard + examBlock;
  psLoadDocuments();   // consent list removed from the card — the Worklist owns consent now
  psLoadLabs();
  psSectionSkeleton('ps-clinical', 'Clinical history', 'clinical', 2);   // so the problem list doesn't pop in late
  psLoadClinical();                            // problem list · allergies · vitals (from Siratech) — auto (kept open)
  // The heavy history sections each hit Siratech. They now load in the BACKGROUND (were
  // tap-to-load): each paints a skeleton immediately so the card feels alive, then fills.
  // Loaded in sequence (psAutoLoadSections) so the 2 GB HIS box isn't hit by all at once.
  psSectionSkeleton('ps-labresults', 'Lab results', 'labs', 3);
  psSectionSkeleton('ps-visits', 'Recent visits', 'visits', 3);
  psSectionSkeleton('ps-appts', 'Appointment history', 'appts', 2);
  psAutoLoadSections();
  if (orders.length) psAutoReports(orders);   // auto-fill every exam's report — no clicking
}

// Load the patient's history sections in the background, one after another (labs →
// visits → appointments), so at most one heavy Siratech call is in flight at a time.
// Each already renders a skeleton; a section with no data quietly removes itself. Bails
// if the user opened a different patient mid-sequence (reqSeq changed).
async function psAutoLoadSections() {
  const seq = psState.reqSeq;
  const live = () => seq === psState.reqSeq && psState.lookup && psState.lookup.patient && psState.lookup.patient.mrno;
  if (!live()) return;
  // Load the history sections CONCURRENTLY (was one-after-another, which made them pop in at
  // staggered times). This is a single open card = one patient, so 3 parallel HIS reads are
  // fine — the board-wide fan-out is what we throttle, not one card. Each fills its own
  // skeleton in place; a failed one just clears itself.
  await Promise.all([
    psLoadRealLabs().catch(() => {}),
    psLoadVisits().catch(() => {}),
    psLoadAppointments().catch(() => {}),
  ]);
}

// A shimmering skeleton placeholder for a section while its data loads — gives an
// immediate, animated "loading" cue (no more blank-then-pop). `rows` = how many
// placeholder lines to show.
function psSectionSkeleton(id, title, iconKey, rows) {
  const box = document.getElementById(id);
  if (!box) return;
  const ic = PS_LAZY_ICON[iconKey] || '';
  const rowHtml = `<div class="ps-skel-row"><span class="ps-skel-b ps-skel-w1"></span><span class="ps-skel-b ps-skel-w2"></span></div>`;
  box.innerHTML = `<div class="ps-sec-l ps-skel-head" style="margin-top:14px">
      ${ic ? `<span class="ps-skel-ic">${ic}</span>` : ''}<span>${escapeHtml(title)}</span>
      <span class="ps-skel-dot"></span>
    </div>
    <div class="ps-skel">${rowHtml.repeat(Math.max(1, rows || 3))}</div>`;
}


// A collapsed, tap-to-load section header. The real loader (psLoadRealLabs / psLoadVisits /
// psLoadAppointments) renders into the same container, replacing this stub, only when opened —
// so the card paints fast and each Siratech call happens on demand.
const PS_LAZY_ICON = {
  labs:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3h5M10.5 3v6l-4.8 7.6A2 2 0 0 0 7.4 20h9.2a2 2 0 0 0 1.7-3.4L13.5 9V3"/><path d="M8 14.5h8"/></svg>',
  visits: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6a1 1 0 0 1 1 1v1h1a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1V4a1 1 0 0 1 1-1z"/><path d="M9 12h6M9 16h4"/></svg>',
  appts:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>',
  clinical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z"/><path d="M8.5 11.5h2l1-2 1.5 3.5 1-1.5h1.5"/></svg>',
};
const PS_LAZY_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
// Patient clinical context — problem list (ICD diagnoses), allergies / clinical
// warnings, and vitals — straight from Siratech EMR. Loaded after the card paints,
// best-effort (a failure just shows nothing). Read-only.
async function psLoadClinical() {
  const box = document.getElementById('ps-clinical');
  if (!box) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno) { box.innerHTML = ''; return; }
  let d;
  try { d = await psFetchSection('clinical', String(p.mrno), `/radiology/patient/${encodeURIComponent(p.mrno)}/clinical`); }
  catch (e) { box.innerHTML = ''; return; }
  const dx = (d && d.diagnoses) || [];
  const al = (d && d.allergies) || {};
  const vi = d && d.vitals;
  const fl = (d && d.flags) || {};
  const secL = (t) => `<div class="ps-sec-l" style="margin-top:14px">${t}</div>`;
  let html = '';
  // Infection status — isolation / scanner & contrast precautions. Must be loud.
  if (fl.infections && fl.infections.length) {
    html += `<div class="ps-alert" style="margin-top:12px">🧬 <b>Infection status:</b> ${fl.infections.map(escapeHtml).join(' · ')} — observe precautions.</div>`;
  }
  // Pregnancy + gestational age — radiation safety must be loud, like infection status.
  const fet = (d && d.fetal) || null;
  if (fl.pregnant || fet) {
    const parts = [];
    if (fet && fet.gestationWeeks != null) parts.push(fet.gestationWeeks + ' wk');
    if (fet && fet.gestationDays != null) parts.push(fet.gestationDays + ' d');
    const ga = parts.join(' ');
    html += `<div class="ps-alert" style="margin-top:12px">🤰 <b>Pregnant</b>${ga ? ' · Gestational age ' + escapeHtml(ga) : ''} — observe radiation precautions.</div>`;
  }
  // Blood group + VIP + any clinical warning as compact chips.
  const infoChips = [
    fl.bloodGroup ? `<span style="display:inline-flex;gap:5px;align-items:baseline;background:var(--card-alt,#f4f4f8);border:1px solid var(--border);border-radius:8px;padding:4px 9px;font-size:12.5px"><b>${escapeHtml(fl.bloodGroup)}</b><span style="color:var(--muted)">Blood</span></span>` : '',
    fl.vip ? `<span style="background:var(--accent);color:#fff;border-radius:8px;padding:4px 9px;font-size:12px;font-weight:700">VIP</span>` : '',
  ].filter(Boolean).join('');
  if (infoChips) html += secL('Patient flags') + `<div style="display:flex;gap:7px;flex-wrap:wrap">${infoChips}</div>`;
  if (fl.clinicalWarning) html += `<div class="ps-alert" style="margin-top:10px">⚠️ <b>Clinical warning:</b> ${escapeHtml(fl.clinicalWarning)}</div>`;
  // Allergies / warnings FIRST — contrast safety must be impossible to miss.
  const allergies = [...(al.drug || []).map((x) => ({ ...x, k: 'Drug' })),
    ...(al.other || []).map((x) => ({ ...x, k: '' })), ...(al.warnings || []).map((x) => ({ ...x, k: 'Warning' }))];
  if (allergies.length) {
    html += `<div class="ps-alert" style="margin-top:12px">⚠️ <b>Allergies / warnings:</b> ${allergies.map((a) =>
      escapeHtml(a.name) + (a.severity ? ` (${escapeHtml(a.severity)})` : '') + (a.reaction ? ` — ${escapeHtml(a.reaction)}` : '')).join(' · ')}</div>`;
  }
  // Vitals — shown only when the clinic actually recorded them (often none here).
  if (vi) {
    const chip = (lbl, v, u) => (v == null || String(v).trim() === '') ? '' :
      `<span style="display:inline-flex;gap:4px;align-items:baseline;background:var(--card-alt,#f4f4f8);border:1px solid var(--border);border-radius:8px;padding:4px 9px;font-size:12.5px"><b>${escapeHtml(String(v))}${u || ''}</b><span style="color:var(--muted)">${lbl}</span></span>`;
    const bp = (vi.systolic && vi.diastolic) ? chip('BP', `${vi.systolic}/${vi.diastolic}`, '') : '';
    const chips = [chip('Height', vi.height, vi.height && Number(vi.height) > 3 ? ' cm' : ''),
      chip('Weight', vi.weight, ' kg'), chip('BMI', vi.bmi, ''), bp, chip('Pulse', vi.pulse, ''),
      chip('Temp', vi.temperature, '°'), chip('SpO₂', vi.spo2, '%'), chip('Resp', vi.respiratoryRate, '')].filter(Boolean).join('');
    if (chips) html += secL(`Vitals${vi.recordedAt ? ` · ${escapeHtml(String(vi.recordedAt).slice(0, 10))}` : ''}`)
      + `<div style="display:flex;gap:7px;flex-wrap:wrap">${chips}</div>`;
  }
  // Problem list — the patient's ICD-coded diagnoses (the radiologist's clinical context).
  if (dx.length) {
    html += secL(`Problem list · ${dx.length}`) + `<div style="display:flex;gap:7px;flex-wrap:wrap">` +
      dx.map((x) => `<span title="${escapeHtml(x.icdCode || '')}${x.date ? ' · ' + escapeHtml(x.date) : ''}"
        style="display:inline-flex;gap:6px;align-items:center;background:var(--violet-wash,#F0EDFF);color:var(--accent2,#6B4EFF);border-radius:8px;padding:4px 10px;font-size:12.5px">
        ${escapeHtml(x.name)}${x.chronic ? '<span style="font-size:10px;font-weight:700;background:#e2571f;color:#fff;border-radius:4px;padding:1px 5px">CHRONIC</span>' : ''}</span>`).join('') + `</div>`;
  }
  box.innerHTML = html ? (secL('Clinical history · from Siratech') + html) : '';
}

// The patient's recent clinic visits (encounters) — date · OP/ER · provider · branch,
// straight from Siratech. Lets the radiologist browse the patient's recent history.
// (Per-test lab VALUES aren't exposed by the HIS API for this centre, so only the
// visit history is shown, not lab numbers.) Read-only, best-effort.
async function psLoadVisits() {
  const box = document.getElementById('ps-visits');
  if (!box) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno) { box.innerHTML = ''; return; }
  let d;
  try { d = await psFetchSection('visits', String(p.mrno), `/radiology/patient/${encodeURIComponent(p.mrno)}/visits`); }
  catch (e) { box.innerHTML = ''; return; }
  const visits = (d && d.visits) || [];
  if (!visits.length) { box.innerHTML = ''; return; }
  const rows = visits.slice(0, 12).map((v, i) => {
    const er = String(v.visitType || '').toUpperCase() === 'ER';
    const badge = v.visitType ? `<span class="ps-visit-badge ${er ? 'er' : 'op'}">${escapeHtml(v.visitType)}</span>` : '';
    const sub = [v.provider, v.department, v.site].filter(Boolean).map(escapeHtml).join(' · ');
    const enc = v.encounterId;
    const canNote = enc != null;
    return `<div class="ps-visit${canNote ? ' ps-visit-open' : ''}">
      <div class="ps-visit-row" ${canNote ? `onclick="psToggleVisitNote('${escapeHtml(String(enc))}','psvn-${i}',this)"` : ''}>
        <span class="ps-visit-date">${escapeHtml(String(v.date || '').slice(0, 10))}</span>
        ${badge}
        <span class="ps-visit-cc">${v.chiefComplaint ? escapeHtml(v.chiefComplaint) : '<span class="ps-visit-nocc">Visit</span>'}</span>
        ${canNote ? `<span id="psvn-${i}-c" class="ps-visit-chev">${PS_LAZY_CHEV}</span>` : ''}
      </div>
      ${sub ? `<div class="ps-visit-sub">${sub}</div>` : ''}
      <div id="psvn-${i}" class="ps-visit-note" style="display:none"></div>
    </div>`;
  }).join('');
  box.innerHTML = `<div class="ps-sec-l" style="margin-top:14px">Recent visits · ${visits.length}</div><div class="ps-visits">${rows}</div>`;
  // Warm the notes in the BACKGROUND so expanding a visit is instant (no spinner).
  psPrefetchVisitNotes(p.mrno, visits.slice(0, 12).map((v) => v.encounterId).filter((e) => e != null));
}

// Fetch a single visit's notes, memoised in psNoteCache. Returns notes[] (possibly
// empty) or throws on network error. Shared by the on-demand expand and the prefetch.
async function psFetchVisitNote(mrno, encounterId) {
  const key = `${mrno}|${encounterId}`;
  if (psNoteCache.has(key)) return psNoteCache.get(key);
  const d = await API.get(`/radiology/patient/${encodeURIComponent(mrno)}/visit-note?encounterId=${encodeURIComponent(encounterId)}`);
  const notes = (d && d.notes) || [];
  psNoteCache.set(key, notes);
  return notes;
}

// Quietly pre-load the notes for the visible visits, low-concurrency so the 2 GB HIS
// box isn't hammered. Populates psNoteCache; if a row is already expanded and waiting,
// fill it the moment its note lands. Best-effort — a failed prefetch just falls back
// to the on-demand fetch when the user actually expands that row.
async function psPrefetchVisitNotes(mrno, encounterIds) {
  if (!mrno || !encounterIds || !encounterIds.length) return;
  let i = 0;
  const worker = async () => {
    while (i < encounterIds.length) {
      const enc = encounterIds[i]; i += 1;
      const key = `${mrno}|${enc}`;
      if (psNoteCache.has(key)) continue;
      // bail if the user navigated to a different patient mid-prefetch
      const cur = (psState.lookup && psState.lookup.patient) || {};
      if (String(cur.mrno) !== String(mrno)) return;
      try { await psFetchVisitNote(mrno, enc); } catch (e) { continue; }
      // if a row for this encounter is open and showing the loader, render it now
      document.querySelectorAll(`[data-note-enc="${enc}"]`).forEach((box) => {
        if (box.style.display !== 'none' && !box.dataset.loaded) psRenderVisitNote(box, psNoteCache.get(key));
      });
    }
  };
  await Promise.all([worker(), worker()]);   // concurrency 2
}

// Render a note box from a notes[] array — clean label/value cards, empties dropped.
function psRenderVisitNote(box, notes) {
  if (!box) return;
  box.dataset.loaded = '1';
  if (!notes || !notes.length) { box.innerHTML = `<span style="color:var(--muted);font-size:12px">No readable note on this visit.</span>`; return; }
  const fieldRow = (f) => f.label
    ? `<div class="ps-nf"><span class="ps-nf-k">${escapeHtml(f.label)}</span><span class="ps-nf-v">${escapeHtml(f.value)}</span></div>`
    : `<div class="ps-nf ps-nf-solo">${escapeHtml(f.value)}</div>`;
  const sectionCard = (s) => {
    const fields = Array.isArray(s.fields) && s.fields.length
      ? s.fields
      // fallback for the old API shape: split the text blob into label:value lines
      : String(s.text || '').split('\n').map((ln) => {
          const m = ln.match(/^([^:]{2,60}?):\s*([\s\S]*)$/);
          return m ? { label: m[1].trim(), value: m[2].trim() } : { label: null, value: ln.trim() };
        }).filter((f) => f.value);
    if (!fields.length) return '';
    return `<div class="ps-note-sec">
      ${s.label ? `<div class="ps-note-sec-h">${escapeHtml(s.label)}</div>` : ''}
      <div class="ps-note-fields">${fields.map(fieldRow).join('')}</div>
    </div>`;
  };
  box.innerHTML = notes.map((n) => {
    const meta = [n.by, n.date ? String(n.date).slice(0, 10) : ''].filter(Boolean).map(escapeHtml).join(' · ');
    const secs = (Array.isArray(n.sections) ? n.sections : []).map(sectionCard).filter(Boolean).join('');
    return `<div class="ps-note-card">
      <div class="ps-note-head">
        <span class="ps-note-title">${escapeHtml(n.templateName || 'Note')}</span>
        ${meta ? `<span class="ps-note-meta">${meta}</span>` : ''}
      </div>
      ${secs || '<div class="ps-note-empty">No readable content in this note.</div>'}
    </div>`;
  }).join('');
}

// Expand a visit row to show the doctor's clinical note(s) for that encounter. Uses the
// background-prefetched cache when available (instant); otherwise fetches on demand.
async function psToggleVisitNote(encounterId, elId, caretRow) {
  const box = document.getElementById(elId);
  if (!box) return;
  const caret = document.getElementById(elId + '-c');
  const row = caret && caret.closest('.ps-visit');
  if (box.style.display !== 'none') { box.style.display = 'none'; if (row) row.classList.remove('exp'); return; }
  box.style.display = ''; if (row) row.classList.add('exp');
  if (box.dataset.loaded) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  const key = `${p.mrno}|${encounterId}`;
  box.dataset.noteEnc = encounterId; box.setAttribute('data-note-enc', encounterId);
  if (psNoteCache.has(key)) { psRenderVisitNote(box, psNoteCache.get(key)); return; }  // instant
  box.innerHTML = '<span style="color:var(--muted);font-size:12px">Loading note from Siratech…</span>';
  let notes;
  try { notes = await psFetchVisitNote(p.mrno, encounterId); }
  catch (e) { box.innerHTML = `<span style="color:var(--muted);font-size:12px">Could not load the note.</span>`; return; }
  psRenderVisitNote(box, notes);
}

// The patient's appointment history — date · speciality · doctor · status. Read-only.
async function psLoadAppointments() {
  const box = document.getElementById('ps-appts');
  if (!box) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno) { box.innerHTML = ''; return; }
  let d;
  try { d = await psFetchSection('appts', String(p.mrno), `/radiology/patient/${encodeURIComponent(p.mrno)}/appointments`); }
  catch (e) { box.innerHTML = ''; return; }
  const appts = (d && d.appointments) || [];
  if (!appts.length) { box.innerHTML = ''; return; }
  const statusColor = (s) => /cancel/i.test(s) ? 'var(--danger-ink)' : (/miss|no.?show/i.test(s) ? 'var(--warn-ink)' : (/confirm|complet|attend/i.test(s) ? 'var(--success-ink)' : 'var(--muted)'));
  const rows = appts.slice(0, 10).map((a) => `
    <div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px dashed var(--border);flex-wrap:wrap">
      <span style="font-weight:600;font-variant-numeric:tabular-nums;min-width:112px">${escapeHtml(String(a.date || '').slice(0, 16).replace('T', ' '))}</span>
      <span style="flex:1;min-width:120px;font-size:12.5px">${escapeHtml(a.resource || a.speciality || '')}${a.speciality && a.resource ? ` · ${escapeHtml(a.speciality)}` : ''}</span>
      ${a.status ? `<span style="font-size:11.5px;font-weight:600;color:${statusColor(a.status)}">${escapeHtml(a.status)}</span>` : ''}
    </div>`).join('');
  box.innerHTML = `<div class="ps-sec-l" style="margin-top:14px">Appointments · ${appts.length}</div><div>${rows}</div>`;
}

// The patient's lab results — test · value · reference range · normal/abnormal,
// straight from Siratech (Clinicalreport). Grouped by result date, newest first,
// abnormal/critical highlighted. Loaded after paint, best-effort. Read-only.
async function psLoadRealLabs() {
  const box = document.getElementById('ps-labresults');
  if (!box) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno) { box.innerHTML = ''; return; }
  // The shimmering section skeleton (psSectionSkeleton) is already showing — leave it in
  // place while the HIS call returns, then replace it with the results (or clear if none).
  let d;
  try { d = await psFetchSection('labs', String(p.mrno), `/radiology/patient/${encodeURIComponent(p.mrno)}/labs`); }
  catch (e) { box.innerHTML = ''; return; }
  const panels = (d && d.panels) || [];
  const results = (d && d.results) || [];
  if (!panels.length) { box.innerHTML = ''; return; }
  const abn = results.filter((r) => r.abnormal || r.critical).length;
  const when = (d && d.latest) ? String(d.latest).slice(0, 10).trim() : '';
  const head = `<div class="ps-sec-l" style="margin-top:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <span>Lab results · ${results.length}</span>
    ${abn ? `<span style="font-size:10px;font-weight:800;letter-spacing:.03em;color:#fff;background:#e2571f;border-radius:5px;padding:1px 6px">${abn} ABNORMAL</span>`
          : `<span style="font-size:10px;font-weight:800;letter-spacing:.03em;color:#fff;background:#0a8f5b;border-radius:5px;padding:1px 6px">ALL NORMAL</span>`}
    ${when ? `<span style="font-weight:600;color:var(--muted);text-transform:none;letter-spacing:0">Last lab · ${escapeHtml(when)}</span>` : ''}
  </div>`;
  const rowHtml = (r) => {
    const crit = r.critical, ab = r.abnormal || crit;
    const col = crit ? '#c0261a' : (ab ? '#e2571f' : 'var(--ink)');
    const flag = crit ? ' ⚠' : (ab ? ' ▲' : '');
    return `<div style="display:flex;gap:10px;align-items:baseline;padding:6px 12px;${ab ? 'background:rgba(226,87,31,.07);' : ''}border-top:1px solid var(--border)">
      <span style="flex:1;min-width:130px;font-size:12.5px">${escapeHtml(r.name)}</span>
      <span style="font-weight:${ab ? '750' : '600'};color:${col};font-variant-numeric:tabular-nums;white-space:nowrap">${escapeHtml(r.value)}${flag}</span>
      ${r.range ? `<span style="color:var(--muted);font-size:11px;min-width:90px;text-align:right">${escapeHtml(r.range)}</span>` : ''}
    </div>`;
  };
  // Collapsible groups: ALL start collapsed — click a group header to expand its tests.
  // The abnormal-count badge stays on the collapsed header so a group with an abnormal
  // result is still flagged without opening it. Each group shows its own draw date.
  const panelHtml = (pan, idx) => {
    const nAbn = pan.tests.filter((t) => t.abnormal || t.critical).length;
    const bodyId = 'ps-lab-p' + idx;
    const pdate = pan.date || pan.drawnAt || pan.resultDate || pan.orderDate || '';
    const pdstr = pdate ? String(pdate).slice(0, 10).trim() : '';
    return `<div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-top:10px;background:var(--card,#fff)">
      <button type="button" onclick="psTogglePanel(this,'${bodyId}')" style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;background:var(--card-alt,#f4f4f8);border:0;border-bottom:1px solid var(--border);cursor:pointer;font:inherit;text-align:start">
        <span style="font-weight:700;font-size:12.5px;display:flex;align-items:center;gap:8px"><span class="ps-lab-chev" style="display:inline-block;transition:transform .15s;color:var(--muted)">▸</span>${escapeHtml(pan.name)}${pdstr ? `<span style="font-weight:500;color:var(--muted);font-size:11px">· ${escapeHtml(pdstr)}</span>` : ''}</span>
        ${nAbn ? `<span style="font-size:10px;font-weight:800;color:#fff;background:var(--warn-ink,#e2571f);border-radius:5px;padding:1px 6px">${nAbn} ▲</span>`
               : `<span style="font-size:11px;color:var(--muted)">${pan.tests.length} tests</span>`}
      </button>
      <div id="${bodyId}" style="display:none">${pan.tests.map(rowHtml).join('')}</div>
    </div>`;
  };
  box.innerHTML = head + panels.map(panelHtml).join('');
}

// Expand/collapse one lab-results group (accordion in the patient card).
function psTogglePanel(btn, bodyId) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  const chev = btn.querySelector('.ps-lab-chev');
  if (chev) chev.style.transform = open ? '' : 'rotate(90deg)';
}

// Radiation-safety labs panel: for a female patient, auto-load her pregnancy / β-hCG
// status on the patient page (a single call — this is a dedicated per-patient view,
// not the 30-row board, so auto-loading is fine here). Read-only decision support.
async function psLoadLabs() {
  const box = document.getElementById('ps-labs');
  if (!box) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno || !psNeedsRadSafety()) { box.innerHTML = ''; return; }   // female + ionising-radiation exam only
  box.innerHTML = '<span style="color:var(--muted);font-size:12px">🤰 Checking pregnancy status…</span>';
  let r;
  try { r = await API.get(`/radiology/labs/pregnancy?mrno=${encodeURIComponent(p.mrno)}`); }
  catch (e) { box.innerHTML = '<span style="color:var(--muted);font-size:12px">🤰 Pregnancy status unavailable.</span>'; return; }
  const when = r && (r.resultDate || r.orderDate);
  const dstr = when ? ' · ' + escapeHtml(String(when).slice(0, 10)) : '';
  const nm = r && r.testName ? escapeHtml(String(r.testName)) : 'pregnancy test';
  let html;
  if (!r || !r.found || !r.hasPregnancyTest) {
    html = `<div class="ps-alert warn">🤰 <b>Pregnancy / β-hCG — not ordered</b> · none on file. Confirm status before imaging.</div>`;
  } else if (r.verdict === 'positive') {
    html = `<div class="ps-alert">🤰 <b>Pregnancy — POSITIVE</b> · ${nm}${r.resultText ? ' = ' + escapeHtml(String(r.resultText)) : ''}${dstr}. Do NOT irradiate without physician review.</div>`;
  } else if (r.verdict === 'negative') {
    html = `<div class="ps-alert ok">🤰 <b>Pregnancy — negative</b> · ${nm}${dstr}.</div>`;
  } else if (r.resulted) {
    html = `<div class="ps-alert neutral">🤰 <b>Pregnancy — resulted</b> · ${nm}${r.resultText ? ' = ' + escapeHtml(String(r.resultText)) : ''}${dstr}. Read the value.</div>`;
  } else {
    html = `<div class="ps-alert warn">🤰 <b>Pregnancy / β-hCG — ordered, result pending</b>${dstr}.</div>`;
  }
  box.innerHTML = html;
}

// Female detection (the non-pregnancy consent is female-specific) — accept English
// and Arabic spellings; unknown gender → not auto-highlighted (staff can still open it).
// Delegates to the shared isFemaleGender (util.js) so the card and worklist never drift.
function psIsFemale(p) { return isFemaleGender(p && p.gender); }
// Non-pregnancy consent + β-hCG are RADIATION-safety measures: they apply ONLY to a
// female patient having an IONISING-radiation exam. Ultrasound (US) and MRI (MR) use no
// ionising radiation, so they never need either — and a male never does. Mirrors the
// worklist's wlNeedsRadSafety so the two screens agree.
const PS_NONRAD_MODS = new Set(['US', 'MR']);
function psModBucket(o) {
  const raw = String((o && (o.modality || o.service)) || '').toUpperCase();
  if (/\bMRI?\b|MAGNET/.test(raw)) return 'MR';
  if (/ULTRA|SONO|\bUS\b|DOPPLER/.test(raw)) return 'US';
  if (/\bDEXA\b|\bDXA\b|\bBMD\b|BONE\s*DENSIT|DENSITOMET/.test(raw)) return 'BMD';  // ionizing (low-dose)
  if (/\bCT\b|COMPUTED|TOMOGRAPH/.test(raw)) return 'CT';
  if (/MAMMO|\bMG\b/.test(raw)) return 'MG';
  if (/X.?RAY|\bXR\b|\bCR\b|\bDX\b|\bDR\b|RADIOGRAPH/.test(raw)) return 'XR';
  return '';   // unknown modality
}
function psNeedsRadSafety() {
  const d = psState.lookup || {};
  if (!psIsFemale(d.patient || {})) return false;             // male → never
  const orders = d.orders || [];
  if (!orders.length) return true;                            // exams unknown → fail-open (never hide a safety prompt when unsure)
  // Show only when at least one exam uses ionising radiation (i.e. is NOT purely US/MRI);
  // an unknown modality counts as radiation (fail-open).
  return orders.some((o) => !PS_NONRAD_MODS.has(psModBucket(o)));
}
// Launch the consent with ALL the patient's data pre-registered on it — she only
// reads, picks the reason, and signs. Procedure/type/physician come from the most
// recent exam so the form matches what she's about to have done.
function psStartConsent() {
  const d = psState.lookup || {};
  const p = d.patient || {};
  const orders = (d.orders || []).map((o, i) => ({ o, i }))
    .sort((a, b) => (psOrderTime(b.o) - psOrderTime(a.o)) || (a.i - b.i)).map((x) => x.o);
  const top = orders[0] || {};
  openConsentQR({
    file_no: p.mrno || '', mrno: p.mrno || '', name: p.name || '', dob: p.dob || '',
    weight: p.weight || '', height: p.height || '', branch: top.branch || '',
    procedure: top.service || '', patient_type: top.isER ? 'er' : 'outpatient',
    physician: top.provider || '', bill_no: top.billNo || '', site: top.siteId || null,
  }, () => psLoadConsents());
}
async function psLoadConsents() {
  const box = document.getElementById('ps-consent-list');
  if (!box) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno) { box.innerHTML = ''; return; }
  let d;
  try { d = await API.get(`/consent?file_no=${encodeURIComponent(p.mrno)}`); } catch (e) { box.innerHTML = ''; return; }
  const list = (d && d.consents) || [];
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = list.map((c) => `
    <div class="ps-consent-row">
      <span>📄 ${escapeHtml(c.kind === 'non_pregnancy' ? 'Non-pregnancy' : c.kind)}${c.procedure ? ' · ' + escapeHtml(c.procedure) : ''}
        <span style="color:var(--muted)">· ${escapeHtml(String(c.created_at || '').slice(0, 16).replace('T', ' '))}${c.created_by_name ? ' · ' + escapeHtml(c.created_by_name) : ''}</span>
        ${c.filed_siratech ? '<span class="pill ok" title="On the patient\'s Siratech file">📎 On file</span>' : ''}</span>
      <span style="display:inline-flex;gap:8px;align-items:center">
        ${c.filed_siratech ? '' : `<button class="ghost" onclick="psFileConsent(${c.id}, this)">File to record</button>`}
        <a class="ghost" style="text-decoration:none" href="/api/consent/${c.id}/pdf?file=${encodeURIComponent(p.mrno || '')}" target="_blank" rel="noopener">View</a>
      </span>
    </div>`).join('');
}
async function psFileConsent(id, btn) {
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (btn) { btn.disabled = true; btn.textContent = 'Filing…'; }
  try {
    const r = await API.post(`/consent/${id}/file?file=${encodeURIComponent(p.mrno || '')}`, {});
    if (r && r.wrote) { toast('Consent filed to the patient record · رُفعت للملف'); psLoadConsents(); }
    else { toast((r && r.note) || 'Could not attach yet — it will ride the report.'); if (btn) { btn.disabled = false; btn.textContent = 'File to record'; } }
  } catch (e) {
    toast(e.message || 'Filing failed'); if (btn) { btn.disabled = false; btn.textContent = 'File to record'; }
  }
}
window.psFileConsent = psFileConsent;

// One-click document upload: create a QR the tech scans on a phone to snap/pick a
// document (outside report, referral, external lab); it's filed to the patient's
// Siratech record via the proven attachment path. Reuses the consent overlay chrome.
let _psDocPoll = null;
async function psUploadDocument() {
  const d = psState.lookup || {};
  const p = d.patient || {};
  if (!p.mrno) return;
  const top = (d.orders || []).slice().sort((a, b) => psOrderTime(b) - psOrderTime(a))[0] || {};
  let ov = document.getElementById('consent-overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'consent-overlay'; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="cn-sheet"><div class="cn-head"><div><div class="cn-title">📎 Upload document</div>
    <div class="cn-sub">${escapeHtml(p.name || p.mrno)}</div></div><button class="cn-x" onclick="psCloseDoc()">✕</button></div>
    <div class="cn-body" style="text-align:center"><div class="mini-spin"></div><p style="margin-top:10px;color:var(--muted)">Preparing link…</p></div></div>`;
  try {
    const r = await API.post('/docupload/link', {
      file_no: p.mrno, mrno: p.mrno, name: p.name || '',
      bill_no: top.billNo || null, site: top.siteId || null,
    });
    if (!r || !r.ok) throw new Error('Could not create the upload link');
    ov.querySelector('.cn-sheet').innerHTML = `
      <div class="cn-head"><div><div class="cn-title">📎 Upload document</div><div class="cn-sub">${escapeHtml(p.name || '')}</div></div>
        <button class="cn-x" onclick="psCloseDoc()">✕</button></div>
      <div class="cn-body" style="text-align:center">
        <p style="font-size:14px;font-weight:700;margin-bottom:4px">Scan with a phone to upload</p>
        <p style="font-size:12.5px;color:var(--muted);margin-bottom:14px">Snap or pick an outside report · referral · lab result</p>
        ${r.qr ? `<img src="${escapeHtml(r.qr)}" alt="QR" style="width:230px;max-width:70vw;height:auto;border:1px solid var(--border);border-radius:14px;padding:8px;background:#fff">` : ''}
        <div style="margin-top:14px;display:flex;gap:8px;align-items:center;max-width:420px;margin-inline:auto">
          <input class="input" readonly value="${escapeHtml(r.url || '')}" style="flex:1;font-size:12px" onclick="this.select()">
          <button class="btn btn-sm" onclick="consentCopyLink(this,'${escapeHtml(r.url || '')}')">Copy</button>
        </div>
        <div id="ps-doc-poll" class="cn-poll">⏳ waiting for the document…</div>
      </div>`;
    psDocStartPoll(r.id, p.mrno);
  } catch (e) {
    const b = ov.querySelector('.cn-body');
    if (b) b.innerHTML = `<div class="cn-err">${escapeHtml(e.message || 'Failed to prepare the link')}</div>`;
  }
}
function psCloseDoc() {
  if (_psDocPoll) { clearInterval(_psDocPoll); _psDocPoll = null; }
  const ov = document.getElementById('consent-overlay');
  if (ov) ov.remove();
}
function psDocStartPoll(id, mrno) {
  if (_psDocPoll) clearInterval(_psDocPoll);
  let handled = false;
  _psDocPoll = setInterval(async () => {
    if (!document.getElementById('consent-overlay')) { clearInterval(_psDocPoll); _psDocPoll = null; return; }
    try {
      const s = await API.get(`/docupload/status/${id}`);
      if (s && (s.status === 'uploaded' || s.status === 'filed') && !handled) {
        handled = true; clearInterval(_psDocPoll); _psDocPoll = null;
        const box = document.getElementById('ps-doc-poll');
        if (box) box.innerHTML = `<span class="cn-ok">✅ ${s.filed ? 'Uploaded &amp; filed to the record' : 'Uploaded — filing to the record…'}</span>`;
        psLoadDocuments();
        setTimeout(psCloseDoc, 2600);
      }
    } catch (e) {}
  }, 2500);
}
// The documents already uploaded for this patient, shown under the buttons.
async function psLoadDocuments() {
  const box = document.getElementById('ps-doc-list');
  if (!box) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno) { box.innerHTML = ''; return; }
  let d;
  try { d = await API.get(`/docupload/list?file=${encodeURIComponent(p.mrno)}`); }
  catch (e) { box.innerHTML = ''; return; }
  const docs = (d && d.documents) || [];
  if (!docs.length) { box.innerHTML = ''; return; }
  box.innerHTML = docs.map((c) => `
    <div class="ps-consent-row">
      <span>📎 ${escapeHtml(c.doc_name || 'Document')}
        <span style="color:var(--muted)">· ${escapeHtml(String(c.created_at || '').slice(0, 16).replace('T', ' '))}${c.created_by_name ? ' · ' + escapeHtml(c.created_by_name) : ''}</span>
        ${c.filed_siratech ? '<span class="pill ok" title="On the patient\'s Siratech file">📎 On file</span>' : '<span class="pill" style="opacity:.7">saved</span>'}</span>
    </div>`).join('');
}
window.psUploadDocument = psUploadDocument;

// Best-effort timestamp for sorting: prefer the order date, fall back to the report
// date. Handles ISO, dd/mm/yyyy, dd-mm-yyyy and dd-Mon-yyyy; unparseable → 0.
function psOrderTime(o) {
  return psParseDate(o && (o.orderedDate || o.reportDate));
}
function psParseDate(s) {
  if (!s) return 0;
  const str = String(s).trim();
  // ISO (YYYY-MM-DD[...]) is unambiguous — let the engine parse it. Everything else must
  // be matched EXPLICITLY first: Date.parse reads a "DD/MM/YYYY" slash date as US
  // "MM/DD/YYYY" and returns a valid (non-NaN) timestamp, silently swapping day and month.
  let t;
  if (/^\d{4}-\d{2}/.test(str) || str.includes('T')) {
    t = Date.parse(str);
    if (!isNaN(t)) return t;
  }
  let m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; t = Date.UTC(y, (+m[2]) - 1, +m[1]); if (!isNaN(t)) return t; }
  m = str.match(/^(\d{1,2})[\/\-]([A-Za-z]{3})[\/\-](\d{2,4})/);
  if (m) { t = Date.parse(`${m[1]} ${m[2]} ${m[3]}`); if (!isNaN(t)) return t; }
  // Last resort for any other engine-parseable form (e.g. "Jul 9 2026").
  t = Date.parse(str);
  return isNaN(t) ? 0 : t;
}
function psToggleExam(btn) {
  const card = btn.closest('.ps-exam');
  // State class is 'expanded', NOT 'open' — this card lives inside the .cc page
  // root, where `.cc .open` is the action-button component; a state class named
  // 'open' would restyle the whole card as a giant violet button.
  if (card) card.classList.toggle('expanded');
}

function psExamCard(o, open) {
  const imaged = o.imaged || (o.accessionNumber != null && String(o.accessionNumber).trim() !== '');
  const ris = (state, label) => `<span class="ris ${state}"><span class="rd"></span>${label}</span>`;
  const chips = [
    o.isER ? `<span class="sc no" title="Emergency encounter">🚨 ER</span>` : '',
    o.encounter && !o.isER ? `<span class="sc ok" style="background:var(--violet-wash,#F0EDFF);color:var(--accent2,#6B4EFF)">${escapeHtml(o.encounter)}</span>` : '',
    '',   // billing-status chip removed — the billed/not-billed signal wasn't reliable enough to show
    imaged ? ris('completed', 'Imaged') : ris('scheduled', 'Awaiting imaging'),
    o.hasReport ? ris('final', 'Report ready') : '',
    o.cpacsUrl ? `<a class="ghost" style="text-decoration:none" href="${escapeHtml(String(o.cpacsUrl))}" target="_blank" rel="noopener" title="Open the study in the PACS viewer" onclick="event.stopPropagation()">🖼 Images</a>` : '',
  ].filter(Boolean).join('');
  const mods = modBadges(o.modality, { fallbackCls: 'xr' });
  const day = (o.orderedDate || o.reportDate || '').toString().slice(0, 10);
  const acc = (o.accessionNumber != null && String(o.accessionNumber).trim() !== '')
    ? `<span class="acc" title="DICOM accession — the exact image↔order link">🔗 ${escapeHtml(String(o.accessionNumber))}</span>` : '';
  const repId = psRepId(o);
  return `
    <div class="card ps-exam${open ? ' expanded' : ''}">
      <button type="button" class="ps-exam-summary" onclick="psToggleExam(this)">
        <span class="ps-exam-caret">▸</span>
        <span class="ps-exam-sum-main">
          <span class="exline">${mods}<span class="proc" style="white-space:normal">${escapeHtml(o.service || '—')}</span></span>
          <span class="ps-exam-date">${day ? escapeHtml(day) : ''}${day && acc ? ' ' : ''}${acc}</span>
        </span>
        <span class="ps-exam-badges">${chips}</span>
      </button>
      <div class="ps-exam-body">
        <div class="ps-sec-l">Where it came from</div>
        <div class="ps-grid">
          ${psField('Branch', o.branch)}
          ${psField('Encounter', o.encounter)}
          ${psField('Ordering doctor', o.provider)}
          ${psField('Payer', o.payer)}
          ${psField('Ordered', o.orderedDate)}
        </div>
        <div class="ps-sec-l">Clinical</div>
        <div class="ps-grid">
          <div class="ps-field" id="${repId}-ind"${o.clinicalIndication ? '' : ' style="display:none"'}>
            <div class="ps-field-l">Indication</div>
            <div class="ps-field-v" style="color:var(--accent)">${escapeHtml(o.clinicalIndication || '—')}</div>
          </div>
          ${psField('Reason for order', o.reasonForOrder)}
          ${psField('Remarks', o.remarks)}
        </div>
        <div class="ps-sec-l">Order &amp; imaging</div>
        <div class="ps-grid">
          ${psField('Bill no', o.billNo)}
          ${psField('Order status', o.status)}
          ${psField('Accession', o.accessionNumber)}
          ${psField('Image status', o.imageStatus)}
          ${psField('Report status', o.reportStatus)}
          ${psField('Report date', o.reportDate)}
        </div>
        <div class="ps-sec-l">Report</div>
        ${o.cpacsUrl ? `<div style="margin-bottom:8px"><a class="ghost" style="text-decoration:none" href="${escapeHtml(String(o.cpacsUrl))}" target="_blank" rel="noopener">🖼 View images</a></div>` : ''}
        <div id="${repId}"><span style="color:var(--muted);font-size:12px">${(o.hasReport || imaged) ? 'Loading report…' : '⏳ Awaiting imaging — no report yet.'}</span></div>
      </div>
    </div>`;
}

function psRepId(o) {
  // MUST be unique PER EXAM, not per bill: one bill routinely bundles several exams
  // (CT Abdomen + CT Pelvis), and keying on billNo first gave every sibling the same DOM
  // id, so getElementById returned only the first node and reports loaded into the wrong
  // card / stuck. Prefer the exam-unique invPatTestResultId/accession; for un-imaged
  // siblings fall back to bill+service (distinct names) so ids still can't collide.
  const uniq = (o && (o.invPatTestResultId || o.accessionNumber))
    || (o && o.billNo ? String(o.billNo) + '_' + String((o && o.service) || '') : '')
    || Math.abs(psParseDate(o && o.orderedDate) || 0);
  return 'ps-rep-' + String(uniq).replace(/[^A-Za-z0-9_-]/g, '');
}
// Auto-load each exam's report on open — no clicking. Every report is pulled STRAIGHT
// FROM SIRATECH (FetchRadiologyReport, keyed by the exam's own invPatTestResultId), so
// there's no DePACS match and no per-file matching pass. One direct call per exam,
// through a small concurrency pool (was: ALL fired together — a 15-exam patient burst
// 15 simultaneous HIS calls on top of the card's section loads). The first exams (the
// ones on screen) still land first; the tail streams in right behind. Read-only.
async function psAutoReports(orders) {
  if (!orders || !orders.length) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno) return;
  const queue = orders.slice();
  const CONC = 3;
  const pump = async () => {
    while (queue.length) {
      const o = queue.shift();
      try { await psLoadReport(o, psRepId(o)); } catch (e) { /* per-exam best-effort */ }
    }
  };
  for (let i = 0; i < Math.min(CONC, queue.length); i++) pump();
}
// Load THIS exam's native Siratech report (radiologist · date · full text) and, when
// the structured indication is missing, fill it from the report's own CLINICAL DATA
// line. Keyed by invPatTestResultId (falls back to the DICOM accession). Read-only.
async function psLoadReport(o, elId, btn) {
  const el = document.getElementById(elId);
  if (!el) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno) { el.innerHTML = '<span style="color:var(--muted)">No file number.</span>'; return; }
  const inv = o && o.invPatTestResultId;
  const acc = o && o.accessionNumber;
  if (!o.hasReport && !o.imaged && (inv == null || inv === 0)) {
    el.innerHTML = '<span style="color:var(--muted);font-size:12px">⏳ Awaiting imaging — no report yet.</span>';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'loading…'; }
  if (!el.dataset.loaded) el.innerHTML = '<span style="color:var(--muted);font-size:12px">Loading report from Siratech…</span>';
  const qs = new URLSearchParams({ mrno: p.mrno });
  if (inv != null && String(inv) !== '' && String(inv) !== '0') qs.set('invPatTestResultId', String(inv));
  else if (acc) qs.set('accession', String(acc));
  try {
    const d = await API.get('/radiology/study?' + qs.toString());
    const txt = String((d && d.reportText) || '').trim();
    if (!txt) {
      el.innerHTML = `<div style="color:var(--muted);font-size:12px">${d && d.found ? 'Report not verified yet' : 'No report on file yet'}${d && d.status ? ' · ' + escapeHtml(String(d.status)) : ''}.</div>`;
    } else {
      el.dataset.loaded = '1';
      const who = d.verifiedBy || 'Radiologist';
      const whenRaw = d.reportDate ? String(d.reportDate).slice(0, 16).replace('T', ' ') : '';
      // Stash the report so the Print button can rebuild without refetch.
      psReportStore[elId] = { txt, who: String(who), when: whenRaw, exam: o };
      const parsed = psFormatReport(txt);
      // Verdict — Siratech's OWN stored flag when set (classSource==='siratech'), else our
      // read of the impression text. The tooltip says which, so it's never a black box.
      const cls = (d.classification || '').toLowerCase();
      const srcNote = d.classSource === 'siratech' ? 'From Siratech' : 'Read from the impression';
      const tip = escapeHtml(`${srcNote}${d.classReason ? ' · ' + d.classReason : ''}`);
      const clsBadge = cls === 'critical'
        ? `<span class="ps-rpt-cls critical" title="${tip}">🚨 Critical</span>`
        : cls === 'normal'
        ? `<span class="ps-rpt-cls normal" title="${tip}">● Normal</span>`
        : cls === 'abnormal'
        ? `<span class="ps-rpt-cls abnormal" title="${tip}">▲ Abnormal</span>`
        : '';
      el.innerHTML = `<div class="ps-rpt">
        <div class="ps-rpt-head">
          <span class="ps-rpt-who">${escapeHtml(String(who))}${whenRaw ? ` · ${escapeHtml(whenRaw)}` : ''}</span>
          <span class="ps-rpt-head-r">
            ${clsBadge}
            <button type="button" class="ps-rpt-print" onclick="event.stopPropagation();psPrintReport('${elId}',this)" title="Print the official signed report">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7" rx="1"/></svg>
              Print
            </button>
          </span>
        </div>
        <div class="ps-rpt-body">${psReportSectionsHtml(parsed)}</div>
      </div>`;
      // Backfill a missing indication from the report's own CLINICAL DATA line.
      if (!o.clinicalIndication) {
        const ind = psIndicationFromReport(txt);
        if (ind) psFillIndication(o, ind);
      }
    }
  } catch (e) {
    el.innerHTML = `<div style="color:var(--danger,#E25555);font-size:12px">${escapeHtml(e.message || 'Could not load the report')}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 Load report'; }
  }
}
// Pull the clinical indication a teleradiology report embeds, e.g.
// "CLINICAL DATA: SOB." → "SOB". Accepts CLINICAL DATA/HISTORY/INDICATION variants;
// ignores empty/"none" values.
function psIndicationFromReport(txt) {
  const m = String(txt || '').match(/\b(?:CLINICAL\s+(?:DATA|HISTORY|INDICATION)|INDICATION|CLINICAL\s+NOTES?)\s*:?\s*(.+?)(?:\n|TECHNIQUE|COMPARISON|FINDINGS|IMPRESSION|CONCLUSION|$)/i);
  let v = m ? m[1].trim().replace(/[.;\s]+$/, '').trim() : '';
  if (!v || /^(none|n\/?a|not (?:available|provided|given|specified))\.?$/i.test(v)) return '';
  return v.slice(0, 200);
}
// Reveal + fill the exam's Indication field once we've recovered it from the report.
function psFillIndication(o, ind) {
  const box = document.getElementById(psRepId(o) + '-ind');
  if (!box) return;
  o.clinicalIndication = ind;   // so a re-render keeps it
  box.style.display = '';
  const v = box.querySelector('.ps-field-v');
  if (v) v.textContent = ind;
}

// ── Report formatting ──────────────────────────────────────────────────────────
// Teleradiology reports arrive as ONE unbroken blob — the section headers are glued
// to the previous sentence (…reporting.COMPARISION: None available.CLINICAL DATA:…).
// Parse it into its standard sections so it reads like a real report instead of a wall.
const PS_RPT_HEADERS = ['TECHNIQUE', 'PROCEDURE', 'CONTRAST', 'COMPARISON', 'COMPARISION',
  'CLINICAL DATA', 'CLINICAL HISTORY', 'CLINICAL INDICATION', 'CLINICAL NOTES', 'INDICATION',
  'HISTORY', 'FINDINGS', 'IMPRESSION', 'CONCLUSION', 'RECOMMENDATIONS', 'RECOMMENDATION',
  'LIMITATIONS', 'LIMITATION'];
function psFormatReport(txt) {
  let s = String(txt || '').replace(/\r/g, '').trim();
  if (!s) return { sections: [], footer: '' };
  // Peel off the radiologist sign-off ("Reported by … Electronic Signature") — it also
  // arrives glued (…appendicitisReported by Dr.…), so no leading word-boundary.
  let footer = '';
  const sig = s.match(/Reported\s+by[\s\S]*$/i);
  if (sig) { footer = sig[0].trim(); s = s.slice(0, sig.index).trim(); }
  const kw = PS_RPT_HEADERS.map((h) => h.replace(/ /g, '\\s+')).join('|');
  const headRe = new RegExp('(' + kw + ')\\s*:', 'gi');
  const isHead = new RegExp('^(?:' + kw + ')$', 'i');
  // Mark each header, split, then peel "HEADER: body" off each chunk.
  const parts = s.replace(headRe, (m) => '\u0001' + m).split('\u0001').map((x) => x.trim()).filter(Boolean);
  const sections = [];
  for (const part of parts) {
    const m = part.match(/^([A-Za-z][A-Za-z /]*?)\s*:\s*([\s\S]*)$/);
    if (m && isHead.test(m[1].replace(/\s+/g, ' ').trim())) {
      let head = m[1].replace(/\s+/g, ' ').trim().toUpperCase();
      if (head === 'COMPARISION') head = 'COMPARISON';   // fix the vendor's common misspelling
      const body = m[2].trim();
      if (body && !/^(none|n\/?a|none\s+available|not\s+(?:available|provided))\.?$/i.test(body)) {
        sections.push({ head, body });
      } else if (body) {
        sections.push({ head, body });   // keep "None available" — it's meaningful in a report
      }
    } else {
      sections.push({ head: null, body: part });   // preamble before the first header
    }
  }
  return { sections, footer };
}
// Inline HTML for the parsed report — a labelled block per section.
function psReportSectionsHtml(parsed) {
  if (!parsed || !parsed.sections.length) {
    return `<div class="ps-rpt-plain">${escapeHtml(String((parsed && parsed.footer) || '').trim() || '—')}</div>`;
  }
  const body = parsed.sections.map((sec) => sec.head
    ? `<div class="ps-rpt-sec"><div class="ps-rpt-h">${escapeHtml(sec.head)}</div><div class="ps-rpt-t">${escapeHtml(sec.body)}</div></div>`
    : `<div class="ps-rpt-sec"><div class="ps-rpt-t">${escapeHtml(sec.body)}</div></div>`).join('');
  const foot = parsed.footer
    ? `<div class="ps-rpt-sign">${escapeHtml(psTidySignature(parsed.footer))}</div>` : '';
  return body + foot;
}
// Lightly de-glue the sign-off so names/roles aren't mashed together.
function psTidySignature(f) {
  return String(f || '')
    .replace(/\s+/g, ' ')
    .replace(/(Reported\s+by)/i, '$1 ')
    .replace(/([a-z])(Radiologist|Consultant|Specialist)/g, '$1\n$2')
    .replace(/(Radiologist|Consultant|Specialist)([A-Z])/g, '$1\n$2')
    .replace(/\s*(Call\s+Center\s*:)/i, '\n$1 ')
    .replace(/\s*(Electronic\s+Signature)/i, '\n$1')
    .replace(/ *\n */g, '\n').trim();
}

// Print THIS report. FIRST tries the OFFICIAL signed report PDF from the PACS (the real
// letterhead/logo document); if there's no verified study/PDF yet, falls back to a clean
// letterhead print built from the report text. Async: shows a "Preparing…" state.
async function psPrintReport(elId, btn) {
  const rec = psReportStore[elId];
  if (!rec) { toast('Report not loaded yet.'); return; }
  const p = (psState.lookup && psState.lookup.patient) || {};
  const o = rec.exam || {};
  // Try the official PACS PDF (with the real logo) before falling back to our print.
  if (btn) { btn.disabled = true; btn.dataset._t = btn.innerHTML; btn.innerHTML = 'Preparing…'; }
  try {
    const qs = new URLSearchParams({ mrno: p.mrno });
    if (o.invPatTestResultId != null && String(o.invPatTestResultId) !== '' && String(o.invPatTestResultId) !== '0') qs.set('invPatTestResultId', String(o.invPatTestResultId));
    else if (o.accessionNumber) qs.set('accession', String(o.accessionNumber));
    const d = await API.get('/radiology/report-pdf?' + qs.toString());
    if (d && d.found && d.pdfBase64) {
      psOpenPdfBase64(d.pdfBase64, d.filename || 'report.pdf');
      return;   // official signed PDF opened — done
    }
  } catch (e) { /* fall back to the text-built letterhead below */ }
  finally { if (btn) { btn.disabled = false; if (btn.dataset._t) btn.innerHTML = btn.dataset._t; } }
  psPrintReportFallback(elId);
}

// Open a base64 PDF in a new tab (native viewer → print), via a Blob URL.
function psOpenPdfBase64(b64, filename) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (!w) { toast('Allow pop-ups to open the report.'); URL.revokeObjectURL(url); return; }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { toast('Could not open the PDF.'); }
}

// Clean letterhead print built from the report text — the fallback when the official
// PACS PDF isn't available yet. (logo + patient/exam header + formatted sections)
function psPrintReportFallback(elId) {
  const rec = psReportStore[elId];
  if (!rec) { toast('Report not loaded yet.'); return; }
  const p = (psState.lookup && psState.lookup.patient) || {};
  const o = rec.exam || {};
  const parsed = psFormatReport(rec.txt);
  const esc = escapeHtml;
  const field = (l, v) => (v == null || String(v).trim() === '') ? ''
    : `<div class="f"><span class="fl">${esc(l)}</span><span class="fv">${esc(String(v))}</span></div>`;
  const secs = parsed.sections.map((s) => s.head
    ? `<section><h3>${esc(s.head)}</h3><p>${esc(s.body)}</p></section>`
    : `<section><p>${esc(s.body)}</p></section>`).join('');
  const sign = parsed.footer ? `<div class="sign">${esc(psTidySignature(parsed.footer)).replace(/\n/g, '<br>')}</div>` : '';
  const now = new Date();
  const printedOn = now.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Radiology Report — ${esc(p.name || '')}</title>
  <style>
    *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a1a2e;margin:0;padding:32px 34px;font-size:13px;line-height:1.55}
    .lh{display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #6B4EFF;padding-bottom:14px;margin-bottom:18px}
    .lh img{height:46px} .lh .rt{text-align:right;color:#6B4EFF;font-weight:800;font-size:15px;letter-spacing:.02em}
    .lh .rt small{display:block;color:#8a8aa0;font-weight:600;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;margin-top:2px}
    .pt{display:grid;grid-template-columns:1fr 1fr;gap:4px 26px;background:#f7f6ff;border:1px solid #e7e3ff;border-radius:10px;padding:13px 16px;margin-bottom:18px}
    .f{display:flex;gap:8px;font-size:12px;padding:1px 0} .fl{color:#8a8aa0;min-width:96px;font-weight:600} .fv{color:#1a1a2e;font-weight:600}
    .exam{font-size:16px;font-weight:800;margin:0 0 3px} .examsub{color:#8a8aa0;font-size:12px;margin-bottom:16px}
    section{margin:0 0 13px;break-inside:avoid} h3{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#6B4EFF;margin:0 0 4px;font-weight:800}
    section p{margin:0;white-space:pre-wrap} .sign{margin-top:20px;padding-top:12px;border-top:1px solid #e0e0ea;color:#444;font-size:12px;white-space:pre-line}
    .ft{margin-top:26px;padding-top:10px;border-top:1px solid #eee;color:#9a9ab0;font-size:10px;display:flex;justify-content:space-between}
    @media print{body{padding:0}@page{margin:16mm 14mm}}
  </style></head><body>
    <div class="lh"><img src="${location.origin}/meena_logo_transparent.png" alt="Meena" onerror="this.src='${location.origin}/meena_logo.png'"><div class="rt">Radiology Report<small>Meena RIS</small></div></div>
    <div class="exam">${esc(o.service || 'Radiology exam')}</div>
    <div class="examsub">${esc([o.modality, o.branch].filter(Boolean).join(' · '))}</div>
    <div class="pt">
      ${field('Patient', p.name)}
      ${field('File / MRN', p.mrno)}
      ${field('Gender', p.gender)}
      ${field('Age', p.age)}
      ${field('Ordered', o.orderedDate)}
      ${field('Accession', o.accessionNumber)}
      ${field('Ordering Dr', o.provider)}
      ${field('Reported', rec.when)}
    </div>
    ${secs || `<p>${esc(rec.txt)}</p>`}
    ${sign || `<div class="sign">${esc(rec.who)}</div>`}
    <div class="ft"><span>Printed ${esc(printedOn)}</span><span>Meena Health · Radiology</span></div>
    <script>window.onload=function(){setTimeout(function(){window.print();},250);};<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}
