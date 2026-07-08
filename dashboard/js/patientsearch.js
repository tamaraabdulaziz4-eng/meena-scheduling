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
  box.innerHTML = `<div class="ho-lbl" style="margin:0 0 6px">${pts.length} matches — pick the patient</div>
    <div class="listcard">` +
    pts.map((p, i) => `
      <div class="lrow" role="button" tabindex="0" onclick="psOpen(${i})"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();psOpen(${i})}"
           style="cursor:pointer${i === psState.sel ? ';background:var(--violet-wash,#F0EDFF)' : ''}">
        <div class="pt" style="flex:1;min-width:0">
          <div class="pname">${escapeHtml(p.name || '—')}${p.nameArabic ? ' <span style="font-weight:500;color:var(--muted)">· ' + escapeHtml(p.nameArabic) + '</span>' : ''}</div>
          <div class="pmeta"><span>🆔 ${escapeHtml(p.mrno || '—')}</span>${p.nationalId ? '<i></i><span>' + escapeHtml(p.nationalId) + '</span>' : ''}${p.phone ? '<i></i><span>📞 ' + escapeHtml(p.phone) + '</span>' : ''}${p.age ? '<i></i><span>' + escapeHtml(p.age) + '</span>' : ''}</div>
        </div>
        ${i === psState.sel
          ? '<span class="ris arrived"><span class="rd"></span>Selected</span>'
          : '<button class="ghost" tabindex="-1" onclick="event.stopPropagation();psOpen(' + i + ')">Open →</button>'}
      </div>`).join('') + '</div>';
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
      ${tiles ? `<div class="kpis" style="margin-top:14px;grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">${tiles}</div>` : ''}
      <div class="ps-grid ps-idgrid">
        ${psField('National ID / Iqama', p.nationalId)}
        ${psField('Phone', p.phone)}
        ${psField('Date of birth', p.dob)}
        ${psField('Marital status', p.maritalStatus)}
      </div>
      <div id="ps-clinical"></div>
      <div id="ps-labresults"></div>
      <div id="ps-visits"></div>
      <div id="ps-appts"></div>
      ${(!p.height && !p.weight && Array.isArray(d.patientRawKeys) && d.patientRawKeys.length)
        ? `<div style="font-size:10.5px;color:var(--muted);margin-top:10px;border-top:1px dashed var(--border);padding-top:6px;word-break:break-all">ℹ️ height/weight not in this record. Available fields: ${escapeHtml(d.patientRawKeys.join(', '))}</div>`
        : ''}
      <div class="ps-consent">
        <button class="btn btn-primary ps-consent-btn${psIsFemale(p) ? ' female' : ''}" onclick="psStartConsent()">
          🖊️ ${psIsFemale(p) ? 'Non-pregnancy consent · إقرار عدم الحمل' : 'New consent · كونسينت'}</button>
        <button class="btn btn-ghost ps-consent-btn" style="margin-inline-start:8px" onclick="psUploadDocument()">📎 Upload document</button>
        <div id="ps-consent-list" class="ps-consent-list"></div>
        <div id="ps-doc-list" class="ps-consent-list"></div>
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
  psLoadDocuments();
  psLoadLabs();
  psLoadClinical();                            // problem list · allergies · vitals (from Siratech)
  psLoadRealLabs();                            // lab results — test · value · range (from Siratech)
  psLoadVisits();                              // recent clinic visits (encounter history)
  psLoadAppointments();                        // appointment history
  if (orders.length) psAutoReports(orders);   // auto-fill every exam's report — no clicking
}

