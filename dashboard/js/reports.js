// ── Reports (team lead: own branch · manager: any/all) ────────────────────────
// Three tabs: Cases trends, Fairness (load distribution), and the equipment-check
// (QC) log for accreditation.

let reportsTab = 'cases';
let reportsYear = new Date().getFullYear();
let reportsMonth = new Date().getMonth() + 1;
let reportsBranch = '';   // '' = all (manager only)

function _repIsReviewer() { return ['manager', 'superadmin'].includes(currentUser?.role); }

async function renderReportsPage() {
  setTopbar('Reports', 'Cases, fairness & equipment-check log');
  // A team lead is pinned to their branch; a manager can pick.
  if (!_repIsReviewer()) reportsBranch = String(currentUser?.branch_id || '');
  const c = document.getElementById('content');
  const tabs = [['cases', 'Cases trends'], ['fairness', 'Fairness'], ['qc', 'Equipment QC log'], ['credentials', 'Licenses & expiry']];
  c.innerHTML = `
    ${pageHero('Reports', 'Reports', 'Track cases, balance the load, and keep an audit-ready check log')}
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
      <div class="seg" id="rep-tabs">${tabs.map(([v, l]) =>
        `<button data-t="${v}" class="${v === reportsTab ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${_repIsReviewer() ? `<select id="rep-branch" style="max-width:200px"></select>` : ''}
    </div>
    <div id="rep-controls" style="margin-bottom:12px"></div>
    <div id="rep-body">${LOADING_HTML}</div>`;
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
  // Cases/QC use the selected month as the range.
  const last = new Date(reportsYear, reportsMonth, 0).getDate();
  const mm = String(reportsMonth).padStart(2, '0');
  return [`${reportsYear}-${mm}-01`, `${reportsYear}-${mm}-${String(last).padStart(2, '0')}`];
}

async function loadReportBody() {
  const ctrl = document.getElementById('rep-controls');
  const body = document.getElementById('rep-body');
  if (!body) return;
  if (ctrl) ctrl.innerHTML = (reportsTab === 'cases' || reportsTab === 'qc') ? _repMonthNav() : '';
  body.innerHTML = LOADING_HTML;
  try {
    if (reportsTab === 'cases') return await loadCasesReport(body);
    if (reportsTab === 'fairness') return await loadFairnessReport(body);
    if (reportsTab === 'qc') return await loadQcReport(body);
    if (reportsTab === 'credentials') return await loadCredentialsReport(body);
  } catch (e) {
    body.innerHTML = `<div class="empty"><p>${escapeHtml(e.message || 'Failed to load')}</p></div>`;
  }
}

// ── Cases trends ──────────────────────────────────────────────────────────────
async function loadCasesReport(body) {
  const [from, to] = _repRange();
  const qs = `from=${from}&to=${to}${reportsBranch ? `&branch_id=${reportsBranch}` : ''}`;
  const d = await API.get(`/reports/cases?${qs}`);
  const t = d.totals || {};
  const kpi = (label, val) => `<div style="flex:1;min-width:90px;background:var(--card);border:1px solid var(--border);
      border-radius:12px;padding:12px"><div style="font-size:22px;font-weight:800">${val ?? 0}</div>
      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">${label}</div></div>`;
  const maxv = Math.max(1, ...(d.series || []).map(s => s.total_cases));
  const bars = (d.series || []).map(s => {
    const h = Math.round((s.total_cases / maxv) * 90);
    return `<div title="${s.date}: ${s.total_cases} cases" style="flex:1;min-width:6px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center">
        <div style="width:70%;height:${h}px;background:var(--accent);border-radius:3px 3px 0 0"></div></div>`;
  }).join('');
  body.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      ${kpi('Total cases', t.total_cases)}${kpi('Patients', t.total_pt)}
      ${kpi('X-Ray', t.xray)}${kpi('CT', t.ct)}${kpi('US', t.us)}${kpi('MAMO', t.mamo)}${kpi('BMD', t.bmd)}${kpi('CD', t.insert_cd)}
    </div>
    <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px">
      <div style="font-weight:700;font-size:13px;margin-bottom:10px">Daily cases — ${monthLabel(reportsYear, reportsMonth)}</div>
      <div style="display:flex;gap:2px;align-items:flex-end;height:100px">${bars || '<div style="color:var(--muted);font-size:13px">No data for this month.</div>'}</div>
    </div>
    <div style="font-size:12px;color:var(--muted);margin-top:10px">BMD not done: <b>${t.bmd_not_done || 0}</b> · MAMO not done: <b>${t.mamo_not_done || 0}</b> · days with data: <b>${d.rows || 0}</b></div>`;
}

// ── Fairness ──────────────────────────────────────────────────────────────────
async function loadFairnessReport(body) {
  if (!reportsBranch) { body.innerHTML = `<div class="empty"><p>Pick a branch.</p></div>`; return; }
  const d = await API.get(`/reports/fairness?branch_id=${reportsBranch}&year=${reportsYear}&month=${reportsMonth}`);
  const rows = d.staff || [];
  if (!rows.length) { body.innerHTML = `<div class="empty"><p>No staff.</p></div>`; return; }
  const maxN = Math.max(1, ...rows.map(r => r.nights));
  body.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Section</th><th>Shifts</th><th>Nights</th><th>Mornings</th><th>Weekends</th><th>On-call</th><th>Leave</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td style="font-weight:600">${escapeHtml(r.name)}</td>
      <td><span style="font-size:11px;color:var(--muted)">${r.section === 'US' ? 'Ultrasound' : 'General'}</span></td>
      <td>${r.shifts}</td>
      <td><b style="color:${r.nights >= maxN && maxN > 0 ? '#E25555' : 'inherit'}">${r.nights}</b></td>
      <td>${r.mornings}</td><td>${r.weekends}</td><td>${r.oncall}</td><td>${r.leave_days}</td>
    </tr>`).join('')}</tbody></table></div>
    <div style="font-size:12px;color:var(--muted);margin-top:10px">Red = the most nights this month. Use it to balance the load next month.</div>`;
}

// ── Licenses & expiry ─────────────────────────────────────────────────────────
const _CRED_KINDS = [
  ['scfhs', 'SCFHS registration'], ['classification', 'Classification'],
  ['bls', 'BLS'], ['acls', 'ACLS'], ['iqama', 'Iqama'],
  ['passport', 'Passport'], ['other', 'Other'],
];
function _credKindLabel(k) { const f = _CRED_KINDS.find(x => x[0] === k); return f ? f[1] : (k || 'Other'); }
function _credStatus(d) {
  if (d === null || d === undefined) return ['No date', 'var(--muted)'];
  d = Number(d);
  if (d < 0) return [`Expired ${Math.abs(d)}d ago`, '#E25555'];
  if (d === 0) return ['Expires today', '#E25555'];
  if (d <= 30) return [`${d}d left`, '#E2933F'];
  if (d <= 60) return [`${d}d left`, '#C9A227'];
  return [`${d}d left`, 'var(--muted)'];
}

let _credRows = [];   // last-loaded credentials, so Edit can look up by id (no unsafe inline JSON)

async function loadCredentialsReport(body) {
  const qs = reportsBranch ? `?branch_id=${reportsBranch}` : '';
  const rows = await API.get(`/credentials${qs}`);
  _credRows = rows;
  const showBranch = _repIsReviewer() && !reportsBranch;
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <div style="font-size:12px;color:var(--muted)">Track licenses, classifications and IDs. Staff and their branch lead are reminded as expiry nears.</div>
      <button class="btn btn-sm btn-primary" onclick="openCredentialModal()">Add credential</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Staff</th>${showBranch ? '<th>Branch</th>' : ''}<th>Type</th><th>Label</th><th>Number</th><th>Expiry</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map(r => {
        const [txt, col] = _credStatus(r.days_left);
        return `<tr>
          <td style="font-weight:600">${escapeHtml(r.staff_name || '')}</td>
          ${showBranch ? `<td><span style="font-size:11px;color:var(--muted)">${escapeHtml(r.branch_name || '')}</span></td>` : ''}
          <td>${escapeHtml(_credKindLabel(r.kind))}</td>
          <td>${escapeHtml(r.label || '—')}</td>
          <td>${escapeHtml(r.number || '—')}</td>
          <td>${escapeHtml(r.expiry_date || '—')}</td>
          <td><b style="color:${col}">${txt}</b></td>
          <td style="white-space:nowrap;text-align:right">
            <button class="btn btn-xs btn-ghost" onclick="openCredentialModal(${r.id})">Edit</button>
            <button class="btn btn-xs btn-ghost" style="color:#E25555" onclick="deleteCredential(${r.id})">Delete</button>
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="${showBranch ? 8 : 7}" style="text-align:center;color:var(--muted);padding:20px">No credentials yet. Add one to start tracking expiry.</td></tr>`}</tbody>
    </table></div>`;
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
      <label style="font-size:13px">Expiry date
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
    expiry_date: document.getElementById('cred-expiry').value,
  };
  if (!payload.staff_id) { toast('Pick a staff member', 'err'); return; }
  if (!payload.expiry_date) { toast('Expiry date is required', 'err'); return; }
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
    <div style="margin-bottom:10px"><button class="btn btn-sm btn-ghost" onclick="window.print()">🖨 Print / PDF</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Shift</th><th>Branch</th><th>Confirmed by</th><th>Time</th></tr></thead>
      <tbody>${log.length ? log.map(r => `<tr>
        <td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.shift_label)}</td>
        <td>${escapeHtml(r.branch_name)}</td><td>${escapeHtml(r.confirmed_by || '—')}</td>
        <td>${r.confirmed_at ? new Date(r.confirmed_at).toLocaleString('en-GB') : ''}</td>
      </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px">No checks logged for this month.</td></tr>`}</tbody>
    </table></div>`;
}
