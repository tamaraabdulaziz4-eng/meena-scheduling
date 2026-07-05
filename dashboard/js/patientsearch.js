// ── Patient / Exam lookup ─────────────────────────────────────────────────────
// One search box that accepts a file/MRN number, a national ID (Saudi/Iqama), or a
// phone — resolves the patient in Siratech, then aggregates EVERYTHING scattered
// across the HIS (demographics + every radiology exam with its origin, clinical,
// billing and imaging/report status) into one screen. Read-only.

let psState = { q: '', patients: null, loading: false, sel: null, lookup: null, reqSeq: 0 };
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
  c.innerHTML = `
    ${pageHero('Lookup', 'Patient / exam lookup', 'Search by file number, national ID, Iqama, or mobile — then see the patient and every radiology exam, fully aggregated')}
    <div class="card">
      <div style="display:flex;gap:9px;flex-wrap:wrap">
        <input id="ps-q" class="input" placeholder="File / MRN · National ID · Iqama · Mobile" value="${escapeHtml(psState.q)}"
               style="flex:1;min-width:220px" onkeydown="if(event.key==='Enter')psSearch()">
        <button class="btn btn-primary" onclick="psSearch()">Search</button>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-top:8px">Type any one of: the patient file/MRN, their national ID / Iqama, or their mobile number.</div>
      <div id="ps-results" style="margin-top:14px"></div>
    </div>
    <div id="ps-detail"></div>`;
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
  box.innerHTML = `<div class="ho-lbl" style="margin:0 0 6px">${pts.length} matches — pick the patient</div>` +
    pts.map((p, i) => `
      <label class="ho-row ${i === psState.sel ? 'sel' : ''}">
        <input type="radio" name="ps-pt" ${i === psState.sel ? 'checked' : ''} onchange="psOpen(${i})">
        <div class="ho-row-main">
          <div class="ho-row-title">${escapeHtml(p.name || '—')}${p.nameArabic ? ' · ' + escapeHtml(p.nameArabic) : ''}</div>
          <div class="ho-row-sub">🆔 ${escapeHtml(p.mrno || '—')}${p.nationalId ? ' · ' + escapeHtml(p.nationalId) : ''}${p.phone ? ' · 📞 ' + escapeHtml(p.phone) : ''}${p.age ? ' · ' + escapeHtml(p.age) : ''}</div>
        </div>
      </label>`).join('');
}

