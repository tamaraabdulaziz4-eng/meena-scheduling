// ── Radiology results linking (DePACS report → Siratech Result Entry) ─────────
//
// The reverse flow of the handoff: once the radiologist VERIFIES a report in
// Butterfly DePACS, we file that report back into Siratech's Radiology Result
// Entry and authorise it — WITHOUT ever landing a report on the wrong patient or
// the wrong exam. That safety guarantee is the whole point of this module, so the
// matcher is deliberately strict and refuses to guess.
//
// Endpoints (all reverse-engineered from the live Siratech SPA, proven read-only):
//   POST investigation-api /ResultEntryRadiology/RadiologySearch   -> worklist row(s)
//   POST investigation-api /ResultEntryRadiology/RadiologyDetails  -> result-entry template
//   POST investigation-api /ResultEntryRadiology/SaveRadiologyResultEntry          (WRITE)
//   POST investigation-api /ResultEntryRadiology/SaveRadiologyResultAuthorization  (WRITE)
//
// DePACS (Butterfly) side is read over its self-signed :10443 API.
//
// ── The matching gate (dual key) ──────────────────────────────────────────────
//  PRIMARY  — accession number. When the Siratech order has a generated accession
//             AND a DePACS study carries the same accession_number (or its
//             study_iuid ends with it), that is a deterministic 1:1 link. This is
//             the ideal key; it only works once the hospital populates accession
//             on arrival (today it is almost always null, so we fall back).
//  FALLBACK — same MRN + same modality (DX/CR→XR normalised) + body-part token
//             overlap between the DePACS study_desc and the Siratech serviceName
//             + a tight time window around the order date. Exactly ONE candidate
//             must survive; zero or several ⇒ ABORT and flag for manual review.
//
// Live proof (file 26289620, "XR SHOULDER" order on 2026-07-01): the patient had
// shoulder X-rays on three different dates AND a same-day humerus X-ray. Body-part
// alone left 3 candidates; body-part + time window isolated exactly one
// (study 1620407, "XR LT SHOULDER"). The humerus and the old shoulders were
// correctly rejected.

const https = require('https');

// Butterfly serves a self-signed cert; scope the leniency to its own agent only
// (never disable TLS verification globally).
const dpAgent = new https.Agent({ rejectUnauthorized: false });

const DEPACS_BASE = (process.env.DEPACS_BASE || 'https://test-api.diagnosticselite.net:10443/api/v1').replace(/\/+$/, '');
const DEPACS_USER = process.env.DEPACS_USER || '';   // set via env — no hardcoded service account
const DEPACS_PASS = process.env.DEPACS_PASS || '';

// ── small helpers ─────────────────────────────────────────────────────────────
const MOD_MAP = { DX: 'XR', CR: 'XR', DR: 'XR', XR: 'XR', CT: 'CT', MR: 'MR', MRI: 'MR', US: 'US', MG: 'MG', NM: 'NM', PT: 'PT', XA: 'XA' };
function normMod(m) {
  const s = String(m || '').toUpperCase().trim();
  if (MOD_MAP[s]) return MOD_MAP[s];
  // The Siratech category can be a label ("GENERAL X-RAY", "ULTRASOUND") rather than
  // a DICOM code — map those too, else a legitimate report would never match.
  // \bXR\b covers exam names that carry the modality as a prefix — "XR - TMJ JOINTS",
  // "XR LUMBO SACRAL SPINE". Without it these (the most common exams) never classify,
  // so the board's ready-pass can't match their study and the row stays stuck on
  // "Scheduled" even after the report is signed. DX/CR/DR are the DICOM XR codes.
  if (/\bXR\b|X-?RAY|RADIOGRAPH|\bDX\b|\bCR\b|\bDR\b/.test(s)) return 'XR';
  if (/ULTRA\s?SOUND|SONOGRA(M|PHY)|\bUS\b/.test(s)) return 'US';
  // COMPUT\w* covers the British "COMPUTERISED TOMOGRAPHY" spelling Siratech uses in its formal
  // service names (e.g. "SPIRAL ANGIOGRAPHY BY COMPUTERISED TOMOGRAPHY OF …"), not just "COMPUTED".
  if (/\bCT\b|COMPUT\w*\s+TOMOG/.test(s)) return 'CT';
  if (/\bMRI?\b|MAGNETIC\s+RES/.test(s)) return 'MR';
  if (/MAMMOG|\bMG\b/.test(s)) return 'MG';
  // DEXA / bone-density → BMD (the DICOM modality DePACS uses, e.g. "DXA EXAM" with modality "BMD").
  // Classifying the order the same way lets a DEXA order match its BMD study — DEXA studies DO reach
  // this PACS, so they can be confirmed done instead of always reading "unverifiable".
  if (/DEXA|\bDXA\b|\bBMD\b|BONE\s*MIN|BONE\s*DENSIT|DENSITOM/.test(s)) return 'BMD';
  // "Paranasal Sinus" with NO modality word is a plain X-ray at these centers (confirmed by the
  // operators). Placed AFTER the CT/MR checks, so an explicit "CT Paranasal Sinus" still reads CT.
  if (/PARANASAL/.test(s)) return 'XR';
  return s;
}