// Patient clinical context — problem list (ICD diagnoses), allergies / clinical
// warnings, and vitals — straight from Siratech EMR. Loaded after the card paints,
// best-effort (a failure just shows nothing). Read-only.
async function psLoadClinical() {
  const box = document.getElementById('ps-clinical');
  if (!box) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno) { box.innerHTML = ''; return; }
  let d;
  try { d = await API.get(`/radiology/patient/${encodeURIComponent(p.mrno)}/clinical`); }
  catch (e) { box.innerHTML = ''; return; }
  const dx = (d && d.diagnoses) || [];
  const al = (d && d.allergies) || {};
  const vi = d && d.vitals;
  const fl = (d && d.flags) || {};
  const secL = (t) => `<div class="ps-sec-l" style="margin-top:14px">${t}</div>`;
  let html = '';
  // Infection status — isolation / scanner & contrast precautions. Must be loud.
  if (fl.infections && fl.infections.length) {
    html += `<div class="ps-alert" style="margin-top:12px;background:rgba(192,38,26,0.12);border-color:#c0261a">🧬 <b>Infection status:</b> ${fl.infections.map(escapeHtml).join(' · ')} — observe precautions.</div>`;
  }
  // Blood group + VIP + any clinical warning as compact chips.
  const infoChips = [
    fl.bloodGroup ? `<span style="display:inline-flex;gap:5px;align-items:baseline;background:var(--card-alt,#f4f4f8);border:1px solid var(--border);border-radius:8px;padding:4px 9px;font-size:12.5px"><b>${escapeHtml(fl.bloodGroup)}</b><span style="color:var(--muted)">Blood</span></span>` : '',
    fl.vip ? `<span style="background:#7c5cff;color:#fff;border-radius:8px;padding:4px 9px;font-size:12px;font-weight:700">VIP</span>` : '',
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
  try { d = await API.get(`/radiology/patient/${encodeURIComponent(p.mrno)}/visits`); }
  catch (e) { box.innerHTML = ''; return; }
  const visits = (d && d.visits) || [];
  if (!visits.length) { box.innerHTML = ''; return; }
  const rows = visits.slice(0, 12).map((v, i) => {
    const er = String(v.visitType || '').toUpperCase() === 'ER';
    const badge = v.visitType ? `<span class="sc ${er ? 'no' : 'ok'}" style="${er ? '' : 'background:var(--violet-wash,#F0EDFF);color:var(--accent2,#6B4EFF)'}">${escapeHtml(v.visitType)}</span>` : '';
    const sub = [v.provider, v.department, v.site].filter(Boolean).map(escapeHtml).join(' · ');
    const enc = v.encounterId;
    const canNote = enc != null;
    return `<div style="padding:7px 0;border-bottom:1px dashed var(--border)">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;${canNote ? 'cursor:pointer' : ''}" ${canNote ? `onclick="psToggleVisitNote('${escapeHtml(String(enc))}','psvn-${i}',this)"` : ''}>
        ${canNote ? `<span id="psvn-${i}-c" style="color:var(--muted);width:12px">▸</span>` : '<span style="width:12px"></span>'}
        <span style="font-weight:600;font-variant-numeric:tabular-nums;min-width:88px">${escapeHtml(String(v.date || '').slice(0, 10))}</span>
        ${badge}
        ${v.chiefComplaint ? `<span style="flex:1;min-width:120px;font-size:12.5px">${escapeHtml(v.chiefComplaint)}</span>` : '<span style="flex:1"></span>'}
      </div>
      ${sub ? `<div style="color:var(--muted);font-size:11.5px;margin:2px 0 0 22px">${sub}</div>` : ''}
      <div id="psvn-${i}" style="display:none;margin:6px 0 2px 22px"></div>
    </div>`;
  }).join('');
  box.innerHTML = `<div class="ps-sec-l" style="margin-top:14px">Recent visits · ${visits.length}</div><div>${rows}</div>`;
}

// Expand a visit row to show the doctor's clinical note(s) for that encounter,
// fetched on demand from Siratech (Visits/DetailsByGroup → EmrHtmlPreview). Read-only.
async function psToggleVisitNote(encounterId, elId, caretRow) {
  const box = document.getElementById(elId);
  if (!box) return;
  const caret = document.getElementById(elId + '-c');
  if (box.style.display !== 'none') { box.style.display = 'none'; if (caret) caret.textContent = '▸'; return; }
  box.style.display = ''; if (caret) caret.textContent = '▾';
  if (box.dataset.loaded) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  box.innerHTML = '<span style="color:var(--muted);font-size:12px">Loading note from Siratech…</span>';
  let d;
  try { d = await API.get(`/radiology/patient/${encodeURIComponent(p.mrno)}/visit-note?encounterId=${encodeURIComponent(encounterId)}`); }
  catch (e) { box.innerHTML = `<span style="color:var(--muted);font-size:12px">Could not load the note.</span>`; return; }
  const notes = (d && d.notes) || [];
  if (!notes.length) { box.innerHTML = `<span style="color:var(--muted);font-size:12px">No readable note on this visit.</span>`; box.dataset.loaded = '1'; return; }
  box.dataset.loaded = '1';
  box.innerHTML = notes.map((n) => `
    <div style="border-left:2px solid var(--border);padding:2px 0 2px 10px;margin-bottom:8px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:3px">${escapeHtml(n.templateName || 'Note')}${n.by ? ' · ' + escapeHtml(n.by) : ''}${n.date ? ' · ' + escapeHtml(String(n.date).slice(0, 10)) : ''}</div>
      ${n.sections.map((s) => `<div style="font-size:12.5px;line-height:1.5;margin-bottom:2px">${s.label ? `<b>${escapeHtml(s.label)}:</b> ` : ''}${escapeHtml(s.text)}</div>`).join('')}
    </div>`).join('');
}

