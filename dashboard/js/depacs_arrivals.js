// ── DePACS Arrivals ───────────────────────────────────────────────────────────
// Manager view: every study that ARRIVED (was imaged) in DePACS for a chosen date
// range, one row per study. NOTHING is auto-excluded — the manager ticks whatever
// they judge duplicate/irrelevant, and the counters update live. Studies with NO
// real DICOM accession are flagged (⚑) for manual review. Renders into #content.
// Backend: GET /api/radiology/depacs-arrivals?from&to  (management-only).

const daState = { from: '', to: '', data: null, loading: false, excluded: new Set(), onlyFlag: false };

// KSA (UTC+3) calendar date as YYYY-MM-DD — matches how DePACS dates a study's day.
function daKsaToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (_e) { return new Date().toISOString().slice(0, 10); }
}
function daEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function daNum(n) { return (n == null ? 0 : n).toLocaleString('en-US'); }

async function renderDepacsArrivalsPage() {
  const c = document.getElementById('content');
  if (!c) return;
  if (!daState.from || !daState.to) {
    const t = daKsaToday();
    daState.from = t.slice(0, 8) + '01';   // 1st of current KSA month
    daState.to = t;
  }
  c.innerHTML = `
    <div class="cc" style="padding:16px 18px 40px">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px">
        <h2 style="margin:0;font-size:18px">DePACS Arrivals <span style="font-size:12px;color:var(--muted);font-weight:400">· studies that reached the PACS</span></h2>
      </div>
      <div style="display:flex;flex-wrap:wrap;align-items:end;gap:12px;margin-bottom:14px">
        <label style="font-size:12px;color:var(--muted)">From<br><input type="date" id="da-from" value="${daEsc(daState.from)}" style="padding:6px 8px"></label>
        <label style="font-size:12px;color:var(--muted)">To<br><input type="date" id="da-to" value="${daEsc(daState.to)}" style="padding:6px 8px"></label>
        <button class="btn" id="da-load" onclick="daLoad()">Load</button>
        <span style="display:flex;gap:6px">
          <button class="rs-chip" onclick="daPreset('today')">Today</button>
          <button class="rs-chip" onclick="daPreset('yesterday')">Yesterday</button>
          <button class="rs-chip" onclick="daPreset('month')">This month</button>
        </span>
        <label style="font-size:12px;margin-inline-start:auto;display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="da-onlyflag" onchange="daToggleOnlyFlag(this.checked)"> Only ⚑ no-accession</label>
        <button class="btn ghost" onclick="daExportCsv()">Export CSV</button>
      </div>
      <div id="da-summary"></div>
      <div id="da-body"><div style="padding:40px;text-align:center;color:var(--muted)">Pick a date range and press <b>Load</b>.</div></div>
    </div>`;
  daLoad();
}

function daPreset(which) {
  const t = daKsaToday();
  if (which === 'today') { daState.from = t; daState.to = t; }
  else if (which === 'yesterday') {
    const d = new Date(t + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
    const y = d.toISOString().slice(0, 10); daState.from = y; daState.to = y;
  } else if (which === 'month') { daState.from = t.slice(0, 8) + '01'; daState.to = t; }
  const f = document.getElementById('da-from'), to = document.getElementById('da-to');
  if (f) f.value = daState.from; if (to) to.value = daState.to;
  daLoad();
}

function daToggleOnlyFlag(v) { daState.onlyFlag = !!v; daRenderTable(); }

async function daLoad() {
  const f = document.getElementById('da-from'), to = document.getElementById('da-to');
  if (f && f.value) daState.from = f.value;
  if (to && to.value) daState.to = to.value;
  const body = document.getElementById('da-body');
  const btn = document.getElementById('da-load');
  daState.loading = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  if (body) body.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted)">Reading DePACS for ${daEsc(daState.from)} → ${daEsc(daState.to)}… <br><span style="font-size:12px">(a wide range can take a moment)</span></div>`;
  try {
    const d = await API.get(`/radiology/depacs-arrivals?from=${encodeURIComponent(daState.from)}&to=${encodeURIComponent(daState.to)}`);
    daState.data = d;
    daState.excluded = new Set();          // reset manual exclusions on a fresh load
    daRenderSummary();
    daRenderTable();
  } catch (e) {
    if (body) body.innerHTML = `<div class="card" style="padding:24px;color:#E25555">Couldn't load: ${daEsc((e && e.message) || e)}</div>`;
  } finally {
    daState.loading = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Load'; }
  }
}

function daVisibleRows() {
  const rows = (daState.data && daState.data.studies) || [];
  return daState.onlyFlag ? rows.filter((r) => r.noAccession) : rows;
}