// Anatomy tokens describe the *body part*: strip modality / view / generic filler.
// Laterality (left/right) is handled SEPARATELY (see sideOf) — it must never be
// silently discarded, or "XR LT SHOULDER" would match "XR RT SHOULDER".
const STOP = new Set(['XR', 'CT', 'MR', 'MRI', 'US', 'THE', 'AND', 'VIEW', 'VIEWS', 'VIEWS.', 'AP',
  'PA', 'LAT', 'LATERAL', 'OBLIQUE', 'LT', 'RT', 'LEFT', 'RIGHT', 'BILATERAL', 'BILAT', 'BOTH',
  'WITH', 'WITHOUT', 'CONTRAST', 'SERIES', 'STUDY', 'SCAN', 'PLAIN', 'ROUTINE', 'PORTABLE',
  'MIN', 'STANDING', 'ERECT', 'SUPINE', 'ONE', 'TWO', 'THREE']);
// Canonicalise common radiology short-hand so a terse DePACS desc lines up with
// the verbose Siratech order. Applied to BOTH sides, so it only unifies wording —
// the unique/subset/modality/time gate still decides the match, nothing is loosened.
// Crucial for this DePACS instance, where the study description is a stub like
// "X L.SPNE" / "T SPINE" / "ABD" (and the single-letter region L/T/C would
// otherwise be dropped by the >2-char filter and lose the lumbar-vs-thoracic key).
function expandAnat(s) {
  let t = ' ' + String(s || '').toUpperCase().replace(/[^A-Z]/g, ' ').replace(/\s+/g, ' ') + ' ';
  t = t
    .replace(/\bLUMBO\s?SACRAL\b/g, ' LUMBAR SPINE ')
    .replace(/\bLUMBOSACRAL\b/g, ' LUMBAR SPINE ')
    .replace(/\bLUMBO\b/g, ' LUMBAR ')
    .replace(/\bL\s?S\s?SP?I?NE?\b/g, ' LUMBAR SPINE ')   // LS SPINE / LSSPINE
    .replace(/\bL\s?SP?I?NE?\b/g, ' LUMBAR SPINE ')       // L SPNE / L SPINE / LSPINE
    .replace(/\bT\s?SP?I?NE?\b/g, ' THORACIC SPINE ')     // T SPINE / TSPINE
    .replace(/\bD\s?SP?I?NE?\b/g, ' THORACIC SPINE ')     // D SPINE (dorsal)
    .replace(/\bDORSAL\b/g, ' THORACIC ')
    .replace(/\bC\s?SP?I?NE?\b/g, ' CERVICAL SPINE ')     // C SPINE / CSPINE
    .replace(/\bSPNE\b/g, ' SPINE ')
    .replace(/\bABDO?\b/g, ' ABDOMEN ')                   // ABD / ABDO
    .replace(/\bCXR\b/g, ' CHEST ');
  return t;
}
function bodyTokens(s) {
  return [...new Set(expandAnat(s).split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w)))];
}

// Laterality of an exam name → 'L' | 'R' | 'B' | null. Only whole-word matches
// (so "RIB" is never read as right, "SILVER" never as left).
function sideOf(s) {
  const raw = String(s || '').toUpperCase();
  const words = raw.replace(/[^A-Z ]/g, ' ').split(/\s+/);
  let l = false, r = false, b = false;
  for (const w of words) {
    if (w === 'LEFT' || w === 'LT') l = true;
    else if (w === 'RIGHT' || w === 'RT') r = true;
    else if (w === 'BILATERAL' || w === 'BILAT' || w === 'BOTH') b = true;
  }
  // This DePACS instance also uses a compact "R."/"L." laterality prefix for
  // EXTREMITIES ("X R.KNEE", "L.SHOULDER"). Read it so a right-knee study can't
  // pass the side gate against a left-knee order. `L.` is overloaded — it also
  // means LUMBAR for the spine ("X L.SPNE") — so treat `L.` as "left" ONLY when it
  // is NOT immediately a spine token (SP…). `R.` is unambiguous (no spine region R).
  if (/\bR\.\s*[A-Z]/.test(raw)) r = true;
  if (/\bL\.\s*(?!SP)[A-Z]/.test(raw)) l = true;
  if (b || (l && r)) return 'B';
  if (l) return 'L';
  if (r) return 'R';
  return null;
}

// The DePACS `accession_number` field is a deterministic key ONLY when it holds a real
// accession CODE (e.g. "SIRA2245", a barcode-like alphanumeric). On this instance the
// modality sometimes puts the BODY-PART TEXT there instead ("T SPINE", "X L.SPNE") —
// which is NOT unique, so matching on it would file an unrelated study's report onto a
// new exam. Only accept: a SIRA-prefixed number, a short-alpha-then-digits code, or pure
// digits — never anything with a space/dot/other punctuation (that's body-part text).
function cleanAccession(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || /[\s.]/.test(s)) return null;
  if (/^sira[-_]?\d{2,}$/i.test(s)) return s;
  if (/^[A-Za-z]{0,6}\d{3,}$/.test(s)) return s;   // ACC12345 / 20250705 / 1629836
  return null;
}

