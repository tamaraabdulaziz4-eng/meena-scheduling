// ── Downtime registration ─────────────────────────────────────────────────────
// When the radiology system (RIS/PACS) is down, any staff member logs the patient
// here. The server mints a unique Accession Number so images route correctly once
// it's back, and returns a ready-to-forward message (also WhatsApp'd to the staff).

let _dtModalities = ['X-Ray', 'CT', 'US', 'MAMO', 'BMD', 'Other'];
let _dtStudies = [];
window._dtLastMessage = '';

async function renderDowntimePage() {
  setTopbar('Downtime', 'Log patients while the system is down');
  const c = document.getElementById('content');
  const canPickBranch = ['manager', 'superadmin'].includes(currentUser?.role);
  const isReviewer = ['manager', 'superadmin'].includes(currentUser?.role);
  c.innerHTML = `
    <div class="cc">
    ${pageHero('Downtime', 'Downtime', 'System down? Register the patient — we mint a unique Accession Number')}
    ${isReviewer ? `<div id="dt-link-card"></div>` : ''}
    <div class="board" style="margin-bottom:16px">
      <div class="bhead"><div class="bhrow"><div class="btitle">Register a patient</div></div></div>
      <div style="padding:12px 18px 18px">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px">
          <label style="font-size:13px">Patient name
            <input id="dt-name" class="input" style="width:100%;margin-top:4px" maxlength="120"></label>
          <label style="font-size:13px">National ID / Iqama
            <input id="dt-pid" class="input" style="width:100%;margin-top:4px" inputmode="numeric" maxlength="20"></label>
          <label style="font-size:13px">Exam / Modality
            <select id="dt-modality" class="input" style="width:100%;margin-top:4px">${_dtModalities.map(m => `<option>${m}</option>`).join('')}</select></label>
          <label style="font-size:13px">Procedure <span style="color:var(--muted)">(optional)</span>
            <input id="dt-procedure" class="input" style="width:100%;margin-top:4px" maxlength="120" placeholder="e.g. CT Brain"></label>
          <label style="font-size:13px">Indication <span style="color:var(--muted)">(optional)</span>
            <input id="dt-indication" class="input" style="width:100%;margin-top:4px" maxlength="200"></label>
          <label style="font-size:13px">Ward / Area <span style="color:var(--muted)">(optional)</span>
            <input id="dt-ward" class="input" style="width:100%;margin-top:4px" maxlength="80"></label>
          ${canPickBranch ? `<label style="font-size:13px">Branch
            <select id="dt-branch" class="input" style="width:100%;margin-top:4px"></select></label>` : ''}
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:14px">
          <button class="open pri" style="width:auto;padding:10px 20px" onclick="submitDowntime()">Register &amp; get Accession</button>
        </div>
        <div id="dt-result"></div>
      </div>
    </div>
    <div class="board">
      <div class="bhead"><div class="bhrow">
        <div class="btitle">Downtime log</div>
        <div class="bh-actions"><button class="ghost" onclick="printDowntimeLog()">Print / PDF</button></div>
      </div></div>
      <div id="dt-log" style="padding:12px 0 0">${LOADING_HTML}</div>
    </div>
    </div>`;
  if (canPickBranch) {
    try { if (!allBranches.length) await loadBranches(); } catch (e) {}
    const sel = document.getElementById('dt-branch');
    if (sel) sel.innerHTML = allBranches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  }
  if (isReviewer) renderDowntimeLink();
  loadDowntimeLog();
}

