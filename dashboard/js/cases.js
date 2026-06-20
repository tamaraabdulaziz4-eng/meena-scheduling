// ── Daily radiology cases ─────────────────────────────────────────────────────
// Manager: live per-branch cards for a day. Team lead / eligible staff: fill &
// submit (locks) their branch's report.
// The "reporting day": a night shift runs into the early morning, so before the
// 08:00 morning handover the shift is still closing OUT YESTERDAY. Default the
// report date to yesterday until 8 AM so a 1–2 AM entry lands on the right day
// (and the night-staff eligibility check matches that day's schedule).
const CASES_ROLLOVER_HOUR = 8;
function operationalDate() {
  // Compute the reporting day in KSA (Asia/Riyadh) so it matches the server no
  // matter the viewer's local timezone — otherwise a non-KSA user near 08:00
  // would file on the wrong day.
  const ksa = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
  if (ksa.getHours() < CASES_ROLLOVER_HOUR) ksa.setDate(ksa.getDate() - 1);
  return fmtDate(ksa);
}
let casesDate = operationalDate();
let casesData = null;
let _casesTimer = null;

function renderCasesPage() {
  // Fresh "reporting day" default each time the page opens (handles past-midnight entry).
  casesDate = operationalDate();
  const isReviewer = ['superadmin', 'manager'].includes(currentUser?.role);
  setTopbar('Daily Cases', 'Radiology cases per branch',
    `${isReviewer ? `<button class="btn btn-ghost btn-sm" onclick="remindPendingCases()">⏰ Remind pending</button>` : ''}
     <button class="btn btn-ghost btn-sm" onclick="printCases()">🖨 Print / PDF</button>`);
  const weekday = new Date().toLocaleDateString('en-GB', { weekday: 'long' });
  const c = document.getElementById('content');
  c.innerHTML = `
    <div id="cases-print-title" style="display:none"></div>
    <div class="phero no-print">
      <div class="phero-orb p1"></div><div class="phero-orb p2"></div>
      <div class="phero-inner">
        <div class="phero-logo"><img src="/meena_logo.png" alt="Meena"></div>
        <div class="phero-text">
          <div class="phero-hi">${weekday} · Radiology cases per branch</div>
          <div class="phero-title">Daily Cases</div>
          <div class="phero-sub" id="cases-hero-sub">Loading today's report…</div>
        </div>
      </div>
    </div>
    <div class="month-nav" style="margin-bottom:4px">
      <button onclick="changeCasesDay(-1)">&#8249;</button>
      <span class="month-label" id="cases-date-label"></span>
      <button onclick="changeCasesDay(1)">&#8250;</button>
    </div>
    <div class="no-print" style="font-size:11px;color:var(--muted);margin-bottom:14px">
      📅 Reporting day — a night shift filed after midnight still belongs to the day it covered.
    </div>
    <div id="cases-summary"></div>
    <div id="cases-cards" class="cases-grid">${LOADING_HTML}</div>`;
  // Live refresh while the manager is watching.
  if (_casesTimer) clearInterval(_casesTimer);
  _casesTimer = setInterval(() => { if (currentPage === 'cases') loadCases(true); else { clearInterval(_casesTimer); _casesTimer = null; } }, 60000);
  loadCases();
}

async function changeCasesDay(delta) {
  const d = new Date(casesDate); d.setDate(d.getDate() + delta); casesDate = fmtDate(d);
  const box = document.getElementById('cases-cards');
  if (box) box.innerHTML = LOADING_HTML;
  await loadCases();
  animateIn('cases-cards');
}