// A study carries a FINAL, fileable report when its status is any of these. This
// mirrors server/main.py `_study_is_reported` so the forward flow's notion of
// "report ready" and the reverse flow's matcher agree on the SAME set of studies.
// Butterfly emits several terminal labels for a signed report (VERIFIED on this
// instance today, but APPROVED / SIGNED / COMPLETED / FINAL elsewhere and after
// addenda); keying the matcher strictly on the single word "VERIFIED" silently
// drops a freshly-signed study, and the matcher then reports "no candidate" for a
// report that is plainly ready — the exact review-needed symptom seen in the field.
const REPORTED_STATUS = /\b(VERIFIED|APPROVED|SIGNED|COMPLETED|REVIEWED|ADDENDUM|FINAL)\b/;
// A whitelist word alone isn't enough: "NOT VERIFIED" / "UN-SIGNED" / "PENDING FINAL"
// all contain a positive token but describe a DRAFT that must NEVER be filed. Reject
// any status carrying a negation/draft marker FIRST (purely additive — a plain
// "VERIFIED" still passes), so the auto-filer can't push an unsigned report.
// Also reject the "not-quite-final" pre-states that carry a positive token but are
// NOT a signed report: NON-VERIFIED, "TO BE VERIFIED", PARTIALLY VERIFIED.
const NOT_REPORTED = /\bNOT\b|\bNON[\s-]?(VERIFIED|SIGNED|APPROVED|REPORTED|REVIEWED|COMPLETE)|\bTO\s+BE\b|\bPARTIAL|\bPENDING\b|\bPRELIM|\bDRAFT\b|\bAWAIT|\bINCOMPLETE\b|IN[\s-]?PROGRESS|UN-?(VERIFIED|SIGNED|APPROVED|REVIEWED|COMPLETED)/;
function isReported(status) {
  const s = String(status || '').toUpperCase();
  if (NOT_REPORTED.test(s)) return false;
  return REPORTED_STATUS.test(s);
}

// A report EXISTS but is not yet signed — dictated/draft/awaiting verification. The
// board shows these distinctly ("Report not verified") so the operator can tell
// "images done, radiologist mid-report" apart from "images done, nothing written
// yet" and from a signed report. NEVER used for filing decisions (isReported guards
// that); display only.
function isDraftReport(status) {
  const s = String(status || '').toUpperCase();
  if (!s || isReported(s)) return false;
  if (/(DRAFT|PRELIM|DICTAT|TRANSCRIB|INTERIM|\bPARTIAL)/.test(s)) return true;
  // a verification word in a negated/pending form: "NOT VERIFIED", "TO BE SIGNED",
  // "PENDING APPROVAL", "UN-VERIFIED" — a report is in flight, not absent.
  return /(VERIF|SIGN|APPROV|REPORT)/.test(s)
      && /(\bNOT\b|\bNON\b|TO\s+BE|\bPEND|\bAWAIT|\bUN[\s-]?)/.test(s);
}

// The file-number (MRN) equality test used as the first match gate. DePACS is
// inconsistent about pat_id and stores it three ways:
//   • the bare MRN                     — "26336282"
//   • the MRN with the name glued on   — "26336282ELAZIM, WAEL"
//   • the MRN behind a source prefix   — "SIRA26336282" (the SIRA imaging/accession
//                                         workflow prepends its own tag)
// So match the MRN wherever it appears as a WHOLE number — with \d boundaries so a
// longer or different file number ("263362820", "126336282") can never masquerade
// as this one, and a name/prefix around it never blocks a legitimate match.
function sameMrn(patId, mrno) {
  const pid = String(patId == null ? '' : patId).trim();
  const m = String(mrno == null ? '' : mrno).trim();
  if (!pid || !m) return false;
  if (pid === m) return true;
  const esc = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?<!\\d)' + esc + '(?!\\d)').test(pid);
}

// ── DePACS (Butterfly) client ─────────────────────────────────────────────────
// DePACS serves a self-signed cert, so we must talk to it with an https.Agent
// that has rejectUnauthorized:false. Node 22's global fetch() is undici, which
// SILENTLY IGNORES the `agent` option (it wants `dispatcher`), so the TLS bypass
// never applied and every call failed cert verification. Go through the https
// module directly, which honours `agent` — and get a request timeout for free.
function dpRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body !== undefined && body !== null ? Buffer.from(body) : null;
    const opts = {
      method, agent: dpAgent,
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: { ...headers },
    };
    if (payload) opts.headers['Content-Length'] = payload.length;
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('DePACS request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function dpFetch(path, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = 'Token ' + token;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await dpRequest(DEPACS_BASE + path, { method, headers, body: payload });
  const text = res.buffer.toString('utf8');
  let json; try { json = JSON.parse(text); } catch (_e) { json = null; }
  return { status: res.status, json, text };
}

// Pull the bearer token out of a DePACS signin response, trying every shape the API
// has been seen to use (the token key/path varies by build), so a cosmetic response
// change can't silently break every DePACS feature.
function _extractDpToken(json) {
  if (!json || typeof json !== 'object') return null;
  const b = json.body || json.data || json.result || json;
  return (b && (b.access_token || b.accessToken || b.token || b.authToken || b.jwt))
    || json.access_token || json.token || null;
}
let dpTok = { token: '', ts: 0 };
async function dpToken(force = false) {
  if (!force && dpTok.token && Date.now() - dpTok.ts < 20 * 60 * 1000) return dpTok.token;
  const r = await dpFetch('/auth/signin', { method: 'POST', body: { identifier: DEPACS_USER, password: DEPACS_PASS, device_id: DEPACS_USER + '_meena', platform: 'web' } });
  const token = _extractDpToken(r.json);
  if (!token) {
    const msg = (r.json && (r.json.message || r.json.error || (r.json.body && r.json.body.message))) || '';
    throw new Error('DePACS signin failed (HTTP ' + r.status + (msg ? ' — ' + String(msg).slice(0, 120) : ' — no token in response') + ')');
  }
  dpTok = { token, ts: Date.now() };
  return token;
}
// Read-only diagnostic: what does signin actually return? Never exposes the password
// or the full token — just enough to tell "wrong credentials" from "token moved".
async function depacsSigninDebug() {
  const r = await dpFetch('/auth/signin', { method: 'POST', body: { identifier: DEPACS_USER, password: DEPACS_PASS, device_id: DEPACS_USER + '_meena', platform: 'web' } });
  const tok = _extractDpToken(r.json);
  const shape = (o, d) => (o && typeof o === 'object' && d > 0)
    ? Object.fromEntries(Object.keys(o).slice(0, 30).map((k) => [k, (o[k] && typeof o[k] === 'object') ? shape(o[k], d - 1) : (/token|jwt|password/i.test(k) ? '<hidden:' + typeof o[k] + '>' : o[k])])) : o;
  return {
    base: DEPACS_BASE, user: DEPACS_USER, userSet: !!DEPACS_USER, passSet: !!DEPACS_PASS,
    httpStatus: r.status, tokenFound: !!tok,
    message: (r.json && (r.json.message || r.json.error || (r.json.body && r.json.body.message))) || null,
    responseShape: shape(r.json, 3),
  };
}