// The patient's appointment history — date · speciality · doctor · status. Read-only.
async function psLoadAppointments() {
  const box = document.getElementById('ps-appts');
  if (!box) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno) { box.innerHTML = ''; return; }
  let d;
  try { d = await API.get(`/radiology/patient/${encodeURIComponent(p.mrno)}/appointments`); }
  catch (e) { box.innerHTML = ''; return; }
  const appts = (d && d.appointments) || [];
  if (!appts.length) { box.innerHTML = ''; return; }
  const statusColor = (s) => /cancel/i.test(s) ? '#c0261a' : (/miss|no.?show/i.test(s) ? '#e2571f' : (/confirm|complet|attend/i.test(s) ? '#0a8f5b' : 'var(--muted)'));
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
  let d;
  try { d = await API.get(`/radiology/patient/${encodeURIComponent(p.mrno)}/labs`); }
  catch (e) { box.innerHTML = ''; return; }
  const results = (d && d.results) || [];
  if (!results.length) { box.innerHTML = ''; return; }
  // Group by result day (newest first).
  const byDay = new Map();
  for (const r of results) {
    const day = String(r.date || '').slice(0, 11).trim() || 'Undated';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const abn = results.filter((r) => r.abnormal || r.critical).length;
  const head = `<div class="ps-sec-l" style="margin-top:14px">Lab results · ${results.length}${abn ? ` · <span style="color:#e2571f">${abn} abnormal</span>` : ''}</div>`;
  const rowHtml = (r) => {
    const col = r.critical ? '#c0261a' : (r.abnormal ? '#e2571f' : 'inherit');
    const wt = (r.critical || r.abnormal) ? '700' : '600';
    const flag = r.critical ? ' ⚠' : (r.abnormal ? ' ▲' : '');
    return `<div style="display:flex;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px dashed var(--border)">
      <span style="flex:1;min-width:150px;font-size:12.5px">${escapeHtml(r.name)}</span>
      <span style="font-weight:${wt};color:${col};font-variant-numeric:tabular-nums;white-space:nowrap">${escapeHtml(r.value)}${flag}</span>
      ${r.range ? `<span style="color:var(--muted);font-size:11px;min-width:96px;text-align:right">${escapeHtml(r.range)}</span>` : ''}
    </div>`;
  };
  const body = [...byDay.entries()].map(([day, rows]) =>
    `<div style="margin-top:8px"><div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:2px">${escapeHtml(day)}</div>${rows.map(rowHtml).join('')}</div>`
  ).join('');
  box.innerHTML = head + body;
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
    o.billingStatus ? `<span class="sc ok" style="background:var(--violet-wash,#F0EDFF);color:var(--accent2,#6B4EFF)">${escapeHtml(o.billingStatus)}</span>` : '',
    imaged ? ris('completed', 'Imaged') : ris('scheduled', 'Awaiting imaging'),
    o.hasReport ? ris('final', 'Report ready') : '',
    o.cpacsUrl ? `<a class="ghost" style="text-decoration:none" href="${escapeHtml(String(o.cpacsUrl))}" target="_blank" rel="noopener" title="Open the study in the PACS viewer" onclick="event.stopPropagation()">🖼 Images</a>` : '',
  ].filter(Boolean).join('');
  const mods = (typeof odModBadges === 'function') ? odModBadges(o.modality) : '';
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
  return 'ps-rep-' + String((o && (o.billNo || o.accessionNumber)) || Math.abs(psParseDate(o && o.orderedDate) || 0)).replace(/[^A-Za-z0-9_-]/g, '');
}
// Auto-load each exam's report on open — no clicking. Every report is pulled STRAIGHT
// FROM SIRATECH (FetchRadiologyReport, keyed by the exam's own invPatTestResultId), so
// there's no DePACS match and no per-file matching pass. One direct call per exam,
// all fired together. Read-only.
async function psAutoReports(orders) {
  if (!orders || !orders.length) return;
  const p = (psState.lookup && psState.lookup.patient) || {};
  if (!p.mrno) return;
  for (const o of orders) psLoadReport(o, psRepId(o));
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
      const when = d.reportDate ? ' · ' + escapeHtml(String(d.reportDate).slice(0, 16).replace('T', ' ')) : '';
      el.innerHTML = `<div style="border:1px solid var(--border);border-radius:8px;padding:10px;background:var(--card-alt,#f7f7fa)">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px">${escapeHtml(String(who))}${when}</div>
        <div style="white-space:pre-wrap;font-size:12.5px;line-height:1.5">${escapeHtml(txt)}</div>
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
