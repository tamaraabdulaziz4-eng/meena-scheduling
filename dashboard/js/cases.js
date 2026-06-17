// ── Daily radiology cases ─────────────────────────────────────────────────────
// Manager: live per-branch cards for a day. Team lead / eligible staff: fill &
// submit (locks) their branch's report.
// The "reporting day": a night shift runs into the early morning, so before the
// 08:00 morning handover the shift is still closing OUT YESTERDAY. Default the
// report date to yesterday until 8 AM so a 1–2 AM entry lands on the right day
// (and the night-staff eligibility check matches that day's schedule).
const CASES_ROLLOVER_HOUR = 8;
function operationalDate() {
  const d = new Date();
  if (d.getHours() < CASES_ROLLOVER_HOUR) d.setDate(d.getDate() - 1);
  return fmtDate(d);
}
let casesDate = operationalDate();
let casesData = null;
let _casesTimer = null;

function renderCasesPage() {
  // Fresh "reporting day" default each time the page opens (handles past-midnight entry).
  casesDate = operationalDate();
  setTopbar('Daily Cases', 'Radiology cases per branch',
    `<button class="btn btn-ghost btn-sm" onclick="printCases()">🖨 Print / PDF</button>`);
  const c = document.getElementById('content');
  c.innerHTML = `
    <div id="cases-print-title" style="display:none"></div>
    <div class="month-nav" style="margin-bottom:4px">
      <button onclick="changeCasesDay(-1)">&#8249;</button>
      <span class="month-label" id="cases-date-label"></span>
      <button onclick="changeCasesDay(1)">&#8250;</button>
    </div>
    <div class="no-print" style="font-size:11px;color:var(--muted);margin-bottom:14px">
      📅 Reporting day — a night shift filed after midnight still belongs to the day it covered.
    </div>
    <div id="cases-summary"></div>
    <div id="cases-cards" class="cases-grid"><div class="empty"><div class="empty-icon">⏳</div><p>Loading…</p></div></div>`;
  // Live refresh while the manager is watching.
  if (_casesTimer) clearInterval(_casesTimer);
  _casesTimer = setInterval(() => { if (currentPage === 'cases') loadCases(true); else { clearInterval(_casesTimer); _casesTimer = null; } }, 60000);
  loadCases();
}

function changeCasesDay(delta) {
  const d = new Date(casesDate); d.setDate(d.getDate() + delta); casesDate = fmtDate(d); loadCases();
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

function canEditBranch(branch_id) {
  const r = currentUser?.role;
  if (['superadmin', 'manager'].includes(r)) return true;
  return branch_id === currentUser?.branch_id && ['admin', 'staff'].includes(r);
}

function renderCases() {
  const s = casesData.summary || {};
  document.getElementById('cases-print-title').textContent =
    `Daily Radiology Cases — ${fmtDateDisplay(casesDate)}`;
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
  const editable = canEditBranch(b.branch_id);
  const submitted = c && c.locked;
  const head = submitted
    ? `<span class="cc-ok">✅ ${c.submitted_by_name ? escapeHtml(c.submitted_by_name) : ''}${c.submitted_at ? ' · ' + notifTimeAgo(c.submitted_at) : ''}</span>`
    : `<span class="cc-pending">⏳ Pending</span>`;
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
  let c = {};
  try { c = (await API.get(`/daily-cases?branch_id=${branch_id}&date=${casesDate}`)).case || {}; } catch (e) {}
  const f = id => document.getElementById(id);
  CASE_INPUTS.forEach(k => { f('case-' + k).value = (c[k] != null ? c[k] : ''); });
  const bname = (casesData?.branches || []).find(x => x.branch_id === branch_id)?.branch_name || '';
  f('case-modal-title').textContent = `${bname} — ${fmtDateDisplay(casesDate)}`;
  f('case-msg').textContent = '';
  const isReviewer = ['superadmin', 'manager'].includes(currentUser?.role);
  const readOnly = !!c.locked && !isReviewer;
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
  const body = { branch_id: caseModalBranch, date: casesDate, submit: !!submit };
  CASE_INPUTS.forEach(k => body[k] = g(k));
  try {
    await API.post('/daily-cases', body);
    closeCaseModal();
    toast(submit ? 'Report submitted' : 'Saved');
    loadCases();
  } catch (e) {
    const m = document.getElementById('case-msg'); m.className = 'msg err'; m.textContent = e.message;
  }
}

async function reopenCase() {
  try {
    await API.put('/daily-cases/reopen', { branch_id: caseModalBranch, date: casesDate });
    closeCaseModal(); toast('Reopened for edits'); loadCases();
  } catch (e) { toast(e.message, 'err'); }
}

function printCases() { window.print(); }