// DePACS stores pat_id three ways (bare MRN, MRN+name, or a "SIRA"+MRN prefix).
// get_studies substring-matches, so a bare search usually finds all forms — but we
// search every candidate form and merge (deduped) so the reverse flow is exactly as
// robust as the forward reports lookup. The file-number GATE in matchStudy still
// filters out any study that isn't truly this patient's, so extra forms are safe.
function _fileCandidates(mrno) {
  const s = String(mrno == null ? '' : mrno).trim();
  const out = [];
  const add = (x) => { x = String(x || '').trim(); if (x && !out.includes(x)) out.push(x); };
  add(s);
  const m = s.match(/^\s*sira[\s\-_:]*(.+)$/i);      // strip a leading SIRA (+ separators)
  const bare = m ? m[1].trim() : s;
  add(bare);
  if (/^\d+$/.test(bare)) add('SIRA' + bare);        // a plain file number → also the SIRA-prefixed form
  return out;
}

// Short-TTL cache for the LIGHT stage-check lookups (worklist imaged/reported pass).
// The board re-checks every patient on load and on each 45s refresh; without this,
// every pass re-queries DePACS for each patient's whole study history — the source
// of the "lag" on the imaged/reported badges. Only light lookups are cached (a
// recent, small window); the filing matcher's full-history lookups are never cached
// (correctness-critical). TTL is short so a just-arrived study still surfaces fast.
const _lightCache = new Map();   // mrno -> { ts, data }
// 60s — longer than the 45s UI poll, so the steady board actually reuses the cached
// stage lookup instead of re-querying DePACS for every patient on each refresh.
const DEPACS_LIGHT_TTL = Number(process.env.DEPACS_LIGHT_TTL_MS || 60000);
// How far back the light stage-check looks. The live board only shows recent orders,
// and a study for such an order is dated near it — so a wide window just pages through
// years of irrelevant history. 120 days covers any realistic board range with slack.
const DEPACS_LIGHT_DAYS = Number(process.env.DEPACS_LIGHT_DAYS || 120);

// All studies for an MRN (across pat_id forms), enriched with the report description
// (which the list endpoint leaves blank — it lives in the per-study report info).
async function depacsStudies(mrno, opts = {}) {
  // Serve a fresh light lookup from cache (huge win for the worklist stage pass).
  const cacheKey = String(mrno == null ? '' : mrno).trim();
  if (opts.light && !opts.noCache) {
    const e = _lightCache.get(cacheKey);
    if (e && Date.now() - e.ts < DEPACS_LIGHT_TTL) return e.data;
  }
  let token = await dpToken();
  // Narrow the date window for light stage checks: fetch only recent studies (a
  // patient's 10-year history is irrelevant to whether TODAY's order is imaged), so
  // most patients come back in a single page instead of many.
  const startDate = opts.light
    ? new Date(Date.now() - DEPACS_LIGHT_DAYS * 864e5).toISOString().slice(0, 10)
    : '2015-01-01';
  const qs = (page, pid) => `/study/get_studies?start_date=${startDate}&end_date=2035-12-31&page_size=100&current_page=${page}&patient_id=${encodeURIComponent(pid)}`;
  const fetchPage = async (page, pid) => {
    let r = await dpFetch(qs(page, pid), { token });
    if (r.status === 401) { token = await dpToken(true); r = await dpFetch(qs(page, pid), { token }); }  // token lapsed → refresh once
    if (!r || (r.status && r.status >= 400) || r.json == null) {
      throw new Error(`DePACS study lookup failed (HTTP ${r ? r.status : 'unreachable'})`);
    }
    return (r.json && r.json.body && r.json.body.data) || [];
  };
  // Page through ALL studies per candidate form, merged and deduped by study_id.
  const seen = new Set(), rows = [];
  let lastErr = null, anyOk = false;
  for (const pid of _fileCandidates(mrno)) {
    try {
      for (let page = 1; page <= 20; page++) {       // hard cap 2000 studies per form
        const batch = await fetchPage(page, pid);
        anyOk = true;
        for (const s of batch) { if (!seen.has(s.study_id)) { seen.add(s.study_id); rows.push(s); } }
        if (batch.length < 100) break;               // last page
      }
    } catch (e) { lastErr = e; }                      // one form's blip must not abort the others
  }
  // Surface a real outage (never an empty list) only if EVERY form failed.
  if (!anyOk && lastErr) throw lastErr;
  // The per-study report-info lookup (only needed when study_desc is blank) used to
  // run ONE AT A TIME — and on this instance study_desc is blank on MOST studies, so
  // a patient with 20 studies cost 20 sequential DePACS round-trips; the worklist
  // stage pass (many patients) multiplied that into minutes of shimmer. Run it with
  // bounded concurrency instead; order is preserved by index.
  const out = new Array(rows.length);
  let nextIdx = 0;
  const worker = async () => {
    for (;;) {
      const i = nextIdx++;
      if (i >= rows.length) return;
      const s = rows[i];
      let desc = s.study_desc || '';
      // light mode (stage checks): status/modality/date are enough — skip the
      // per-study report-info round-trip that only recovers a blank description.
      if (!desc && !opts.light) {
        const info = await dpFetch('/report/get_study_report_info/' + s.study_id, { token });
        desc = (info.json && info.json.body && info.json.body.study_desc) || '';
      }
      // This DePACS instance often leaves study_desc blank and puts the description
      // in the accession_number field ("X L.SPNE", "T SPINE"). Use it as the body-part
      // source when desc is empty — it only feeds the (still strict) body-part match.
      if (!desc && s.accession_number) desc = String(s.accession_number);
      out[i] = {
        studyId: s.study_id, iuid: s.study_iuid, modality: s.modality, desc,
        studyDate: s.study_date, status: s.study_status, patName: s.pat_name, patId: s.pat_id,
        // Only the REAL DICOM accession is a deterministic key. The study-UID's last
        // arc is NOT the accession, and this instance often puts body-part text in the
        // field — cleanAccession() keeps only a genuine accession code, else null, so a
        // non-unique value can never drive the primary match (wrong-study bind).
        accession: cleanAccession(s.accession_number),
      };
    }
  };
  await Promise.all(new Array(Math.max(1, Math.min(6, rows.length))).fill(0).map(worker));
  if (opts.light && !opts.noCache) {
    _lightCache.set(cacheKey, { ts: Date.now(), data: out });
    if (_lightCache.size > 800) _lightCache.delete(_lightCache.keys().next().value);
  }
  return out;
}