async function psOpen(i) {
  const p = (psState.patients || [])[i];
  if (!p || !p.mrno) return;
  psState.sel = i;
  renderPsResults();
  const det = document.getElementById('ps-detail');
  if (det) det.innerHTML = LOADING_HTML;
  const seq = ++psState.reqSeq;
  try {
    const d = await API.get(`/radiology/lookup/${encodeURIComponent(p.mrno)}`);
    if (seq !== psState.reqSeq) return;
    // Keep the search-row patient as a fallback when the lookup's own patient block is thin.
    psState.lookup = { ...d, patient: d.patient || p };
    renderPsDetail();
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

function psInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '؟';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
// A big, glanceable stat tile (height / weight / BMI / blood group).
function psTile(label, value, unit) {
  const v = (value == null || String(value).trim() === '') ? '' : String(value);
  if (!v) return '';
  return `<div class="ps-tile">
    <div class="ps-tile-v">${escapeHtml(v)}${unit ? `<span class="ps-tile-u">${escapeHtml(unit)}</span>` : ''}</div>
    <div class="ps-tile-l">${escapeHtml(label)}</div>
  </div>`;
}

function renderPsDetail() {
  const det = document.getElementById('ps-detail');
  if (!det) return;
  const d = psState.lookup || {};
  const p = d.patient || {};
  const orders = d.orders || [];
  const tiles = [
    psTile('Height', p.height, p.height && Number(p.height) > 3 ? 'cm' : ''),
    psTile('Weight', p.weight, p.weight ? 'kg' : ''),
    psTile('BMI', p.bmi, ''),
    psTile('Blood', p.bloodGroup, ''),
  ].filter(Boolean).join('');
  // Contrast-safety: a known allergy must be impossible to miss on a radiology screen.
  const allergyAlert = p.allergy
    ? `<div class="ps-alert">⚠️ <b>Allergy:</b> ${escapeHtml(p.allergy)}</div>` : '';
  const patCard = `
    <div class="card ps-pt-card">
      <div class="ps-id">
        <div class="ps-avatar">${escapeHtml(psInitials(p.name || p.nameArabic))}</div>
        <div class="ps-id-main">
          <div class="ps-pt-name">${escapeHtml(p.name || '—')}</div>
          ${p.nameArabic ? `<div class="ps-pt-ar">${escapeHtml(p.nameArabic)}</div>` : ''}
          <div class="ps-id-chips">
            ${p.gender ? `<span class="ps-chip ps-chip-strong">${escapeHtml(p.gender)}</span>` : ''}
            ${p.age ? `<span class="ps-chip">${escapeHtml(p.age)}</span>` : ''}
            ${p.nationality ? `<span class="ps-chip">${escapeHtml(p.nationality)}</span>` : ''}
          </div>
        </div>
        <div class="ps-id-mrn">
          <div class="ps-id-mrn-l">FILE / MRN</div>
          <div class="ps-id-mrn-v">${escapeHtml(p.mrno || '—')}</div>
        </div>
      </div>
      ${allergyAlert}
      <div id="ps-labs" style="margin-top:10px"></div>
      ${tiles ? `<div class="ps-tiles">${tiles}</div>` : ''}
      <div class="ps-grid ps-idgrid">
        ${psField('National ID / Iqama', p.nationalId)}
        ${psField('Phone', p.phone)}
        ${psField('Date of birth', p.dob)}
        ${psField('Marital status', p.maritalStatus)}
      </div>
      ${(!p.height && !p.weight && Array.isArray(d.patientRawKeys) && d.patientRawKeys.length)
        ? `<div style="font-size:10.5px;color:var(--muted);margin-top:10px;border-top:1px dashed var(--border);padding-top:6px;word-break:break-all">ℹ️ height/weight not in this record. Available fields: ${escapeHtml(d.patientRawKeys.join(', '))}</div>`
        : ''}
      <div class="ps-consent">
        <button class="btn btn-primary ps-consent-btn${psIsFemale(p) ? ' female' : ''}" onclick="psStartConsent()">
          🖊️ ${psIsFemale(p) ? 'Non-pregnancy consent · إقرار عدم الحمل' : 'New consent · كونسينت'}</button>
        <div id="ps-consent-list" class="ps-consent-list"></div>
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
    examBlock = `<div class="ho-lbl" style="margin:16px 0 8px">Radiology exams (${sorted.length}) · newest first</div>` +
      sorted.map((o, i) => psExamCard(o, i === 0)).join('');
  }
  det.innerHTML = patCard + examBlock;
  psLoadConsents();
  psLoadLabs();
}

// Radiation-safety labs panel: for a female patient, auto-load her pregnancy / β-hCG
// status on the patient page (a single call — this is a dedicated per-patient view,
// not the 30-row board, so auto-loading is fine here). Read-only decision support.
async function psLoadLabs() {
  const box = document.getElementById('ps-labs');
  if (!box) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno || !psIsFemale(p)) { box.innerHTML = ''; return; }
  box.innerHTML = '<span style="color:var(--muted);font-size:12px">🤰 Checking pregnancy status…</span>';
  let r;
  try { r = await API.get(`/radiology/labs/pregnancy?mrno=${encodeURIComponent(p.mrno)}`); }
  catch (e) { box.innerHTML = '<span style="color:var(--muted);font-size:12px">🤰 Pregnancy status unavailable.</span>'; return; }
  const when = r && (r.resultDate || r.orderDate);
  const dstr = when ? ' · ' + escapeHtml(String(when).slice(0, 10)) : '';
  const nm = r && r.testName ? escapeHtml(String(r.testName)) : 'pregnancy test';
  let html;
  if (!r || !r.found || !r.hasPregnancyTest) {
    html = `<div class="ps-alert" style="background:rgba(224,168,0,0.12);border-color:#e0a800">🤰 <b>No recent pregnancy / β-hCG lab</b> on file — confirm status before imaging.</div>`;
  } else if (r.verdict === 'positive') {
    html = `<div class="ps-alert">🤰 <b>Pregnancy test POSITIVE</b> — ${nm}${r.resultText ? ' = ' + escapeHtml(String(r.resultText)) : ''}${dstr}. Do NOT irradiate without physician review.</div>`;
  } else if (r.verdict === 'negative') {
    html = `<div class="ps-alert" style="background:rgba(46,158,107,0.12);border-color:#2e9e6b">🤰 <b>Pregnancy test negative</b> — ${nm}${dstr}.</div>`;
  } else if (r.resulted) {
    html = `<div class="ps-alert" style="background:rgba(107,114,128,0.12);border-color:#6b7280">🤰 <b>Pregnancy test resulted</b> — ${nm}${r.resultText ? ' = ' + escapeHtml(String(r.resultText)) : ''}${dstr}. Read the value.</div>`;
  } else {
    html = `<div class="ps-alert" style="background:rgba(224,168,0,0.12);border-color:#e0a800">🤰 <b>Pregnancy test pending</b> — ${nm} ordered${dstr}, result not back yet.</div>`;
  }
  box.innerHTML = html;
}

// Female detection (the non-pregnancy consent is female-specific) — accept English
// and Arabic spellings; unknown gender → not auto-highlighted (staff can still open it).
function psIsFemale(p) {
  const g = String((p && p.gender) || '').toLowerCase();
  return g.startsWith('f') || g.includes('female') || g.includes('انث') || g.includes('أنث') || g.includes('امرأ');
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
        <span style="color:var(--muted)">· ${escapeHtml(String(c.created_at || '').slice(0, 16).replace('T', ' '))}${c.created_by_name ? ' · ' + escapeHtml(c.created_by_name) : ''}</span></span>
      <a class="btn btn-xs" href="/api/consent/${c.id}/pdf?file=${encodeURIComponent(p.mrno || '')}" target="_blank" rel="noopener">View</a>
    </div>`).join('');
}

// Best-effort timestamp for sorting: prefer the order date, fall back to the report
// date. Handles ISO, dd/mm/yyyy, dd-mm-yyyy and dd-Mon-yyyy; unparseable → 0.
function psOrderTime(o) {
  return psParseDate(o && (o.orderedDate || o.reportDate));
}
function psParseDate(s) {
  if (!s) return 0;
  const str = String(s).trim();
  let t = Date.parse(str);
  if (!isNaN(t)) return t;
  let m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; t = Date.UTC(y, (+m[2]) - 1, +m[1]); if (!isNaN(t)) return t; }
  m = str.match(/^(\d{1,2})[\/\-]([A-Za-z]{3})[\/\-](\d{2,4})/);
  if (m) { t = Date.parse(`${m[1]} ${m[2]} ${m[3]}`); if (!isNaN(t)) return t; }
  return 0;
}
function psToggleExam(btn) {
  const card = btn.closest('.ps-exam');
  if (card) card.classList.toggle('open');
}

