// ── Reports (team lead: own branch · manager: any/all) ────────────────────────
// Tabs: Patient report, Fairness (load distribution), the equipment-check (QC)
// log for accreditation, and licence expiry. Live radiology case trends now live
// on the Radiology Stats page (pulled straight from the HIS).

let reportsTab = 'lookup';
let reportsYear = new Date().getFullYear();
let reportsMonth = new Date().getMonth() + 1;
let reportsBranch = '';   // '' = all (manager only)

function _repIsReviewer() { return ['manager', 'superadmin'].includes(currentUser?.role); }

async function renderReportsPage() {
  setTopbar('Reports', 'Fairness & equipment-check log');
  // A team lead is pinned to their branch; a manager can pick.
  if (!_repIsReviewer()) reportsBranch = String(currentUser?.branch_id || '');
  const c = document.getElementById('content');
  const tabs = [['lookup', 'Patient report'], ['fairness', 'Fairness'], ['qc', 'Equipment QC log'], ['credentials', 'Licenses & expiry']];
  c.innerHTML = `
    <div class="cc">
    ${pageHero('Reports', 'Reports', 'Balance the load and keep an audit-ready check log')}
    <div class="rep-toolbar">
      <div class="seg" id="rep-tabs">${tabs.map(([v, l]) =>
        `<button data-t="${v}" class="${v === reportsTab ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${_repIsReviewer() ? `<select id="rep-branch" class="rep-select" style="max-width:220px"></select>` : ''}
    </div>
    <div id="rep-controls" style="margin-bottom:14px"></div>
    <div id="rep-body">${LOADING_HTML}</div>
    </div>`;
  c.querySelectorAll('#rep-tabs button').forEach(b =>
    b.onclick = () => { reportsTab = b.getAttribute('data-t'); renderReportsPage(); });
  if (_repIsReviewer()) {
    try { if (!allBranches.length) await loadBranches(); } catch (e) {}
    const sel = document.getElementById('rep-branch');
    if (sel) {
      const opts = reportsTab === 'fairness'
        ? allBranches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')
        : `<option value="">All branches</option>` + allBranches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
      sel.innerHTML = opts;
      if (reportsTab === 'fairness' && !reportsBranch) reportsBranch = String(allBranches[0]?.id || '');
      sel.value = reportsBranch;
      sel.onchange = () => { reportsBranch = sel.value; loadReportBody(); };
    }
  }
  loadReportBody();
}

function _repMonthNav() {
  return `<div class="month-nav" style="margin-bottom:4px">
      <button onclick="repChangeMonth(-1)">&#8249;</button>
      <span class="month-label">${monthLabel(reportsYear, reportsMonth)}</span>
      <button onclick="repChangeMonth(1)">&#8250;</button></div>`;
}
function repChangeMonth(d) {
  reportsMonth += d;
  if (reportsMonth < 1) { reportsMonth = 12; reportsYear--; }
  if (reportsMonth > 12) { reportsMonth = 1; reportsYear++; }
  loadReportBody();
}

function _repRange() {
  // QC uses the selected month as the range.
  const last = new Date(reportsYear, reportsMonth, 0).getDate();
  const mm = String(reportsMonth).padStart(2, '0');
  return [`${reportsYear}-${mm}-01`, `${reportsYear}-${mm}-${String(last).padStart(2, '0')}`];
}

async function loadReportBody() {
  const ctrl = document.getElementById('rep-controls');
  const body = document.getElementById('rep-body');
  if (!body) return;
  if (ctrl) ctrl.innerHTML = (reportsTab === 'qc') ? _repMonthNav() : '';
  body.innerHTML = LOADING_HTML;
  try {
    if (reportsTab === 'lookup') return await loadReportLookup(body);
    if (reportsTab === 'fairness') return await loadFairnessReport(body);
    if (reportsTab === 'qc') return await loadQcReport(body);
    if (reportsTab === 'credentials') return await loadCredentialsReport(body);
  } catch (e) {
    body.innerHTML = `<div class="empty"><p>${escapeHtml(e.message || 'Failed to load')}</p></div>`;
  }
}