// ── BULK study fetch (whole-board worklist stage pass) ────────────────────────────────────
// The per-patient depacsStudies() is right for opening ONE card, but the worklist ran it for
// EVERY patient (~200+) → ~2 min on the small box. DePACS's get_studies takes a date window
// with NO patient_id, so ONE paged sweep returns every recent study on the branch; we then
// match orders to studies locally. Turns ~200 round-trips into a handful. status+modality+date
// only (light) — same fields the stage matcher needs. Cached briefly, keyed by the window.
const _bulkCache = new Map();   // 'start|end' -> { ts, data }
const DEPACS_BULK_TTL = Number(process.env.DEPACS_BULK_TTL_MS || 45000);
const DEPACS_BULK_MAX_PAGES = Number(process.env.DEPACS_BULK_MAX_PAGES || 60);   // 60*100 = 6000 studies cap
async function depacsRecentStudies({ startDate, endDate, noCache = false } = {}) {
  const start = startDate || new Date(Date.now() - DEPACS_LIGHT_DAYS * 864e5).toISOString().slice(0, 10);
  const end = endDate || '2035-12-31';
  const key = `${start}|${end}`;
  if (!noCache) { const e = _bulkCache.get(key); if (e && Date.now() - e.ts < DEPACS_BULK_TTL) return e.data; }
  let token = await dpToken();
  const qs = (page) => `/study/get_studies?start_date=${start}&end_date=${end}&page_size=100&current_page=${page}`;
  const fetchPage = async (page) => {
    let r = await dpFetch(qs(page), { token });
    if (r.status === 401) { token = await dpToken(true); r = await dpFetch(qs(page), { token }); }
    if (!r || (r.status && r.status >= 400) || r.json == null) {
      throw new Error(`DePACS bulk study lookup failed (HTTP ${r ? r.status : 'unreachable'})`);
    }
    return (r.json && r.json.body && r.json.body.data) || [];
  };
  const seen = new Set(), out = [];
  for (let page = 1; page <= DEPACS_BULK_MAX_PAGES; page++) {
    const batch = await fetchPage(page);
    for (const s of batch) {
      if (seen.has(s.study_id)) continue;
      seen.add(s.study_id);
      out.push({
        studyId: s.study_id, iuid: s.study_iuid, modality: s.modality,
        desc: s.study_desc || (s.accession_number ? String(s.accession_number) : ''),
        studyDate: s.study_date, status: s.study_status, patName: s.pat_name, patId: s.pat_id,
        accession: cleanAccession(s.accession_number),
      });
    }
    if (batch.length < 100) break;   // last page
  }
  if (!noCache) {
    _bulkCache.set(key, { ts: Date.now(), data: out });
    if (_bulkCache.size > 20) _bulkCache.delete(_bulkCache.keys().next().value);
  }
  return out;
}