function daRenderSummary() {
  const el = document.getElementById('da-summary');
  const d = daState.data; if (!el || !d) return;
  const rows = d.studies || [];
  const pats = new Set(rows.filter((r) => !daState.excluded.has(r.studyId) && r.mrno).map((r) => r.mrno));
  const kept = rows.length - daState.excluded.size;
  const tile = (n, l, color) => `<div class="card" style="flex:1;min-width:120px;padding:12px 14px;text-align:center">
      <div style="font-size:22px;font-weight:700;${color ? 'color:' + color : ''}">${daNum(n)}</div>
      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">${l}</div></div>`;
  el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px">
      ${tile(rows.length, 'Studies arrived')}
      ${tile(pats.size, 'Patients (net)')}
      ${tile(d.noAccession, 'No accession ⚑', '#c77700')}
      ${tile(daState.excluded.size, 'Excluded by you')}
      ${tile(kept, 'Net studies', '#0b7a4b')}
    </div>
    ${daDayTable(d.days || [])}`;
}

function daDayTable(days) {
  if (!days.length) return '';
  const body = days.map((r) => `<tr>
      <td>${daEsc(r.day)}</td><td style="text-align:right">${daNum(r.patients)}</td>
      <td style="text-align:right">${daNum(r.studies)}</td>
      <td style="text-align:right;${r.noAccession ? 'color:#c77700;font-weight:600' : 'color:var(--muted)'}">${daNum(r.noAccession)}</td>
    </tr>`).join('');
  return `<details style="margin-bottom:14px"><summary style="cursor:pointer;font-size:13px;color:var(--muted)">Per-day summary (${days.length} day${days.length > 1 ? 's' : ''})</summary>
    <table class="tbl" style="width:100%;margin-top:8px;font-size:13px"><thead><tr>
      <th>Day</th><th style="text-align:right">Patients</th><th style="text-align:right">Studies</th><th style="text-align:right">⚑ No acc.</th>
    </tr></thead><tbody>${body}</tbody></table></details>`;
}

function daRenderTable() {
  const body = document.getElementById('da-body');
  if (!body) return;
  const rows = daVisibleRows();
  if (!rows.length) { body.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted)">No studies for this range.</div>`; return; }
  const tr = rows.map((r) => {
    const ex = daState.excluded.has(r.studyId);
    const flag = r.noAccession ? `<span title="no DICOM accession — review manually" style="background:#fff3e0;color:#c77700;border:1px solid #ffd8a8;border-radius:5px;padding:1px 6px;font-size:11px;font-weight:600">⚑ none</span>` : daEsc(r.accession || '');
    return `<tr style="${ex ? 'opacity:.4;text-decoration:line-through' : ''}${r.noAccession ? ';background:#fffaf3' : ''}">
      <td style="text-align:center"><input type="checkbox" ${ex ? 'checked' : ''} onchange="daToggleRow(${r.studyId}, this.checked)" title="tick to exclude"></td>
      <td style="white-space:nowrap">${daEsc((r.studyDate || '').slice(0, 16).replace('T', ' '))}</td>
      <td style="white-space:nowrap"><b>${daEsc(r.mrno)}</b>${r.patId && String(r.patId) !== r.mrno ? `<div style="font-size:10px;color:#8a6d3b">PACS: ${daEsc(r.patId)}</div>` : ''}</td>
      <td>${daEsc(r.name)}</td>
      <td style="text-align:center">${daEsc(r.sex || '')}</td>
      <td style="text-align:center">${daEsc(r.modality || '')}</td>
      <td>${daEsc(r.exam || '')}</td>
      <td style="white-space:nowrap">${daEsc(r.status || '')}</td>
      <td style="white-space:nowrap">${flag}</td>
    </tr>`;
  }).join('');
  body.innerHTML = `<table class="tbl" style="width:100%;font-size:12.5px"><thead><tr>
      <th style="width:34px" title="tick to exclude">✓</th><th>Study date</th><th>MRN</th><th>Patient</th>
      <th>Sex</th><th>Mod</th><th>Exam</th><th>Status</th><th>Accession</th>
    </tr></thead><tbody>${tr}</tbody></table>`;
}

function daToggleRow(studyId, checked) {
  if (checked) daState.excluded.add(studyId); else daState.excluded.delete(studyId);
  daRenderSummary();
  // update just the row style without a full re-render (keeps scroll position)
  daRenderTable();
}

function daExportCsv() {
  const rows = daVisibleRows();
  if (!rows.length) return;
  const H = ['Excluded', 'StudyDate', 'MRN', 'RawPatID', 'Patient', 'Sex', 'Modality', 'Exam', 'Status', 'Accession', 'NoAccession'];
  const q = (s) => { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [H.join(',')];
  for (const r of rows) {
    lines.push([daState.excluded.has(r.studyId) ? 'YES' : '', r.studyDate, r.mrno, r.patId, r.name, r.sex, r.modality, r.exam, r.status, r.accession || '', r.noAccession ? 'YES' : ''].map(q).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `depacs_arrivals_${daState.from}_${daState.to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
