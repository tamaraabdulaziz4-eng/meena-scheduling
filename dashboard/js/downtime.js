// ── Downtime registration ─────────────────────────────────────────────────────
// When the radiology system (RIS/PACS) is down, any staff member logs the patient
// here. The server mints a unique Accession Number so images route correctly once
// it's back, and returns a ready-to-forward message (also WhatsApp'd to the staff).

let _dtModalities = ['X-Ray', 'CT', 'US', 'MAMO', 'BMD', 'Other'];
window._dtLastMessage = '';

async function renderDowntimePage() {
  setTopbar('Downtime', 'Log patients while the system is down');
  const c = document.getElementById('content');
  const canPickBranch = ['manager', 'superadmin'].includes(currentUser?.role);
  c.innerHTML = `
    ${pageHero('Downtime', 'Downtime', 'System down? Register the patient — we mint a unique Accession Number')}
    <div class="rep-card" style="margin-bottom:16px">
      <div class="rep-card-head"><div class="rep-card-title">Register a patient</div></div>
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
        <button class="btn btn-primary" onclick="submitDowntime()">Register &amp; get Accession</button>
      </div>
      <div id="dt-result"></div>
    </div>
    <div class="rep-card" style="padding:0;overflow:hidden">
      <div class="rep-card-head" style="padding:18px 20px 0">
        <div class="rep-card-title">Downtime log</div>
        <button class="btn btn-sm btn-ghost" onclick="window.print()">Print / PDF</button>
      </div>
      <div id="dt-log" style="padding:14px 18px 18px">${LOADING_HTML}</div>
    </div>`;
  if (canPickBranch) {
    try { if (!allBranches.length) await loadBranches(); } catch (e) {}
    const sel = document.getElementById('dt-branch');
    if (sel) sel.innerHTML = allBranches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  }
  loadDowntimeLog();
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
        <span class="rep-pill rep-pill-ok">Registered</span>
        <span style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Accession</span>
        <span style="font-size:18px;font-weight:800;letter-spacing:.5px;color:var(--primary)">${escapeHtml(acc)}</span>
      </div>
      <pre id="dt-msg" style="white-space:pre-wrap;font-family:inherit;font-size:13px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px;margin:0">${escapeHtml(r.message || '')}</pre>
      <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-primary btn-sm" onclick="copyDowntimeMessage()">Copy message</button>
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
  const isAdmin = ['admin', 'manager', 'superadmin'].includes(currentUser?.role);
  if (!rows.length) { box.innerHTML = `<div class="rep-empty">No downtime studies logged yet.</div>`; return; }
  box.innerHTML = `<div class="table-wrap" style="box-shadow:none;border:1px solid var(--border)"><table>
    <thead><tr><th>Accession</th><th>Patient</th><th>ID</th><th>Exam</th><th>Indication</th><th>By</th><th>Time</th><th>Status</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows.map(s => {
      const exam = escapeHtml(s.modality) + (s.procedure_name ? ' / ' + escapeHtml(s.procedure_name) : '');
      const pill = s.status === 'reconciled'
        ? '<span class="rep-pill rep-pill-ok">Reconciled</span>'
        : '<span class="rep-pill rep-pill-amber">Pending</span>';
      return `<tr>
        <td style="font-weight:700">${escapeHtml(s.accession)}</td>
        <td>${escapeHtml(s.patient_name)}</td>
        <td>${escapeHtml(s.patient_id)}</td>
        <td>${exam}</td>
        <td>${escapeHtml(s.indication || '—')}</td>
        <td>${escapeHtml(s.created_by_name || '')}</td>
        <td>${s.created_at ? new Date(s.created_at).toLocaleString('en-GB') : ''}</td>
        <td>${pill}</td>
        ${isAdmin ? `<td style="text-align:right;white-space:nowrap">${s.status === 'reconciled'
          ? `<button class="btn btn-xs btn-ghost" onclick="reconcileDowntime(${s.id},'pending')">Undo</button>`
          : `<button class="btn btn-xs btn-ghost" onclick="reconcileDowntime(${s.id},'reconciled')">Mark done</button>`}</td>` : ''}
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

async function reconcileDowntime(id, status) {
  try {
    await API.put(`/downtime/${id}/status`, { status });
    toast(status === 'reconciled' ? 'Marked reconciled' : 'Reopened');
    loadDowntimeLog();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}