// A verified report is FINAL — its text + PDF don't change — so cache it, and fetch the
// report-info and the PDF CONCURRENTLY (they're independent) instead of one-after-another.
// Called from three paths (peer review, file-plan, results/file), so the cache also
// dedupes re-opens of the same study. Short TTL keeps it fresh enough for a late addendum.
const _reportCache = new Map();   // studyId -> { ts, data }
const REPORT_CACHE_TTL = Number(process.env.DEPACS_REPORT_TTL_MS || 300000);
async function depacsReport(studyId) {
  const key = String(studyId);
  const hit = _reportCache.get(key);
  if (hit && Date.now() - hit.ts < REPORT_CACHE_TTL) return hit.data;
  const token = await dpToken();
  const [info, pdfRes] = await Promise.all([
    dpFetch('/report/get_study_report_info/' + studyId, { token }),
    dpRequest(DEPACS_BASE + '/report/open_report_pdf/' + studyId + '?style=2', { headers: { Authorization: 'Token ' + token } }),
  ]);
  const b = (info.json && info.json.body) || {};
  const text = String(b.report_content || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const pdfBuf = pdfRes.buffer;
  const isPdf = pdfBuf.slice(0, 5).toString() === '%PDF-';
  const data = {
    reportId: b.report_id || null, patName: b.pat_name || '',
    reportText: text, reportDate: b.report_date || b.verification_date || null,
    reviewer: b.reviewer_name || null,
    pdfBase64: isPdf ? pdfBuf.toString('base64') : null, pdfBytes: pdfBuf.length, pdfOk: isPdf,
  };
  // Only cache a real, complete report (avoid pinning a transient miss).
  if (text || isPdf) {
    _reportCache.set(key, { ts: Date.now(), data });
    if (_reportCache.size > 500) _reportCache.delete(_reportCache.keys().next().value);
  }
  return data;
}

// ── the strict matcher ────────────────────────────────────────────────────────
// order: { mrno, serviceName, categoryName, orderDate(ISO), accession? }
// Returns { decision:'unique'|'none'|'ambiguous', study?, candidates[], reason }
function matchStudy(order, studies, { windowBeforeH = 24, windowAfterH = 96 } = {}) {
  const orderMod = normMod(order.categoryName || order.modality);
  const orderAnat = bodyTokens(order.serviceName);
  const orderSide = sideOf(order.serviceName);
  // A present-but-UNPARSEABLE orderDate must normalise to null, not NaN — otherwise
  // dateKnown (below) reads true, every study falls outside the time window, and a real
  // match is wrongly routed as "no match" instead of "order date unknown → manual review".
  const _ot = order.orderDate ? new Date(order.orderDate).getTime() : null;
  const orderTime = Number.isFinite(_ot) ? _ot : null;
  // Only a CLEAN accession may drive the deterministic primary key — a body-part-text
  // "accession" must fall through to the strict modality+body-part+time fuzzy gate.
  const orderAcc = cleanAccession(order.accession);

  // GATE 0 — the file number (MRN) is the FIRST, non-negotiable key: a study may
  // only ever bind to an order for the SAME patient file. DePACS is inconsistent
  // here (pat_id is sometimes the bare MRN "25097956", sometimes the MRN with the
  // name glued on: "25097956ELAZIM, WAEL"), so we require the MRN as a clean
  // prefix rather than exact equality — but a different patient can never match.
  const fileStudies = studies.filter((s) => sameMrn(s.patId, order.mrno));
  if (order.mrno && !fileStudies.length) {
    return { decision: 'none', key: 'file', candidates: [], reason: `no VERIFIED study found for file ${order.mrno}` };
  }

  const verified = fileStudies.filter((s) => isReported(s.status));

  // PRIMARY: accession (deterministic) — only on the REAL DICOM accession.
  if (orderAcc) {
    const hits = verified.filter((s) => s.accession && String(s.accession).trim() === orderAcc);
    if (hits.length === 1) return { decision: 'unique', key: 'accession', study: hits[0], candidates: hits.map(candOf), reason: `accession ${orderAcc}` };
    if (hits.length > 1) return { decision: 'ambiguous', key: 'accession', candidates: hits.map(candOf), reason: `${hits.length} studies share accession ${orderAcc}` };
    // no accession hit → fall through to body-part+time (do not fail outright)
  }

  // FALLBACK: modality + body-part (subset, side-aware) + time window.
  // Without a reliable order date we CANNOT confirm the study is the recent one,
  // so we refuse to call it unique — a stale prior study must not auto-match.
  const dateKnown = orderTime != null;
  const scored = verified.map((s) => {
    const stAnat = bodyTokens(s.desc);
    const stSide = sideOf(s.desc);
    const overlap = orderAnat.filter((t) => stAnat.includes(t));
    // The DePACS desc is usually terser than the order ("XR LT SHOULDER" vs
    // "XR SHOULDER / SCAPULA 3 VIEWS"), so we require the STUDY's anatomy to be a
    // subset of the ORDER's: the study must not introduce a DIFFERENT region. This
    // matches the terse study to the verbose order, yet still rejects
    // "CERVICAL SPINE" against a "LUMBAR SPINE" order (CERVICAL ∉ order).
    const anatOk = stAnat.length > 0 && orderAnat.length > 0 && stAnat.every((t) => orderAnat.includes(t));
    // laterality: reject only an EXPLICIT conflict (both sides named and different).
    const sideOk = !(orderSide && stSide && orderSide !== stSide);
    const modOk = normMod(s.modality) === orderMod;
    let inWindow = false;
    if (dateKnown && s.studyDate) {
      const gap = new Date(s.studyDate).getTime() - orderTime;
      inWindow = gap >= -windowBeforeH * 3600e3 && gap <= windowAfterH * 3600e3;
    }
    return { study: s, modOk, anatOk, sideOk, bodyOverlap: overlap, inWindow };
  });

  const survivors = scored.filter((c) => c.modOk && c.anatOk && c.sideOk && c.inWindow);
  const candidates = scored
    .filter((c) => c.modOk && (c.anatOk || c.bodyOverlap.length))
    .map((c) => ({ ...candOf(c.study), bodyMatch: c.bodyOverlap, inWindow: c.inWindow }));

  if (survivors.length === 1) return { decision: 'unique', key: 'bodypart+time', study: survivors[0].study, candidates, reason: `body-part [${orderAnat.join(',')}]${orderSide ? ' ' + orderSide : ''} within time window` };
  if (survivors.length > 1) return { decision: 'ambiguous', key: 'bodypart+time', candidates, reason: `${survivors.length} studies matched — refusing to guess` };
  if (!dateKnown) return { decision: 'none', key: 'bodypart+time', candidates, reason: 'order date unknown — cannot confirm timing; manual review' };
  return { decision: 'none', key: 'bodypart+time', candidates, reason: 'no VERIFIED study matched modality + body-part + time window' };
}

function candOf(s) {
  return { studyId: s.studyId, desc: s.desc, studyDate: s.studyDate, modality: s.modality, accession: s.accession, iuid: s.iuid };
}

// ── Siratech Result Entry (needs the shared hisFetch from server.js) ──────────
// The RadiologySearch body schema (field types matter: empId is a STRING,
// invCategoryId is nullable-decimal, visiType is int).
function radiologySearchBody({ mrno = '', billno = '', hospitalId = 1, empId, filterResult = '0',
  fromDate = '1900-01-01T00:00:00.000Z', toDate = '2035-12-31T23:59:59.000Z',
  selectionType = 1, isFrequent = null, baseInvCategoryId = 2 }) {
  const body = {
    mrno, billno, fromDate, toDate,
    baseCatgeory: 0, hospitalId, mode: 6, cpoeStatus: 0, isbilled: 0, empId: String(empId),
    visitno: '', selectionType, filterResult, profileId: '', invCategoryId: null,
    // 2 = radiology, 1 = laboratory (same investigation-api, different base category).
    baseInvCategoryId, visitMode: '', invMastServiceId: 0, sampleNo: '',
    isCreditWithoutBilling: 0, cpoeSearchGroupMode: 0, searchType: 'B', visiType: '0',
  };
  // The RESULTED list (Siratech's own "auth search", captured live 2026-07-05) differs
  // from the pending list only by: filterResult "2", selectionType 2, isFrequent 1.
  if (isFrequent != null) body.isFrequent = isFrequent;
  return body;
}

// ── Normal vs. abnormal classification ────────────────────────────────────────
// DePACS stores NO structured normal/abnormal flag — `category` is a study group
// ("Others"), and critical_result.critical_classification only marks CRITICAL
// findings. The verdict lives only in the free-text report's IMPRESSION section.
// So we read that section and classify, biasing to ABNORMAL when unclear (labelling
// a normal study abnormal only triggers a harmless review; the reverse could hide
// real pathology). The caller can always override the result explicitly.
const _NORMAL_IMPRESSION = /(normal study|unremarkable (study|examination|abdomen|chest|appearance|scan)|within normal limits|no (significant |radiographic |acute )?abnormalit|no abnormal finding|negative (study|examination)|study is normal|essentially normal|no evidence of (acute |significant )?(disease|abnormalit|patholog)|normal\b[a-z /]{0,40}?\b(exam|examination|study|ultrasound|sonograph|radiograph|scan|appearance|series))/;
const _ABNORMAL_TERMS = /(calcul|stone|mass\b|lesion|fracture|scolio|spondyl|osteophy|retrolisthes|hernia|effusion|consolidat|nodul|cyst|dilat|stenos|opacit|collection|hydronephros|o?edema|h(a)?emorrhage|infiltrat|deformity|degener|tear\b|rupture|thromb|aneurysm|metasta|tumou?r|enlarged|thicken|narrow|gravel|distension|inflamm|abscess|fibroid|polyp|obstruct|occlus|ischem|infarct|fatty (liver|infiltration)|steatos)/;

// Siratech's OWN stored verdict for a radiology result, when it's set. The result-entry
// row / report DTO carries a numeric range (0 normal · 1 abnormal · 2 critical/panic ·
// 3 N/A) and/or isNotNormal / isPanic flags. We trust a POSITIVE signal (abnormal/critical)
// as authoritative; a 0/normal is unreliable here (teleradiology reports are free text and
// usually leave the range at its 0 default), so the caller falls back to reading the
// impression for those. Returns {range,src} or null when nothing is set. `objs` = any of
// the report DTO, its per-test detail rows, or the FetchRadiologyDetails row.
function sirResultRange(...objs) {
  const cands = [];
  for (const o of objs) {
    if (!o) continue;
    if (Array.isArray(o)) cands.push(...o);
    else cands.push(o);
  }
  let sawNormal = false;
  for (const o of cands) {
    if (!o || typeof o !== 'object') continue;
    // explicit panic / critical flag
    for (const k of ['isPanic', 'isCritical', 'panic', 'critical']) {
      if (o[k] != null && Number(o[k]) > 0) return { range: 'critical', src: k };
    }
    // numeric range code
    for (const k of ['stringRange', 'resultRange', 'invRange', 'rangeCode']) {
      const v = o[k];
      if (v != null && v !== '' && Number.isFinite(Number(v))) {
        const n = Number(v);
        if (n === 2) return { range: 'critical', src: k };
        if (n === 1) return { range: 'abnormal', src: k };
        if (n === 0) sawNormal = true;
      }
    }
    // explicit abnormal flag
    for (const k of ['isNotNormal', 'isAbnormal', 'abnormal']) {
      if (o[k] != null && Number(o[k]) > 0) return { range: 'abnormal', src: k };
    }
  }
  return sawNormal ? { range: 'normal', src: 'range=0' } : null;
}

function classifyRange(reportText) {
  const text = String(reportText || '');
  // Isolate the radiologist's verdict; fall back to the whole report if unlabelled.
  const m = text.match(/\b(IMPRESSION|CONCLUSION|OPINION)\s*:?\s*([\s\S]*)$/i);
  const impression = (m ? m[2] : text).replace(/\s+/g, ' ').trim();
  const imp = impression.toLowerCase();
  // Strip NEGATED clauses before hunting for pathology, so "no fracture", "without
  // effusion", "free of lesions" don't read as positive findings. We cut from the
  // negation cue up to the next clause boundary. The normal-statement test runs on
  // the ORIGINAL text (so "no abnormality" still counts as a normal verdict).
  const impPos = imp.replace(/\b(no|without|free of|negative for|absence of|rule out|r\/o|resolved|unremarkable)\b[^.,;:]*/g, ' ');
  const hasFinding = _ABNORMAL_TERMS.test(impPos);
  const saysNormal = _NORMAL_IMPRESSION.test(imp);
  // A verdict that RULES OUT pathology and leaves nothing positive behind is NORMAL,
  // even when the exact phrase isn't pre-listed — e.g. "No evidence of DVT", "Negative
  // for pulmonary embolism", "No focal lesion". Requires: no positive finding survived
  // the negation strip (hasFinding false) AND a ruling-out cue is present. EXCLUDES
  // "no CHANGE / interval / stable / known / residual", which mean a known finding
  // PERSISTS (that stays abnormal), and excludes an explicit "new ..." finding.
  const rulesOutOnly = !hasFinding
    && /\bno evidence\b|\bnegative for\b|\bno\b|\bwithout\b|\bfree of\b|\babsence of\b/.test(imp)
    && !/\b(change|interval|stable|unchanged|persist|residual|known|redemonstrat|progress|recurren)/.test(imp)
    && !/\bnew\b[^.,;:]*(mass|nodule|lesion|opacit|effusion|collection|thromb)/.test(imp);
  let range = 'abnormal', reason;
  if (!imp) { reason = 'empty report — defaulting to abnormal (needs review)'; }
  else if (hasFinding) { reason = 'impression names positive finding(s)'; }
  else if (saysNormal) { range = 'normal'; reason = 'impression states a normal / unremarkable study'; }
  else if (rulesOutOnly) { range = 'normal'; reason = 'impression rules out pathology (negative study)'; }
  else { reason = 'no explicit normal statement in impression — defaulting to abnormal (safer)'; }
  return { range, impression: impression.slice(0, 300), reason, hadImpressionHeader: !!m };
}

// RadiologyDetails returns a row that the SaveRadiologyResultEntry DTO cannot bind
// as-is: ~20 string fields come back `null`, but the SPA coerces them to '' before
// posting and the server dereferences them (a null trips a server-side
// null-reference → HTTP 500 "Object reference not set", Error_Code 1005). It also
// adds a handful of fields RadiologyDetails omits. This normaliser replays exactly
// what the SPA sends, derived field-for-field from a live payload capture.
const ROW_STRING_EMPTY = ['addendum', 'criticalRange', 'dtlsdisplayorder', 'invPatOrderID',
  'invProfileserviceId', 'mastServiceName', 'methodid', 'methodname', 'noramlRange', 'oldAddendum',
  'parentID', 'previousresult', 'remarks', 'reportLink', 'resultComparisonOperator', 'resultCopyEmpId',
  'resultMachine', 'resultUnit', 'samplename', 'unauthorizeRemarks', 'doctorcontactstatusold'];
const ROW_NUM_ZERO = ['invVariantsRangeId', 'panicRangeId'];
const ROW_MISSING_DEFAULTS = { isNotNormal: 0, isPanic: 0, resultComparisonValue: null,
  resultEnteredAndAccepted: '0', unauthorizeRemarksId: null };

function normalizeResultRow(row) {
  const r = { ...row };
  for (const k of ROW_STRING_EMPTY) if (r[k] == null) r[k] = '';
  for (const k of ROW_NUM_ZERO) if (r[k] == null) r[k] = 0;
  for (const k of Object.keys(ROW_MISSING_DEFAULTS)) if (!(k in r)) r[k] = ROW_MISSING_DEFAULTS[k];
  return r;
}

function radiologyDetailsBody(row, { hospitalId = 1, empId }) {
  return {
    mrno: row.mrno, gender: /^m/i.test(row.gender) ? 0 : 1, age: row.age, hospitalid: hospitalId,
    genpatbillingid: row.genPatBillingId, sampleno: row.sampleNo, invmastserviceid: row.invMastserviceId,
    emrpatinvorderid: 0, invpatbillingid: 0, physiologicalconditions: '', invpatorderid: 0,
    userId: String(empId), mode: 3, fromDate: '1900-01-01T00:00:00.000Z', toDate: '2035-12-31T23:59:59.000Z',
    categoryid: 0, selectionType: 1, searchType: 2,
  };
}

module.exports = {
  dpAgent, normMod, bodyTokens, sideOf, isReported, isDraftReport, sameMrn, cleanAccession,
  depacsStudies, depacsRecentStudies, depacsReport, matchStudy,
  radiologySearchBody, radiologyDetailsBody, normalizeResultRow, classifyRange, sirResultRange,
  // exposed for the deep DePACS probe tool (read-only diagnostics)
  dpFetch, dpToken, _fileCandidates, depacsSigninDebug,
};