function psExamCard(o, open) {
  const imaged = o.imaged || (o.accessionNumber != null && String(o.accessionNumber).trim() !== '');
  const chips = [
    o.isER ? `<span class="badge badge-red">🚨 ER</span>` : '',
    o.encounter && !o.isER ? `<span class="badge badge-purple">${escapeHtml(o.encounter)}</span>` : '',
    o.billingStatus ? `<span class="badge badge-purple">${escapeHtml(o.billingStatus)}</span>` : '',
    imaged ? `<span class="badge badge-green">✅ Imaged</span>` : `<span class="badge badge-orange">⏳ Awaiting imaging</span>`,
    o.hasReport ? `<span class="badge badge-green">📄 Report ready</span>` : '',
    o.cpacsUrl ? `<a class="badge" style="background:#3b6fd4;color:#fff;text-decoration:none" href="${escapeHtml(String(o.cpacsUrl))}" target="_blank" rel="noopener" title="Open the study in the PACS viewer">🖼 Images</a>` : '',
  ].filter(Boolean).join('');
  const day = (o.orderedDate || o.reportDate || '').toString().slice(0, 10);
  const repId = 'ps-rep-' + String(o.billNo || o.accessionNumber || Math.abs(psParseDate(o.orderedDate) || 0)).replace(/[^A-Za-z0-9_-]/g, '');
  return `
    <div class="card ps-exam${open ? ' open' : ''}">
      <button type="button" class="ps-exam-summary" onclick="psToggleExam(this)">
        <span class="ps-exam-caret">▸</span>
        <span class="ps-exam-sum-main">
          <span class="ps-exam-title">${escapeHtml(o.service || '—')} <span style="color:var(--muted);font-weight:500">(${escapeHtml(o.modality || '—')})</span></span>
          ${day ? `<span class="ps-exam-date">${escapeHtml(day)}</span>` : ''}
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
          ${psField('Indication', o.clinicalIndication, { accent: true })}
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
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${o.cpacsUrl ? `<a class="btn btn-sm" style="background:#3b6fd4;color:#fff;border:none;text-decoration:none" href="${escapeHtml(String(o.cpacsUrl))}" target="_blank" rel="noopener">🖼 View images</a>` : ''}
          <button class="btn btn-sm btn-ghost" onclick="psLoadReport('${jsAttr(String(o.billNo || ''))}','${repId}',this)">📄 Load report</button>
        </div>
        <div id="${repId}" style="margin-top:8px"></div>
      </div>
    </div>`;
}