// ── Fairness ──────────────────────────────────────────────────────────────────
async function loadFairnessReport(body) {
  if (!reportsBranch) { body.innerHTML = `<div class="rep-card"><div class="rep-empty">Pick a branch to see its load distribution.</div></div>`; return; }
  const d = await API.get(`/reports/fairness?branch_id=${reportsBranch}&year=${reportsYear}&month=${reportsMonth}`);
  const rows = d.staff || [];
  if (!rows.length) { body.innerHTML = `<div class="rep-card"><div class="rep-empty">No staff in this branch yet.</div></div>`; return; }
  const maxN = Math.max(1, ...rows.map(r => r.nights));
  const maxShifts = Math.max(1, ...rows.map(r => r.shifts));
  const loadBar = (val, max, hot) => `<div class="rep-load">
      <span class="rep-num">${val}</span>
      <div class="rep-load-track"><div class="rep-load-fill${hot ? ' hot' : ''}" style="width:${Math.round((val / max) * 100)}%"></div></div></div>`;
  const _th = `<div class="lrow" style="background:var(--card-alt);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);font-weight:600">
      <span style="flex:1;min-width:130px">Name</span>
      <span style="width:96px">Section</span>
      <span style="width:120px">Shifts</span>
      <span style="width:120px">Nights</span>
      <span style="width:66px;text-align:right">Mornings</span>
      <span style="width:66px;text-align:right">Weekends</span>
      <span style="width:58px;text-align:right">On-call</span>
      <span style="width:48px;text-align:right">Leave</span>
    </div>`;
  body.innerHTML = `<div class="listcard">
    ${_th}
    ${rows.map(r => {
      const hottest = r.nights >= maxN && maxN > 0;
      return `<div class="lrow" style="flex-wrap:wrap">
      <span style="flex:1;min-width:130px;font-weight:600">${escapeHtml(r.name)}</span>
      <span style="width:96px"><span class="rep-pill rep-pill-muted">${r.section === 'US' ? 'Ultrasound' : 'General'}</span></span>
      <span style="width:120px">${loadBar(r.shifts, maxShifts, false)}</span>
      <span style="width:120px">${loadBar(r.nights, maxN, hottest)}</span>
      <span style="width:66px;text-align:right">${r.mornings}</span>
      <span style="width:66px;text-align:right">${r.weekends}</span>
      <span style="width:58px;text-align:right">${r.oncall}</span>
      <span style="width:48px;text-align:right">${r.leave_days}</span>
    </div>`; }).join('')}</div>
    <div style="font-size:12px;color:var(--muted);margin-top:12px">The red bar marks whoever carries the most nights this month — use it to rebalance next month.</div>`;
}

// ── Licenses & expiry ─────────────────────────────────────────────────────────
const _CRED_KINDS = [
  ['moh_license', 'MOH License'], ['scfhs', 'Saudi Council'], ['classification', 'Classification'],
  ['bls', 'BLS'], ['acls', 'ACLS'], ['national_id', 'National ID / Iqama'], ['iqama', 'Iqama'],
  ['passport', 'Passport'], ['malpractice', 'Malpractice Insurance'],
  ['cv', 'CV'], ['transcript', 'Transcript'], ['diploma', 'Diploma'], ['other', 'Other'],
];
// Kinds that carry an expiry (must match the server's _EXPIRING_KINDS).
const _CRED_EXP_KINDS = new Set(['moh_license', 'scfhs', 'classification', 'bls', 'acls',
  'national_id', 'iqama', 'passport', 'malpractice']);