async function loadCases(silent) {
  const lbl = document.getElementById('cases-date-label');
  if (lbl) lbl.textContent = fmtDateDisplay(casesDate);
  try {
    casesData = await API.get(`/daily-cases/overview?date=${casesDate}`);
    renderCases();
  } catch (e) {
    if (!silent) document.getElementById('cases-cards').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠️</div><p>${escapeHtml(e.message)}</p></div>`;
  }
}

// Trust the server's per-branch can_edit (it knows can_report / night-shift
// eligibility); fall back to a role/branch guess only if it's absent.
function canEditBranch(b) {
  if (b && typeof b.can_edit === 'boolean') return b.can_edit;
  const r = currentUser?.role;
  if (['superadmin', 'manager'].includes(r)) return true;
  const bid = b && typeof b === 'object' ? b.branch_id : b;
  return bid === currentUser?.branch_id && ['admin', 'staff'].includes(r);
}

function renderCases() {
  const s = casesData.summary || {};
  document.getElementById('cases-print-title').textContent =
    `Daily Radiology Cases — ${fmtDateDisplay(casesDate)}`;
  const heroSub = document.getElementById('cases-hero-sub');
  if (heroSub) heroSub.innerHTML =
    `${fmtDateDisplay(casesDate)} · <b>${s.submitted || 0}/${s.branches || 0}</b> branches submitted · ${s.total_cases || 0} cases`;
  document.getElementById('cases-summary').innerHTML = `
    <div class="cases-summary">
      <div class="cs-pill"><b>${s.total_cases || 0}</b> total cases</div>
      <div class="cs-pill"><b>${s.total_pt || 0}</b> patients</div>
      <div class="cs-pill"><b>${s.submitted || 0}/${s.branches || 0}</b> branches submitted</div>
      ${s.bmd_not_done ? `<div class="cs-pill warn">BMD not done: ${s.bmd_not_done}</div>` : ''}
      ${s.mamo_not_done ? `<div class="cs-pill warn">MAMO not done: ${s.mamo_not_done}</div>` : ''}
    </div>`;
  document.getElementById('cases-cards').innerHTML = (casesData.branches || []).map(caseCard).join('');
}

function chip(l, v) { return `<span class="cc-chip">${l} <b>${v || 0}</b></span>`; }

function caseCard(b) {
  const c = b.case;
  const editable = canEditBranch(b);
  const submitted = c && c.locked;
  const head = submitted
    ? `<span class="cc-ok">✅ ${c.submitted_by_name ? escapeHtml(c.submitted_by_name) : ''}${c.submitted_at ? ' · ' + notifTimeAgo(c.submitted_at) : ''}</span>`
    : `<span class="cc-pending"><span class="pending-dot"></span>Pending</span>`;
  const body = c ? `
    <div class="cc-big"><div><b>${c.total_cases}</b><span>cases</span></div><div><b>${c.total_pt || 0}</b><span>patients</span></div></div>
    <div class="cc-chips">${chip('X-RAY', c.xray)}${chip('CT', c.ct)}${chip('US', c.us)}${chip('MAMO', c.mamo)}${chip('BMD', c.bmd)}${chip('CD', c.insert_cd)}</div>
    ${(c.bmd_not_done || c.mamo_not_done) ? `<div class="cc-warn">${c.bmd_not_done ? `⚠ BMD not done: ${c.bmd_not_done}` : ''}${c.bmd_not_done && c.mamo_not_done ? ' · ' : ''}${c.mamo_not_done ? `⚠ MAMO not done: ${c.mamo_not_done}` : ''}</div>` : ''}`
    : `<div class="cc-empty">No report filed yet</div>`;
  const btn = editable
    ? `<button class="btn btn-ghost btn-sm no-print" onclick="openCaseModal(${b.branch_id})">${submitted ? 'View / Edit' : '✎ Fill report'}</button>` : '';
  return `<div class="case-card ${submitted ? 'done' : 'pending'}">
    <div class="cc-head"><b>${escapeHtml(b.branch_name)}</b> ${head}</div>
    ${body}
    <div class="cc-actions">${btn}</div>
  </div>`;
}

// ── Fill / edit modal ─────────────────────────────────────────────────────────
const CASE_INPUTS = ['xray', 'ct', 'us', 'mamo', 'bmd', 'insert_cd', 'total_pt', 'bmd_not_done', 'mamo_not_done'];
let caseModalBranch = null;

async function openCaseModal(branch_id) {
  caseModalBranch = branch_id;
  let c = {}, canEdit = true;
  try {
    const r = await API.get(`/daily-cases?branch_id=${branch_id}&date=${casesDate}`);
    c = r.case || {};
    if (typeof r.can_edit === 'boolean') canEdit = r.can_edit;
  } catch (e) {}
  const f = id => document.getElementById(id);
  CASE_INPUTS.forEach(k => { f('case-' + k).value = (c[k] != null ? c[k] : ''); });
  const bname = (casesData?.branches || []).find(x => x.branch_id === branch_id)?.branch_name || '';
  f('case-modal-title').textContent = `${bname} — ${fmtDateDisplay(casesDate)}`;
  f('case-msg').textContent = '';
  const isReviewer = ['superadmin', 'manager'].includes(currentUser?.role);
  // Read-only when the report is locked (non-reviewers) OR the server says this
  // user can't edit this branch today (e.g. not on Night / no report rights).
  const readOnly = (!!c.locked && !isReviewer) || (!isReviewer && !canEdit);
  document.querySelectorAll('#case-modal-overlay input').forEach(i => i.disabled = readOnly);
  f('case-save-btn').style.display = readOnly ? 'none' : '';
  f('case-submit-btn').style.display = readOnly ? 'none' : '';
  f('case-reopen-btn').style.display = (!!c.locked && isReviewer) ? '' : 'none';
  f('case-locked-note').style.display = readOnly ? '' : 'none';
  updateCaseTotal();
  f('case-modal-overlay').classList.add('open');
}

function updateCaseTotal() {
  const g = id => parseInt(document.getElementById('case-' + id).value || 0, 10) || 0;
  document.getElementById('case-total').textContent = g('xray') + g('ct') + g('us') + g('mamo') + g('bmd') + g('insert_cd');
}

function closeCaseModal() { document.getElementById('case-modal-overlay').classList.remove('open'); }

async function saveCase(submit) {
  if (submit) {
    const ok = await showConfirm('Submit report', 'Submit and lock today\'s report? You won\'t be able to edit it after (a manager can reopen it).', 'Submit');
    if (!ok) return;
  }
  const g = id => parseInt(document.getElementById('case-' + id).value || 0, 10) || 0;
  // Guard against negatives client-side too (the backend also rejects them).
  const neg = CASE_INPUTS.find(k => g(k) < 0);
  if (neg) {
    const m = document.getElementById('case-msg'); m.className = 'msg err';
    m.textContent = 'Counts can\'t be negative.'; return;
  }
  const body = { branch_id: caseModalBranch, date: casesDate, submit: !!submit };
  CASE_INPUTS.forEach(k => body[k] = g(k));
  showLoader(submit ? 'Submitting…' : 'Saving…');
  try {
    const res = await API.post('/daily-cases', body);
    closeCaseModal();
    await loadCases();
    toast(res?.warning || (submit ? 'Report submitted' : 'Saved'), res?.warning ? 'err' : undefined);
  } catch (e) {
    const m = document.getElementById('case-msg'); m.className = 'msg err'; m.textContent = e.message;
  } finally { hideLoader(); }
}

async function reopenCase() {
  try {
    await API.put('/daily-cases/reopen', { branch_id: caseModalBranch, date: casesDate });
    closeCaseModal(); toast('Reopened for edits'); loadCases();
  } catch (e) { toast(e.message, 'err'); }
}

// Build the branded "Radiology Daily Statistics" report and export it to PDF
// (matches the dashboard report design: KPI cards, branch breakdown table,
// grand-total pill, modality-mix bars and key notes).
const _REP_MODS = [['xray', 'X-RAY'], ['ct', 'CT'], ['us', 'US'], ['mamo', 'MAMO'], ['bmd', 'BMD']];

function printCases() {
  if (!casesData || !(casesData.branches || []).length) { toast('Nothing to export yet'); return; }
  openReport(buildCasesReport());
}

function buildCasesReport() {
  const branches = casesData.branches || [];
  const filed = branches.filter(b => b.case);                    // branches with a report
  const modTotals = {}; _REP_MODS.forEach(([k]) => modTotals[k] = 0);
  let totalCases = 0, totalPt = 0, notDone = 0, notDoneNote = '';
  let top = null, missingBranch = '';
  filed.forEach(b => {
    const c = b.case;
    _REP_MODS.forEach(([k]) => modTotals[k] += (c[k] || 0));
    totalCases += (c.total_cases || 0);
    totalPt += (c.total_pt || 0);
    const nd = (c.bmd_not_done || 0) + (c.mamo_not_done || 0);
    notDone += nd;
    if (nd && !notDoneNote) notDoneNote = `${c.mamo_not_done ? 'MAMO' : 'BMD'} not done in ${b.branch_name}`;
    if (c.total_cases && !c.total_pt && !missingBranch) missingBranch = b.branch_name;
    if (!top || (c.total_cases || 0) > (top.case.total_cases || 0)) top = b;
  });
  const modSum = _REP_MODS.reduce((a, [k]) => a + modTotals[k], 0) || 1;
  const mix = _REP_MODS.map(([k, l]) => ({ l, n: modTotals[k], pct: modTotals[k] / modSum * 100 }))
    .sort((a, b) => b.n - a.n);

  const kpi = (cls, label, value, sub) => `
    <div class="rep-kpi">
      <div class="rep-kpi-top"><span class="rep-dot ${cls}"></span><span class="rep-kpi-label">${label}</span></div>
      <div class="rep-kpi-num">${value}</div>
      <div class="rep-kpi-sub">${escapeHtml(sub || '')}</div>
    </div>`;

  const rowsHtml = branches.map(b => {
    const c = b.case;
    const cell = v => `<td>${c ? (v || 0) : '—'}</td>`;
    const ptCell = c
      ? (c.total_cases && !c.total_pt ? `<td class="rep-miss">Missing</td>` : `<td>${c.total_pt || 0}</td>`)
      : `<td>—</td>`;
    return `<tr>
      <td class="rep-bname">${escapeHtml(b.branch_name)}</td>
      ${_REP_MODS.map(([k]) => cell(c && c[k])).join('')}
      <td class="rep-total">${c ? (c.total_cases || 0) : '—'}</td>
      ${ptCell}
    </tr>`;
  }).join('');

  const notes = [];
  if (mix[0] && mix[0].n) notes.push(`${mix[0].l} is the highest modality with ${mix[0].n} cases.`);
  const top3 = filed.slice().sort((a, b) => (b.case.total_cases || 0) - (a.case.total_cases || 0))
    .slice(0, 3).map(b => b.branch_name);
  if (top3.length) notes.push(`${top3.join(', ')} carried most of the workload.`);
  if (missingBranch) notes.push(`${missingBranch} patient count is blank in the source file.`);
  if (notDone) notes.push(`${notDone} case${notDone !== 1 ? 's' : ''} not done${notDoneNote ? ' (' + notDoneNote + ')' : ''}.`);
  if (!notes.length) notes.push('All submitted branches reported a complete set of cases.');

  const monthYear = new Date(casesDate).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  return `
    ${reportHeader('Radiology Daily Statistics', `${fmtDateDisplay(casesDate)} — Meena Staff Scheduling`)}
    <div class="rep-kpis">
      ${kpi('v', 'Total Cases', totalCases, 'All branches')}
      ${kpi('v', 'Registered Patients', totalPt, missingBranch ? `${missingBranch} patient count blank` : 'Across all branches')}
      ${kpi('r', 'Not Done', notDone, notDoneNote || 'Nothing outstanding')}
      ${kpi('v', 'Top Branch', top ? escapeHtml(top.branch_name) : '—', top ? `${top.case.total_cases || 0} cases` : '')}
    </div>
    <div class="rep-card">
      <div class="rep-card-title">Branch Breakdown</div>
      <div class="rep-card-sub">Cases by modality and patient count</div>
      <table class="rep-table">
        <thead><tr>
          <th>Branch</th>${_REP_MODS.map(([, l]) => `<th>${l}</th>`).join('')}<th>Total</th><th>Patients</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="rep-grand">
        <span>Grand Total</span>
        <span class="rep-grand-v">${totalCases} cases — ${totalPt} registered patients</span>
      </div>
    </div>
    <div class="rep-bottom">
      <div class="rep-card">
        <div class="rep-card-title">Modality Mix</div>
        <div class="rep-bars">
          ${mix.map(m => `
            <div class="rep-bar-row">
              <span class="rep-bar-label">${m.l}</span>
              <span class="rep-bar-track"><span class="rep-bar-fill" style="width:${Math.round(m.pct)}%"></span></span>
              <span class="rep-bar-val">${m.n} cases — ${m.pct.toFixed(1)}%</span>
            </div>`).join('')}
        </div>
      </div>
      <div class="rep-card">
        <div class="rep-card-title">Key Notes</div>
        <ul class="rep-notes">${notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
      </div>
    </div>
    <div class="rep-foot">Generated from Radiology Cases — ${monthYear} data</div>`;
}

async function remindPendingCases() {
  const ok = await showConfirm('Remind pending branches',
    `Notify the team leads / night staff of every branch that hasn't submitted ${fmtDateDisplay(casesDate)} yet?`, 'Send reminders');
  if (!ok) return;
  try {
    const r = await API.post(`/daily-cases/remind?date=${casesDate}`, {});
    if (r.skipped) { toast('Already reminded recently — try again later'); return; }
    const n = (r.reminded || []).length;
    toast(n ? `Reminder sent to ${n} branch${n !== 1 ? 'es' : ''}` : 'All branches have already submitted 🎉');
  } catch (e) { toast(e.message, 'err'); }
}
