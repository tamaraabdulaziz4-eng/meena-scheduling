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
  const tabs = [['cases', 'Cases trends'], ['fairness', 'Fairness'], ['qc', 'Equipment QC log']];
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
  if (ctrl) ctrl.innerHTML = _repMonthNav();
  body.innerHTML = LOADING_HTML;
  try {
    if (reportsTab === 'cases') return await loadCasesReport(body);
    if (reportsTab === 'fairness') return await loadFairnessReport(body);
    if (reportsTab === 'qc') return await loadQcReport(body);
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