// Lazy-load the DePACS report matched to THIS order (by bill number) and show the
// radiologist, date, and impression preview inline. Read-only; the heavy match runs
// once per file and is cached on psState.
async function psLoadReport(billNo, elId, btn) {
  const el = document.getElementById(elId);
  if (!el) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno) { el.innerHTML = '<span style="color:var(--muted)">No file number.</span>'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'loading…'; }
  try {
    if (!psState.match || psState.match.mrno !== p.mrno) {
      const d = await API.get(`/radiology/results/match/${encodeURIComponent(p.mrno)}`);
      psState.match = { mrno: p.mrno, data: d };
    }
    const orders = (psState.match.data && psState.match.data.orders) || [];
    const ord = billNo ? orders.find((o) => String(o.billNo) === String(billNo)) : orders[0];
    const tests = (ord && ord.tests) || [];
    const withRep = tests.find((t) => t.report && t.report.preview);
    if (!withRep) {
      const anyStudy = tests.find((t) => t.study);
      el.innerHTML = `<div style="color:var(--muted);font-size:12px">No verified report matched yet${anyStudy ? ' (images found, report pending)' : ''}.</div>`;
    } else {
      const r = withRep.report;
      el.innerHTML = `<div style="border:1px solid var(--border);border-radius:8px;padding:10px;background:var(--card-alt,#f7f7fa)">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px">${escapeHtml(withRep.report.reviewer || 'Radiologist')}${r.reportDate ? ' · ' + escapeHtml(String(r.reportDate).slice(0, 16).replace('T', ' ')) : ''}${withRep.study && withRep.study.studyId ? ' · study #' + escapeHtml(String(withRep.study.studyId)) : ''}</div>
        <div style="white-space:pre-wrap;font-size:12.5px;line-height:1.5">${escapeHtml(r.preview)}${r.preview && r.preview.length >= 590 ? '…' : ''}</div>
      </div>`;
    }
  } catch (e) {
    el.innerHTML = `<div style="color:var(--danger,#E25555);font-size:12px">${escapeHtml(e.message || 'Could not load the report')}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 Load report'; }
  }
}