function _credKindLabel(k) { const f = _CRED_KINDS.find(x => x[0] === k); return f ? f[1] : (k || 'Other'); }
// Print one staff member's full employee file (all their document rows).
function printStaffFile(staffId) {
  const rows = _credRows.filter(r => r.staff_id === staffId);
  if (!rows.length) { toast('No documents on file yet', 'err'); return; }
  printEmployeeFile({ name: rows[0].staff_name, branch_name: rows[0].branch_name }, rows);
}
function _credStatus(d) {
  // → [text, pill-class]
  if (d === null || d === undefined) return ['No date', 'rep-pill-muted'];
  d = Number(d);
  if (d < 0) return [`Expired ${Math.abs(d)}d ago`, 'rep-pill-red'];
  if (d === 0) return ['Expires today', 'rep-pill-red'];
  if (d <= 30) return [`${d}d left`, 'rep-pill-amber'];
  if (d <= 60) return [`${d}d left`, 'rep-pill-gold'];
  return [`${d}d left`, 'rep-pill-ok'];
}

let _credRows = [];   // last-loaded credentials, so Edit can look up by id (no unsafe inline JSON)

async function loadCredentialsReport(body) {
  const qs = reportsBranch ? `?branch_id=${reportsBranch}` : '';
  const rows = await API.get(`/credentials${qs}`);
  _credRows = rows;
  const showBranch = _repIsReviewer() && !reportsBranch;
  body.innerHTML = `
    <div class="rep-card">
      <div class="rep-card-head">
        <div>
          <div class="rep-card-title">Licenses &amp; expiry</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">Staff and their branch lead are reminded automatically as expiry nears.</div>
        </div>
        <button class="btn btn-sm btn-primary" onclick="openCredentialModal()">+ Add credential</button>
      </div>
      ${(() => {
        const byStaff = {};
        rows.forEach(r => { if (!byStaff[r.staff_id]) byStaff[r.staff_id] = { id: r.staff_id, name: r.staff_name }; });
        const chips = Object.values(byStaff).map(s =>
          `<button class="btn btn-xs btn-ghost" onclick="printStaffFile(${s.id})">🖨️ ${escapeHtml(s.name)}</button>`).join('');
        return chips ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 4px;padding:10px;border:1px dashed var(--border);border-radius:10px">
          <span style="font-size:12px;color:var(--muted);align-self:center;margin-inline-end:4px">Print employee file:</span>${chips}</div>` : '';
      })()}
      <div class="listcard" style="margin-top:10px">
        <div class="lrow" style="background:var(--card-alt);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);font-weight:600">
          <span style="flex:1;min-width:120px">Staff</span>
          ${showBranch ? `<span style="width:120px">Branch</span>` : ''}
          <span style="width:130px">Type</span>
          <span style="flex:1;min-width:100px">Label</span>
          <span style="width:120px">Number</span>
          <span style="width:110px">Expiry</span>
          <span style="width:110px">Status</span>
          <span style="width:130px;text-align:right"></span>
        </div>
        ${rows.length ? rows.map(r => {
          const [txt, cls] = _credStatus(r.days_left);
          return `<div class="lrow" style="flex-wrap:wrap">
            <span style="flex:1;min-width:120px;font-weight:600">${escapeHtml(r.staff_name || '')}</span>
            ${showBranch ? `<span style="width:120px;font-size:11px;color:var(--muted)">${escapeHtml(r.branch_name || '')}</span>` : ''}
            <span style="width:130px">${escapeHtml(_credKindLabel(r.kind))}</span>
            <span style="flex:1;min-width:100px">${escapeHtml(r.label || '—')}</span>
            <span style="width:120px">${escapeHtml(r.number || '—')}</span>
            <span style="width:110px">${escapeHtml(r.expiry_date || '—')}</span>
            <span style="width:110px"><span class="rep-pill ${cls}">${txt}</span></span>
            <span style="width:130px;white-space:nowrap;text-align:right">
              <button class="btn btn-xs btn-ghost" onclick="openCredentialModal(${r.id})">Edit</button>
              <button class="btn btn-xs btn-ghost" style="color:var(--danger-ink,#e25555);margin-left:4px" onclick="deleteCredential(${r.id})">Delete</button>
            </span>
          </div>`;
        }).join('') : `<div class="lrow" style="justify-content:center;padding:22px;color:var(--muted)">No credentials yet. Add one to start tracking expiry.</div>`}
      </div>
    </div>`;
}

async function openCredentialModal(credId) {
  // Add → no id; Edit → look the row up by id (avoids unsafe inline JSON in onclick).
  const cred = (credId != null) ? (_credRows.find(r => r.id === credId) || null) : null;
  // Staff list scoped to the selected branch (manager) or the lead's branch.
  try { if (!allStaff || !allStaff.length) await loadStaff(); } catch (e) {}
  const branchId = reportsBranch ? Number(reportsBranch) : null;
  const staff = (allStaff || [])
    .filter(s => s.active !== false && (!branchId || Number(s.branch_id) === branchId))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const staffOpts = staff.map(s =>
    `<option value="${s.id}" ${cred && cred.staff_id === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
  const kindOpts = _CRED_KINDS.map(([v, l]) =>
    `<option value="${v}" ${cred && cred.kind === v ? 'selected' : ''}>${l}</option>`).join('');
  showModal('credential-modal', `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <h3 style="margin:0">${cred ? 'Edit credential' : 'Add credential'}</h3>
      <button class="modal-close" onclick="closeModal('credential-modal')">&times;</button>
    </div>
    <input type="hidden" id="cred-id" value="${cred ? cred.id : ''}">
    <div style="display:grid;gap:12px">
      <label style="font-size:13px">Staff
        <select id="cred-staff" class="input" ${cred ? 'disabled' : ''} style="width:100%;margin-top:4px">${staffOpts || '<option value="">No staff in scope</option>'}</select>
      </label>
      <label style="font-size:13px">Type
        <select id="cred-kind" class="input" style="width:100%;margin-top:4px">${kindOpts}</select>
      </label>
      <label style="font-size:13px">Label (optional)
        <input id="cred-label" class="input" maxlength="80" placeholder="e.g. Radiology specialist" value="${cred ? escapeHtml(cred.label || '') : ''}" style="width:100%;margin-top:4px">
      </label>
      <label style="font-size:13px">Number (optional)
        <input id="cred-number" class="input" maxlength="60" value="${cred ? escapeHtml(cred.number || '') : ''}" style="width:100%;margin-top:4px">
      </label>
      <label style="font-size:13px">Issue date (optional)
        <input id="cred-issue" type="date" class="input" value="${cred ? (cred.issue_date || '') : ''}" style="width:100%;margin-top:4px">
      </label>
      <label style="font-size:13px">Expiry date <span style="color:var(--muted);font-weight:400">(required for licenses/IDs)</span>
        <input id="cred-expiry" type="date" class="input" value="${cred ? (cred.expiry_date || '') : ''}" style="width:100%;margin-top:4px">
      </label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
      <button class="btn btn-ghost" onclick="closeModal('credential-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="saveCredential()">${cred ? 'Save' : 'Add'}</button>
    </div>`);
}

