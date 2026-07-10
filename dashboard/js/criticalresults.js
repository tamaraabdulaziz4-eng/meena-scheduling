// ── Critical Results — closed-loop communication ──────────────────────────────
// Radiology staff flag a critical/urgent finding; the loop stays OPEN until someone
// documents that the result was communicated to (and read back by) the referring
// team. Accreditation-grade (CBAHI / Joint Commission). All Meena-owned — nothing is
// written back to Siratech.

let _crStatus = 'open';

function renderCriticalResultsPage() {
  setTopbar('Critical Results', 'Closed-loop communication of critical & urgent findings');
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="cc">
      ${pageHero('Patient safety', 'Critical Results')}
      <div class="board" style="margin-bottom:14px">
        <div style="padding:14px 18px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between">
          <div style="display:flex;gap:6px;flex-wrap:wrap" id="cr-tabs"></div>
          <button class="open pri" style="width:auto" onclick="crFlagForm()">🚨 Log critical result</button>
        </div>
      </div>
      <div id="cr-list"></div>
    </div>`;
  crRenderTabs();
  crLoad();
}

function crRenderTabs() {
  const el = document.getElementById('cr-tabs');
  if (!el) return;
  const tabs = [['open', 'Open'], ['acknowledged', 'Acknowledged'], ['all', 'All']];
  el.innerHTML = tabs.map(([k, label]) =>
    `<button class="chip ${_crStatus === k ? 'on' : ''}" onclick="crSetStatus('${k}')">${label}</button>`).join('');
}

function crSetStatus(s) { _crStatus = s; crRenderTabs(); crLoad(); }

async function crLoad() {
  const box = document.getElementById('cr-list');
  if (box) box.innerHTML = `<div class="board"><div style="padding:22px 18px;color:var(--muted)">Loading…</div></div>`;
  let d;
  try {
    d = await API.get(`/radiology/critical?status=${encodeURIComponent(_crStatus)}`);
  } catch (e) {
    if (box) box.innerHTML = `<div class="board"><div style="padding:22px 18px;color:var(--danger-ink)">Could not load: ${escapeHtml(e.message || 'error')}</div></div>`;
    return;
  }
  crRenderList(d.items || []);
}

function crRenderList(items) {
  const box = document.getElementById('cr-list');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = `<div class="board"><div style="padding:26px 18px;text-align:center;color:var(--muted)">No ${_crStatus === 'all' ? '' : _crStatus} critical results ${_crStatus === 'open' ? '— all clear ✓' : ''}</div></div>`;
    return;
  }
  box.innerHTML = items.map(crCard).join('');
}

function crCard(r) {
  const crit = (r.severity || 'critical') === 'critical';
  const open = r.status === 'open';
  const sevChip = `<span class="sc ${crit ? 'no' : ''}" style="margin:0;background:${crit ? 'var(--danger)' : '#b45309'};color:#fff">${crit ? '🚨 CRITICAL' : '⚠ Urgent'}</span>`;
  const age = (r.age_minutes != null)
    ? `<span style="color:${r.overdue ? 'var(--danger-ink)' : 'var(--muted)'};font-weight:${r.overdue ? 700 : 400}">${r.age_minutes < 60 ? r.age_minutes + ' min' : Math.floor(r.age_minutes / 60) + 'h ' + (r.age_minutes % 60) + 'm'}${r.overdue ? ' · OVERDUE' : ''}</span>`
    : '';
  return `
    <div class="board" style="margin-bottom:12px;${r.overdue ? 'border-color:var(--danger)' : ''}">
      <div style="padding:14px 18px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
          ${sevChip}
          <span style="font-weight:800;font-size:15px">${escapeHtml(r.patient_name || r.mrno || '')}</span>
          <span style="color:var(--muted);font-size:12px">MRN ${escapeHtml(r.mrno || '')}${r.exam ? ' · ' + escapeHtml(r.exam) : ''}${r.accession ? ' · ' + escapeHtml(r.accession) : ''}</span>
          <span style="flex:1"></span>${age}
        </div>
        <div style="font-size:13.5px;margin:6px 0 8px;white-space:pre-wrap">${escapeHtml(r.finding || '')}</div>
        <div style="font-size:11.5px;color:var(--muted)">
          Flagged by ${escapeHtml(r.flagged_by_name || '—')}${r.flagged_at ? ' · ' + crWhen(r.flagged_at) : ''}${r.notify_to ? ' · to notify: ' + escapeHtml(r.notify_to) : ''}
        </div>
        ${open ? `
          <div style="margin-top:10px">
            <button class="btn btn-primary" style="width:auto" onclick="crAckForm(${r.id})">✓ Acknowledge — document communication</button>
          </div>`
        : `
          <div class="ps-alert" style="margin-top:10px;background:var(--ok-bg,#062);border:none">
            <div style="font-size:12px;color:var(--muted)">✓ Acknowledged by ${escapeHtml(r.acked_by_name || '—')}${r.acked_at ? ' · ' + crWhen(r.acked_at) : ''}</div>
            <div style="font-size:13px;margin-top:3px;white-space:pre-wrap">${escapeHtml(r.ack_note || '')}</div>
          </div>`}
      </div>
    </div>`;
}

function crWhen(iso) {
  try { const d = new Date(iso); return d.toLocaleString(); } catch (e) { return String(iso); }
}

// Open the "log critical result" form. Pass a prefill object (from the worklist) to
// pre-populate patient/exam/accession context.
function crFlagForm(prefill) {
  const p = prefill || {};
  showModal('cr-flag-modal', `
    <div style="font-size:17px;font-weight:800;margin-bottom:4px">🚨 Log critical result</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:14px">Starts the communication loop. The reading team is notified and it stays open until acknowledged.</div>
    <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Severity</label>
    <select id="cr-sev" class="input" style="margin-bottom:10px">
      <option value="critical">Critical — must be communicated immediately</option>
      <option value="urgent">Urgent — communicate promptly</option>
    </select>
    <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Patient MRN *</label>
    <input id="cr-mrno" class="input" style="margin-bottom:10px" value="${escapeHtml(p.mrno || '')}" placeholder="MRN">
    <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Patient name</label>
    <input id="cr-pname" class="input" style="margin-bottom:10px" value="${escapeHtml(p.patientName || '')}" placeholder="Patient name">
    <div style="display:flex;gap:10px">
      <div style="flex:1"><label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Exam</label><input id="cr-exam" class="input" style="margin-bottom:10px" value="${escapeHtml(p.exam || '')}" placeholder="e.g. CT Head"></div>
      <div style="flex:1"><label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Accession</label><input id="cr-acc" class="input" style="margin-bottom:10px" value="${escapeHtml(p.accession || '')}" placeholder="Accession"></div>
    </div>
    <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Critical finding *</label>
    <textarea id="cr-finding" class="input" rows="3" style="margin-bottom:10px" placeholder="The finding that must be communicated">${escapeHtml(p.finding || '')}</textarea>
    <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Referring doctor / team to notify</label>
    <input id="cr-notify" class="input" style="margin-bottom:16px" value="${escapeHtml(p.notifyTo || '')}" placeholder="Who needs to be told">
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-ghost" style="width:auto" onclick="closeModal('cr-flag-modal')">Cancel</button>
      <button class="btn btn-primary" style="width:auto" onclick="crFlagSubmit(${p.gpb != null ? p.gpb : 'null'}, ${p.site != null ? p.site : 'null'})">Flag &amp; notify</button>
    </div>`);
}

async function crFlagSubmit(gpb, site) {
  const mrno = (document.getElementById('cr-mrno')?.value || '').trim();
  const finding = (document.getElementById('cr-finding')?.value || '').trim();
  if (!mrno) { toast('Patient MRN is required', 'err'); return; }
  if (!finding) { toast('The critical finding is required', 'err'); return; }
  const body = {
    mrno, finding,
    severity: document.getElementById('cr-sev')?.value || 'critical',
    patientName: (document.getElementById('cr-pname')?.value || '').trim(),
    exam: (document.getElementById('cr-exam')?.value || '').trim(),
    accession: (document.getElementById('cr-acc')?.value || '').trim(),
    notifyTo: (document.getElementById('cr-notify')?.value || '').trim(),
    gpb: gpb, site: site,
  };
  try {
    await API.post('/radiology/critical', body);
    closeModal('cr-flag-modal');
    toast('Critical result flagged — team notified');
    if (typeof crLoad === 'function' && document.getElementById('cr-list')) { _crStatus = 'open'; crRenderTabs(); crLoad(); }
    if (typeof crRefreshBadge === 'function') crRefreshBadge();
  } catch (e) {
    toast(e.message || 'Could not flag', 'err');
  }
}

function crAckForm(id) {
  showModal('cr-ack-modal', `
    <div style="font-size:17px;font-weight:800;margin-bottom:4px">✓ Acknowledge critical result</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:14px">Close the loop: record who was told and that they read it back. This is the accreditation-required documentation.</div>
    <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">Communicated to (name / role)</label>
    <input id="cr-ack-to" class="input" style="margin-bottom:10px" placeholder="e.g. Dr. Ahmed (ER)">
    <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px">How it was communicated + read-back *</label>
    <textarea id="cr-ack-note" class="input" rows="3" style="margin-bottom:16px" placeholder="e.g. Called ER at 14:20, spoke to Dr. Ahmed, finding read back and confirmed"></textarea>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-ghost" style="width:auto" onclick="closeModal('cr-ack-modal')">Cancel</button>
      <button class="btn btn-primary" style="width:auto" onclick="crAckSubmit(${id})">Acknowledge</button>
    </div>`);
}

async function crAckSubmit(id) {
  const note = (document.getElementById('cr-ack-note')?.value || '').trim();
  if (!note) { toast('Document how the result was communicated', 'err'); return; }
  const notifyTo = (document.getElementById('cr-ack-to')?.value || '').trim();
  try {
    await API.post(`/radiology/critical/${id}/ack`, { note, notifyTo });
    closeModal('cr-ack-modal');
    toast('Loop closed — acknowledgement recorded');
    crLoad();
    if (typeof crRefreshBadge === 'function') crRefreshBadge();
  } catch (e) {
    toast(e.message || 'Could not acknowledge', 'err');
  }
}

// Sidebar badge: count of OPEN critical results (polled from the nav).
async function crRefreshBadge() {
  try {
    const d = await API.get('/radiology/critical/count');
    const el = document.getElementById('nav-critical-badge');
    if (!el) return;
    const n = (d && d.open) || 0;
    el.textContent = n ? String(n) : '';
    el.style.display = n ? 'inline-flex' : 'none';
    el.classList.toggle('badge-danger', !!(d && d.overdue));   // toggle, not add — else it stays red after clearing
  } catch (e) { /* best-effort */ }
}