// ── Public no-login link (managers/superadmin) ────────────────────────────────
async function renderDowntimeLink() {
  const box = document.getElementById('dt-link-card');
  if (!box) return;
  let d;
  try { d = await API.get('/downtime/public-link'); } catch (e) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="board" style="margin-bottom:16px">
    <div class="bhead"><div class="bhrow"><div class="btitle">Public link <span>no login needed</span></div></div></div>
    <div style="padding:8px 18px 16px">
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px">Share this in the staff group. Anyone can open it, pick a branch, fill the data and get an Accession — no account needed.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input id="dt-link-input" class="input" readonly value="${escapeHtml(d.url || '')}" style="flex:1;min-width:200px;font-size:12px">
        <button class="open pri" style="width:auto" onclick="copyDowntimeLink()">Copy link</button>
        <button class="ghost" onclick="regenDowntimeLink()">Regenerate</button>
      </div>
    </div></div>`;
}

async function copyDowntimeLink() {
  const inp = document.getElementById('dt-link-input');
  if (!inp) return;
  try { await navigator.clipboard.writeText(inp.value); toast('Link copied'); }
  catch (e) { inp.select(); try { document.execCommand('copy'); toast('Link copied'); } catch (_) { toast('Copy failed', 'err'); } }
}

async function regenDowntimeLink() {
  if (!confirm('Regenerate the link? The old link will stop working immediately.')) return;
  try { await API.post('/downtime/public-link/regenerate'); toast('New link generated'); renderDowntimeLink(); }
  catch (e) { toast(e.message || 'Failed', 'err'); }
}

// ── Branded printable log (instead of printing the whole app page) ────────────
function printDowntimeLog() {
  if (typeof openReport !== 'function') { window.print(); return; }
  const rows = _dtStudies || [];
  const body = rows.length ? rows.map(s => {
    const exam = escapeHtml(s.modality) + (s.procedure_name ? ' / ' + escapeHtml(s.procedure_name) : '');
    return `<tr>
      <td style="font-weight:700">${escapeHtml(s.accession)}</td>
      <td>${escapeHtml(s.patient_name)}</td><td>${escapeHtml(s.patient_id)}</td>
      <td>${exam}</td><td>${escapeHtml(s.indication || '—')}</td>
      <td>${escapeHtml(s.created_by_name || '')}</td>
      <td>${s.created_at ? new Date(s.created_at).toLocaleString('en-GB') : ''}</td>
      <td>${s.status === 'reconciled' ? 'Reconciled' : 'Pending'}</td></tr>`;
  }).join('') : `<tr><td colspan="8" style="text-align:center;color:#888;padding:20px">No downtime studies.</td></tr>`;
  const html = `
    ${reportHeader('Radiology Downtime Log', `Meena Health · ${new Date().toLocaleDateString('en-GB')}`)}
    <div class="rep-card rep-rota"><div class="table-wrap"><table>
      <thead><tr><th>Accession</th><th>Patient</th><th>ID</th><th>Exam</th><th>Indication</th><th>By</th><th>Time</th><th>Status</th></tr></thead>
      <tbody>${body}</tbody></table></div></div>`;
  openReport(html, true);   // landscape
}

async function submitDowntime() {
  const val = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };
  const payload = {
    patient_name: val('dt-name'), patient_id: val('dt-pid'),
    modality: val('dt-modality'), procedure: val('dt-procedure'),
    indication: val('dt-indication'), ward: val('dt-ward'),
  };
  const bsel = document.getElementById('dt-branch');
  if (bsel && bsel.value) payload.branch_id = Number(bsel.value);
  if (!payload.patient_name || !payload.patient_id || !payload.modality) {
    toast('Patient name, ID and exam are required', 'err'); return;
  }
  try {
    const r = await API.post('/downtime', payload);
    showDowntimeResult(r);
    ['dt-name', 'dt-pid', 'dt-procedure', 'dt-indication', 'dt-ward'].forEach(id => {
      const e = document.getElementById(id); if (e) e.value = '';
    });
    loadDowntimeLog();
  } catch (e) { toast(e.message || 'Failed to register', 'err'); }
}

function showDowntimeResult(r) {
  const box = document.getElementById('dt-result');
  if (!box) return;
  window._dtLastMessage = r.message || '';
  const acc = (r.study || {}).accession || '';
  box.innerHTML = `
    <div style="margin-top:14px;border:1px solid var(--border);border-radius:14px;background:var(--card-alt);padding:16px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <span class="sc ok">✓ Registered</span>
        <span style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Accession</span>
        <span style="font-size:18px;font-weight:800;letter-spacing:.5px;color:var(--accent2,var(--primary))">${escapeHtml(acc)}</span>
      </div>
      <pre id="dt-msg" style="white-space:pre-wrap;font-family:inherit;font-size:13px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px;margin:0">${escapeHtml(r.message || '')}</pre>
      <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:center">
        <button class="open pri" style="width:auto" onclick="copyDowntimeMessage()">Copy message</button>
        <span style="font-size:12px;color:var(--muted)">Send this to the reporting company — we also WhatsApp'd it to you.</span>
      </div>
    </div>`;
}

async function copyDowntimeMessage() {
  const text = window._dtLastMessage || '';
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch (e) {
    const pre = document.getElementById('dt-msg');
    if (pre) {
      const rng = document.createRange(); rng.selectNode(pre);
      getSelection().removeAllRanges(); getSelection().addRange(rng);
      try { document.execCommand('copy'); toast('Copied'); } catch (_) { toast('Copy failed — select and copy manually', 'err'); }
    }
  }
}

async function loadDowntimeLog() {
  const box = document.getElementById('dt-log');
  if (!box) return;
  let d;
  try { d = await API.get('/downtime'); }
  catch (e) { box.innerHTML = `<div class="rep-empty">${escapeHtml(e.message || 'Failed to load')}</div>`; return; }
  const rows = d.studies || [];
  _dtStudies = rows;
  const isAdmin = ADMIN_ROLES.includes(currentUser?.role);
  const hasActions = isAdmin || rows.some(s => s.can_delete);
  if (!rows.length) { box.innerHTML = `<div class="lrow" style="justify-content:center;padding:24px;color:var(--muted);border-bottom:none">No downtime studies logged yet.</div>`; return; }
  box.innerHTML = rows.map(s => {
    const exam = escapeHtml(s.modality) + (s.procedure_name ? ' / ' + escapeHtml(s.procedure_name) : '');
    const pill = s.status === 'reconciled'
      ? '<span class="ris final"><span class="rd"></span>Reconciled</span>'
      : '<span class="ris progress"><span class="rd"></span>Pending</span>';
    const actions = (isAdmin
        ? (s.status === 'reconciled'
            ? `<button class="ghost" onclick="reconcileDowntime(${s.id},'pending')">Undo</button>`
            : `<button class="ghost" onclick="reconcileDowntime(${s.id},'reconciled')">Mark done</button>`)
        : '')
      + (s.can_delete ? `<button class="ghost" style="color:var(--danger,#E25555)" onclick="deleteDowntime(${s.id})">Delete</button>` : '');
    return `
      <div class="lrow" style="align-items:flex-start;flex-wrap:wrap">
        <div style="width:120px;flex-shrink:0">
          <strong>${escapeHtml(s.accession)}</strong>
          <div style="font-size:11px;color:var(--muted)">${s.created_at ? new Date(s.created_at).toLocaleString('en-GB') : ''}</div>
        </div>
        <div style="flex:1;min-width:180px">
          <strong>${escapeHtml(s.patient_name)}</strong>
          <span style="font-size:12px;color:var(--muted)"> · ID ${escapeHtml(s.patient_id)}</span>
          <div style="font-size:12.5px;margin-top:2px">${exam}${s.indication ? ` <span style="color:var(--muted)">— ${escapeHtml(s.indication)}</span>` : ''}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">by ${escapeHtml(s.created_by_name || '—')}</div>
        </div>
        ${pill}
        ${hasActions ? `<div style="display:flex;gap:6px;flex-shrink:0">${actions}</div>` : ''}
      </div>`;
  }).join('');
}

async function deleteDowntime(id) {
  if (!confirm('Delete this downtime entry? This removes it from the log (the accession number is retired).')) return;
  try {
    await API.delete(`/downtime/${id}`);
    toast('Entry deleted');
    loadDowntimeLog();
  } catch (e) { toast(e.message || 'Failed to delete', 'err'); }
}

async function reconcileDowntime(id, status) {
  try {
    await API.put(`/downtime/${id}/status`, { status });
    toast(status === 'reconciled' ? 'Marked reconciled' : 'Reopened');
    loadDowntimeLog();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}