async function saveCredential() {
  const id = document.getElementById('cred-id').value;
  const payload = {
    staff_id: Number(document.getElementById('cred-staff').value),
    kind: document.getElementById('cred-kind').value,
    label: document.getElementById('cred-label').value.trim(),
    number: document.getElementById('cred-number').value.trim(),
    issue_date: document.getElementById('cred-issue').value,
    expiry_date: document.getElementById('cred-expiry').value,
  };
  if (!payload.staff_id) { toast('Pick a staff member', 'err'); return; }
  if (_CRED_EXP_KINDS.has(payload.kind) && !payload.expiry_date) {
    toast('This document needs an expiry date', 'err'); return;
  }
  try {
    if (id) await API.put(`/credentials/${id}`, payload);
    else await API.post('/credentials', payload);
    closeModal('credential-modal');
    toast(id ? 'Credential updated' : 'Credential added', 'ok');
    loadReportBody();
  } catch (e) { toast(e.message || 'Failed to save', 'err'); }
}

async function deleteCredential(id) {
  if (!confirm('Delete this credential?')) return;
  try { await API.delete(`/credentials/${id}`); toast('Deleted', 'ok'); loadReportBody(); }
  catch (e) { toast(e.message || 'Failed to delete', 'err'); }
}

// ── Equipment QC log ──────────────────────────────────────────────────────────
async function loadQcReport(body) {
  const [from, to] = _repRange();
  const qs = `from=${from}&to=${to}${reportsBranch ? `&branch_id=${reportsBranch}` : ''}`;
  const d = await API.get(`/reports/qc-log?${qs}`);
  const log = d.log || [];
  body.innerHTML = `
    <div class="rep-card">
      <div class="rep-card-head">
        <div class="rep-card-title">Equipment check log — ${monthLabel(reportsYear, reportsMonth)}</div>
        <button class="btn btn-sm btn-ghost" onclick="window.print()">Print / PDF</button>
      </div>
      <div class="listcard" style="margin-top:10px">
        <div class="lrow" style="background:var(--card-alt);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);font-weight:600">
          <span style="width:120px">Date</span>
          <span style="width:120px">Shift</span>
          <span style="flex:1;min-width:120px">Branch</span>
          <span style="flex:1;min-width:130px">Confirmed by</span>
          <span style="width:170px">Time</span>
        </div>
        ${log.length ? log.map(r => `<div class="lrow" style="flex-wrap:wrap">
          <span style="width:120px;font-weight:600">${escapeHtml(r.date)}</span>
          <span style="width:120px"><span class="rep-pill rep-pill-muted">${escapeHtml(r.shift_label)}</span></span>
          <span style="flex:1;min-width:120px">${escapeHtml(r.branch_name)}</span>
          <span style="flex:1;min-width:130px">${r.confirmed_by ? escapeHtml(r.confirmed_by) : '<span class="rep-pill rep-pill-amber">not confirmed</span>'}</span>
          <span style="width:170px">${r.confirmed_at ? new Date(r.confirmed_at).toLocaleString('en-GB') : '—'}</span>
        </div>`).join('') : `<div class="lrow" style="justify-content:center;padding:22px;color:var(--muted)">No checks logged for this month.</div>`}
      </div>
    </div>`;
}

// ── Patient report lookup (Butterfly / DePACS) ────────────────────────────────
async function loadReportLookup(body) {
  let cfg = null;
  if (currentUser?.role === 'superadmin') { try { cfg = await API.get('/reports/config'); } catch (e) {} }
  body.innerHTML = `
    ${cfg ? `<div class="rep-card" style="margin-bottom:14px">
      <div class="rep-card-title">Butterfly account ${cfg.configured ? '🟢' : '⚪'}</div>
      <div style="font-size:12px;color:var(--muted);margin:4px 0 10px">Sign-in used to fetch reports.${cfg.configured ? ' Set for <b>' + escapeHtml(cfg.username) + '</b>.' : ' Not set yet.'}</div>
      <div style="display:grid;gap:8px;max-width:420px">
        <input id="rep-cfg-user" class="input" placeholder="Username" value="${escapeHtml(cfg.username || '')}">
        <input id="rep-cfg-pass" class="input" type="password" placeholder="Password ${cfg.configured ? '(leave blank to keep)' : ''}">
        <div><button class="btn btn-sm btn-primary" onclick="repSaveConfig()">Save account</button></div>
      </div></div>` : ''}
    <div class="rep-card">
      <div class="rep-card-title">Patient report lookup</div>
      <div style="font-size:12px;color:var(--muted);margin:4px 0 10px">Enter a patient file number to find their radiology studies and open the report.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="rep-file" class="input" placeholder="Patient file number" style="flex:1;min-width:180px" onkeydown="if(event.key==='Enter')repDoSearch()">
        <button class="btn btn-primary" onclick="repDoSearch()">Search</button>
      </div>
      <div id="rep-lookup-results" style="margin-top:14px"></div>
    </div>`;
}

async function repSaveConfig() {
  const username = (document.getElementById('rep-cfg-user')?.value || '').trim();
  const password = (document.getElementById('rep-cfg-pass')?.value || '');
  try { await API.put('/reports/config', { username, password }); toast('Account saved'); loadReportBody(); }
  catch (e) { toast(e.message || 'Failed to save', 'err'); }
}

async function repDoSearch() {
  const file = (document.getElementById('rep-file')?.value || '').trim();
  const box = document.getElementById('rep-lookup-results');
  if (!box) return;
  if (!file) { toast('Enter a file number', 'err'); return; }
  box.innerHTML = LOADING_HTML;
  try {
    const d = await API.get(`/reports/search?file_no=${encodeURIComponent(file)}`);
    const studies = d.studies || [];
    if (!studies.length) { box.innerHTML = `<div class="rep-empty">No studies found for file ${escapeHtml(file)}.</div>`; return; }
    box.innerHTML = `<div style="font-size:12px;color:var(--muted);margin-bottom:8px">${d.count || studies.length} study(ies) for <b>${escapeHtml(studies[0].pat_name || file)}</b></div>` +
      studies.map(s => {
        const dt = s.study_date ? new Date(s.study_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        const ready = /\b(VERIFIED|APPROVED|SIGNED|COMPLETED|REVIEWED|ADDENDUM|FINAL)\b/i.test(s.status || '');
        return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px">
          <div style="min-width:0">
            <div style="font-weight:600;font-size:13px">${escapeHtml(s.modality || '')} · ${dt}</div>
            <div style="font-size:11px;color:var(--muted)">${escapeHtml(s.history || '—')} · <span style="color:${ready ? 'var(--green,#0a0)' : 'var(--muted)'}">${escapeHtml(s.status || '')}</span></div>
          </div>
          <button class="btn btn-sm" onclick="repViewStudy(${s.study_id})">Open report</button>
        </div>`;
      }).join('');
  } catch (e) { box.innerHTML = `<div class="rep-empty">${escapeHtml(e.message || 'Search failed')}</div>`; }
}

async function repViewStudy(studyId) {
  const box = document.getElementById('rep-lookup-results');
  if (!box) return;
  box.innerHTML = LOADING_HTML;
  try {
    const r = await API.get(`/reports/study/${studyId}`);
    const dt = r.study_date ? new Date(r.study_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    const html = (r.report_html || '').trim();
    box.innerHTML = `
      <button class="btn btn-xs btn-ghost" onclick="repDoSearch()">← Back to results</button>
      <div class="rep-card" style="margin-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <div><div style="font-weight:700">${escapeHtml(r.pat_name || '')}</div>
            <div style="font-size:12px;color:var(--muted)">${escapeHtml(r.modality || '')} · ${dt} · ${escapeHtml(r.pat_age || '')} ${escapeHtml(r.pat_sex || '')}</div></div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm" onclick="window.open('/api/reports/study/${studyId}/pdf?style=2','_blank')">Open PDF</button>
            <a class="btn btn-sm btn-primary" href="/api/reports/study/${studyId}/pdf?style=2" download="report_${studyId}.pdf">Download</a>
          </div>
        </div>
        ${r.history ? `<div style="font-size:12px;margin-top:8px"><b>Clinical history:</b> ${escapeHtml(r.history)}</div>` : ''}
        ${html ? `<iframe id="rep-frame" sandbox="" style="width:100%;min-height:440px;border:1px solid var(--border);border-radius:8px;margin-top:10px;background:#fff"></iframe>`
               : `<div class="rep-empty" style="margin-top:10px">No written report yet for this study.</div>`}
      </div>`;
    if (html) {
      // Render the vendor's report HTML in a sandboxed iframe (no scripts) so
      // external markup can't touch the app.
      document.getElementById('rep-frame').srcdoc =
        `<style>body{font-family:system-ui,Arial,sans-serif;font-size:13px;color:#111;padding:16px;line-height:1.6}p{margin:0 0 6px}</style>${html}`;
    }
  } catch (e) { toast(e.message || 'Could not open report', 'err'); repDoSearch(); }
}
