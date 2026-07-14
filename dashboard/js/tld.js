// ── TLD Dosimetry (Radiology + Dental) ────────────────────────────────────────
// Quarterly TLD badge program run by the TLD coordinator: staff roster per
// department (dental heads submit theirs through a no-login link), badges per
// quarterly cycle (incl. control badges), digital handover/receiving forms with
// signatures + printable PDF, provider dose-report attachments, and a quarterly
// compliance report. Gated by the `admin_tld` permission.

let _tldTab = 'roster';
let _tldDept = 'radiology';
let _tldYear = new Date().getFullYear();
let _tldQuarter = Math.floor(new Date().getMonth() / 3) + 1;
let _tldRoster = [];        // full roster rows (all departments, incl. inactive)
let _tldSubs = [];          // pending submissions
let _tldDetail = null;      // current cycle detail {cycle,badges,forms,attachments,missing}
let _tldReport = null;      // current report payload

const TLD_DEPTS = [['radiology', 'Radiology'], ['dental', 'Dental']];
function _tldDeptLabel(d) { return (TLD_DEPTS.find(x => x[0] === d) || [d, d])[1]; }

async function renderTldPage() {
  setTopbar('TLD Dosimetry', 'Quarterly badge program — Radiology & Dental');
  const c = document.getElementById('content');
  const tabs = [['roster', 'Roster'], ['cycles', 'Cycles & Badges'], ['forms', 'Handover / Receiving'], ['report', 'Q Report']];
  c.innerHTML = `
    <div class="cc">
    ${pageHero('TLD', 'TLD Dosimetry', 'Track badge distribution, collection and quarterly compliance for Radiology & Dental')}
    <div class="rep-toolbar">
      <div class="seg" id="tld-tabs">${tabs.map(([v, l]) =>
        `<button data-t="${v}" class="${v === _tldTab ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="seg" id="tld-dept">${TLD_DEPTS.map(([v, l]) =>
        `<button data-d="${v}" class="${v === _tldDept ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div id="tld-controls" style="margin-bottom:14px"></div>
    <div id="tld-body">${LOADING_HTML}</div>
    </div>`;
  c.querySelectorAll('#tld-tabs button').forEach(b =>
    b.onclick = () => { _tldTab = b.getAttribute('data-t'); renderTldPage(); });
  c.querySelectorAll('#tld-dept button').forEach(b =>
    b.onclick = () => {
      _tldDept = b.getAttribute('data-d');
      c.querySelectorAll('#tld-dept button').forEach(x => x.classList.toggle('on', x === b));
      loadTldBody();
    });
  loadTldBody();
}

function _tldQuarterNav() {
  return `<div class="month-nav" style="margin-bottom:4px">
      <button onclick="tldChangeQuarter(-1)">&#8249;</button>
      <span class="month-label">Q${_tldQuarter} ${_tldYear}</span>
      <button onclick="tldChangeQuarter(1)">&#8250;</button></div>`;
}
function tldChangeQuarter(d) {
  _tldQuarter += d;
  if (_tldQuarter < 1) { _tldQuarter = 4; _tldYear--; }
  if (_tldQuarter > 4) { _tldQuarter = 1; _tldYear++; }
  loadTldBody();
}

async function loadTldBody() {
  const ctrl = document.getElementById('tld-controls');
  const body = document.getElementById('tld-body');
  if (!body) return;
  if (ctrl) ctrl.innerHTML = _tldTab === 'roster' ? '' : _tldQuarterNav();
  body.innerHTML = LOADING_HTML;
  try {
    if (_tldTab === 'roster') return await _tldLoadRoster(body);
    if (_tldTab === 'cycles') return await _tldLoadCycles(body);
    if (_tldTab === 'forms') return await _tldLoadForms(body);
    if (_tldTab === 'report') return await _tldLoadReport(body);
  } catch (e) {
    body.innerHTML = `<div class="empty"><p>${escapeHtml(e.message || 'Failed to load')}</p></div>`;
  }
}

// ── Roster tab ────────────────────────────────────────────────────────────────
async function _tldLoadRoster(body) {
  const [staffD, subsD] = await Promise.all([
    API.get('/tld/staff?include_inactive=1'),
    API.get('/tld/submissions?status=pending'),
  ]);
  _tldRoster = staffD.staff || [];
  _tldSubs = subsD.submissions || [];
  const deptSubs = _tldSubs.filter(s => s.department === _tldDept);
  const rows = _tldRoster.filter(s => s.department === _tldDept);
  const active = rows.filter(s => s.active);

  const pendingBanner = deptSubs.length ? `
    <div class="listcard" style="border-color:#E2933F;margin-bottom:14px">
      <div class="lrow" style="background:rgba(226,147,63,.08);flex-wrap:wrap">
        <strong>${deptSubs.length} pending submission(s) from ${escapeHtml(deptSubs[0].submitted_by_name || 'the department head')}</strong>
        <div style="margin-inline-start:auto;display:flex;gap:6px">
          <button class="open pri" style="width:auto" onclick="tldApproveAll()">Approve all</button>
        </div>
      </div>
      ${deptSubs.map(s => `
      <div class="lrow" style="flex-wrap:wrap">
        <div style="flex:1;min-width:160px"><strong>${escapeHtml(s.name)}</strong>
          <div style="font-size:12px;color:var(--muted)">${escapeHtml([s.employee_no, s.job_title].filter(Boolean).join(' · ') || '—')}</div></div>
        <span class="sc ${s.matched_id ? 'warn' : 'ok'}">${s.matched_id ? 'Updates existing' : 'New'}</span>
        <div style="display:flex;gap:6px">
          <button class="ghost" onclick="tldReviewSub(${s.id}, true)">Approve</button>
          <button class="ghost" style="color:var(--danger,#E25555)" onclick="tldReviewSub(${s.id}, false)">Reject</button>
        </div>
      </div>`).join('')}
    </div>` : '';

  body.innerHTML = `
    ${pendingBanner}
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      <div style="font-size:13px;color:var(--muted)"><b>${active.length}</b> active staff in ${escapeHtml(_tldDeptLabel(_tldDept))}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="ghost" onclick="openTldLinks()">Intake links</button>
        <button class="ghost" onclick="openTldShareLink()">Share intake link</button>
        ${_tldDept === 'radiology' ? `<button class="ghost" onclick="openTldPrefill()">Import from staff list</button>` : ''}
        <button class="open pri" style="width:auto" onclick="openTldStaffModal()">+ Add staff</button>
      </div>
    </div>
    ${rows.length ? `<div class="listcard">
      <div class="lrow" style="background:var(--card-alt);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);font-weight:600">
        <span style="flex:1;min-width:150px">Name</span>
        <span style="width:110px">Employee No.</span>
        <span style="width:150px">Job title</span>
        <span style="width:80px">Status</span>
        <span style="width:120px;text-align:right">Actions</span>
      </div>
      ${rows.map(s => `<div class="lrow" style="flex-wrap:wrap;${s.active ? '' : 'opacity:.55'}">
        <span style="flex:1;min-width:150px"><strong>${escapeHtml(s.name)}</strong></span>
        <span style="width:110px">${escapeHtml(s.employee_no || '—')}</span>
        <span style="width:150px">${escapeHtml(s.job_title || '—')}</span>
        <span style="width:80px">${s.active ? '<span class="sc ok">Active</span>' : '<span class="sc no">Inactive</span>'}</span>
        <span style="width:120px;display:flex;gap:6px;justify-content:flex-end">
          <button class="ghost" onclick="openTldStaffModal(${s.id})">Edit</button>
        </span>
      </div>`).join('')}</div>`
    : `<div class="listcard"><div class="lrow" style="justify-content:center;padding:24px;color:var(--muted)">
         No ${escapeHtml(_tldDeptLabel(_tldDept))} staff yet — add them, or send the department head an intake link.</div></div>`}
    <div style="font-size:12px;color:var(--muted);margin-top:10px">
      The intake link lets the department head submit/update their staff list from their phone — no login needed.
      Submissions land here for your review before joining the roster.</div>`;
}

function openTldStaffModal(id) {
  const s = id ? (_tldRoster.find(x => x.id === id) || {}) : null;
  showModal('tld-staff-modal', `
    <h3 style="margin:0 0 14px">${s ? 'Edit staff member' : `Add staff — ${escapeHtml(_tldDeptLabel(_tldDept))}`}</h3>
    <div style="display:grid;gap:12px">
      <label style="font-size:13px">Full name
        <input id="tld-st-name" class="input" maxlength="120" value="${s ? escapeHtml(s.name || '') : ''}" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Employee number (optional)
        <input id="tld-st-emp" class="input" maxlength="40" value="${s ? escapeHtml(s.employee_no || '') : ''}" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">National ID / Iqama (optional)
        <input id="tld-st-nid" class="input" maxlength="20" value="${s ? escapeHtml(s.national_id || '') : ''}" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Job title (optional)
        <input id="tld-st-title" class="input" maxlength="80" value="${s ? escapeHtml(s.job_title || '') : ''}" placeholder="e.g. Radiologic Technologist / Dentist" style="width:100%;margin-top:4px"></label>
      ${s ? `<label style="font-size:13px;display:flex;align-items:center;gap:8px">
        <input id="tld-st-active" type="checkbox" ${s.active ? 'checked' : ''}> Active (receives a badge each quarter)</label>` : ''}
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
      <button class="btn btn-ghost" onclick="closeModal('tld-staff-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="saveTldStaff(${s ? s.id : 'null'})">${s ? 'Save' : 'Add'}</button>
    </div>`);
}

async function saveTldStaff(id) {
  const v = i => { const e = document.getElementById(i); return e ? e.value.trim() : ''; };
  const payload = { name: v('tld-st-name'), employee_no: v('tld-st-emp'), national_id: v('tld-st-nid'), job_title: v('tld-st-title') };
  if (!payload.name) { toast('Name is required', 'err'); return; }
  try {
    if (id) {
      payload.active = !!document.getElementById('tld-st-active')?.checked;
      await API.put(`/tld/staff/${id}`, payload);
    } else {
      payload.department = _tldDept;
      await API.post('/tld/staff', payload);
    }
    closeModal('tld-staff-modal'); toast(id ? 'Saved' : 'Added'); loadTldBody();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

async function tldReviewSub(id, approve) {
  try {
    await API.post(`/tld/submissions/${id}/${approve ? 'approve' : 'reject'}`, {});
    toast(approve ? 'Approved' : 'Rejected'); loadTldBody();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

async function tldApproveAll() {
  if (!confirm(`Approve all pending ${_tldDeptLabel(_tldDept)} submissions into the roster?`)) return;
  try {
    const d = await API.post('/tld/submissions/approve-all', { department: _tldDept });
    toast(`Approved ${d.approved}`); loadTldBody();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

async function openTldShareLink() {
  showModal('tld-link-modal', `<h3 style="margin:0 0 12px">Intake link — ${escapeHtml(_tldDeptLabel(_tldDept))}</h3><div id="tld-link-body">${LOADING_HTML}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btn-ghost" onclick="closeModal('tld-link-modal')">Close</button></div>`);
  let d;
  try { d = await API.post('/tld/roster-link', { department: _tldDept }); }
  catch (e) { document.getElementById('tld-link-body').innerHTML = `<div class="rep-empty">${escapeHtml(e.message || 'Failed')}</div>`; return; }
  const waText = `Please open this link and submit the ${_tldDeptLabel(_tldDept)} staff list for the TLD dosimetry badges (valid 7 days): ${d.url}`;
  document.getElementById('tld-link-body').innerHTML = `
    <div style="font-size:13px;color:var(--muted);margin-bottom:10px">Send this to the ${escapeHtml(_tldDeptLabel(_tldDept))} department head.
      They open it on their phone, fill in the staff list, and submit — it lands here for your review. The link expires in 7 days.</div>
    ${d.qr ? `<div style="text-align:center;margin-bottom:10px"><img src="${d.qr}" alt="QR" style="width:180px;height:180px;border-radius:12px"></div>` : ''}
    <input class="input" readonly value="${escapeHtml(d.url)}" onclick="this.select()" style="width:100%">
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="navigator.clipboard.writeText('${escapeHtml(d.url)}').then(()=>toast('Copied'))">Copy link</button>
      <a class="btn btn-ghost" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(waText)}">Share on WhatsApp</a>
    </div>`;
}

async function openTldLinks() {
  showModal('tld-links-modal', `<h3 style="margin:0 0 12px">Intake links</h3><div id="tld-links-body">${LOADING_HTML}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btn-ghost" onclick="closeModal('tld-links-modal')">Close</button></div>`);
  let d;
  try { d = await API.get('/tld/roster-links'); }
  catch (e) { document.getElementById('tld-links-body').innerHTML = `<div class="rep-empty">${escapeHtml(e.message)}</div>`; return; }
  const rows = d.links || [];
  document.getElementById('tld-links-body').innerHTML = rows.length ? `<div class="listcard">
    ${rows.map(l => {
      const st = l.status === 'submitted' ? '<span class="sc ok">Submitted</span>'
        : l.status === 'closed' ? '<span class="sc no">Closed</span>'
        : l.expired ? '<span class="sc no">Expired</span>' : '<span class="sc warn">Open</span>';
      return `<div class="lrow" style="flex-wrap:wrap">
        <span style="width:90px">${escapeHtml(_tldDeptLabel(l.department))}</span>
        ${st}
        <span style="flex:1;min-width:140px;font-size:12px;color:var(--muted)">
          ${escapeHtml(l.created_at || '')}${l.submitted_by_name ? ` · by ${escapeHtml(l.submitted_by_name)}` : ''}${l.pending ? ` · ${l.pending} pending` : ''}</span>
        ${l.status === 'open' && !l.expired ? `<button class="ghost" onclick="tldCloseLink(${l.id})">Revoke</button>` : ''}
      </div>`;
    }).join('')}</div>` : `<div class="rep-empty">No links yet.</div>`;
}

async function tldCloseLink(id) {
  try { await API.post(`/tld/roster-links/${id}/close`, {}); toast('Revoked'); openTldLinks(); }
  catch (e) { toast(e.message || 'Failed', 'err'); }
}

async function openTldPrefill() {
  showModal('tld-prefill-modal', `<h3 style="margin:0 0 12px">Import radiology staff</h3><div id="tld-prefill-body">${LOADING_HTML}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn btn-ghost" onclick="closeModal('tld-prefill-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="tldImportPrefill()">Import selected</button>
    </div>`);
  let d;
  try { d = await API.get('/tld/staff/prefill'); }
  catch (e) { document.getElementById('tld-prefill-body').innerHTML = `<div class="rep-empty">${escapeHtml(e.message)}</div>`; return; }
  const rows = d.candidates || [];
  document.getElementById('tld-prefill-body').innerHTML = rows.length ? `
    <div style="font-size:13px;color:var(--muted);margin-bottom:8px">App staff not yet in the TLD roster:</div>
    <div style="max-height:320px;overflow:auto">${rows.map(r => `
      <label style="display:flex;align-items:center;gap:8px;padding:6px 2px;font-size:14px">
        <input type="checkbox" class="tld-prefill-cb" data-sid="${r.staff_id}" data-name="${escapeHtml(r.name)}" checked>
        ${escapeHtml(r.name)} <span style="color:var(--muted);font-size:12px">${escapeHtml(r.branch_name || '')}</span></label>`).join('')}</div>`
    : `<div class="rep-empty">Everyone in the app staff list is already in the roster.</div>`;
}

async function tldImportPrefill() {
  const cbs = [...document.querySelectorAll('.tld-prefill-cb:checked')];
  if (!cbs.length) { toast('Nothing selected', 'err'); return; }
  try {
    for (const cb of cbs) {
      await API.post('/tld/staff', { department: 'radiology', name: cb.getAttribute('data-name'), staff_id: Number(cb.getAttribute('data-sid')) });
    }
    closeModal('tld-prefill-modal'); toast(`Imported ${cbs.length}`); loadTldBody();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

// ── Cycles & badges tab ───────────────────────────────────────────────────────
async function _tldFetchCycleDetail() {
  const d = await API.get(`/tld/cycles?year=${_tldYear}`);
  const cyc = (d.cycles || []).find(c => c.department === _tldDept && c.quarter === _tldQuarter);
  if (!cyc) { _tldDetail = null; return null; }
  _tldDetail = await API.get(`/tld/cycles/${cyc.id}`);
  return _tldDetail;
}

async function _tldLoadCycles(body) {
  const det = await _tldFetchCycleDetail();
  if (!det) {
    body.innerHTML = `
      <div class="listcard"><div class="lrow" style="flex-direction:column;align-items:flex-start;gap:10px;padding:22px">
        <strong>No ${escapeHtml(_tldDeptLabel(_tldDept))} cycle for Q${_tldQuarter} ${_tldYear} yet</strong>
        <div style="font-size:13px;color:var(--muted)">Create the cycle when the new badges arrive from the dosimetry provider,
          set the exchange deadline, then register the badge serials.</div>
        <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
          <label style="font-size:13px">Exchange deadline
            <input id="tld-new-deadline" class="input" type="date" style="display:block;margin-top:4px"></label>
          <button class="open pri" style="width:auto" onclick="tldCreateCycle()">Create Q${_tldQuarter} ${_tldYear} cycle</button>
        </div>
      </div></div>`;
    return;
  }
  const c = det.cycle, badges = det.badges || [];
  const staffBadges = badges.filter(b => !b.is_control);
  const counts = {
    issued: badges.filter(b => b.status === 'issued').length,
    collected: badges.filter(b => b.status === 'collected').length,
    returned: badges.filter(b => b.status === 'returned').length,
    controls: badges.filter(b => b.is_control).length,
  };
  const dl = c.days_left;
  const dlChip = c.exchange_deadline
    ? (dl < 0 ? `<span class="sc no">Deadline overdue ${Math.abs(dl)}d</span>`
      : dl <= 7 ? `<span class="sc warn">${dl}d to deadline</span>`
      : `<span class="sc ok">${dl}d to deadline</span>`)
    : '<span class="sc warn">No deadline set</span>';
  const stChip = (s) => s === 'returned' ? '<span class="sc ok">Returned</span>'
    : s === 'collected' ? '<span class="sc warn">Collected</span>' : '<span class="sc no">Issued</span>';

  body.innerHTML = `
    <div class="listcard" style="margin-bottom:14px">
      <div class="lrow" style="flex-wrap:wrap;gap:10px">
        <div style="flex:1;min-width:200px">
          <strong>${escapeHtml(_tldDeptLabel(_tldDept))} — Q${_tldQuarter} ${_tldYear}</strong>
          <div style="font-size:12px;color:var(--muted)">Deadline: ${escapeHtml(c.exchange_deadline || '—')}
            · ${c.status === 'open' ? 'Open' : 'Closed'}${c.notes ? ' · ' + escapeHtml(c.notes) : ''}</div>
        </div>
        ${dlChip}
        <span class="sc no">${counts.issued} issued</span>
        <span class="sc warn">${counts.collected} collected</span>
        <span class="sc ok">${counts.returned} returned</span>
        <span class="sc">${counts.controls} control</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="ghost" onclick="openTldCycleEdit()">Edit cycle</button>
          <button class="open pri" style="width:auto" onclick="openTldAddBadges()">+ Add badges</button>
        </div>
      </div>
    </div>
    ${det.missing?.length ? `<div class="listcard" style="border-color:#E2933F;margin-bottom:14px"><div class="lrow" style="flex-wrap:wrap;background:rgba(226,147,63,.08)">
      <strong>No badge yet (${det.missing.length}):</strong>
      <span style="font-size:13px">${det.missing.map(m => escapeHtml(m.name)).join(', ')}</span></div></div>` : ''}
    ${badges.length ? `<div class="listcard">
      <div class="lrow" style="background:var(--card-alt);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);font-weight:600">
        <span style="width:120px">Serial</span>
        <span style="flex:1;min-width:150px">Holder</span>
        <span style="width:110px">Status</span>
        <span style="width:170px">Dates</span>
        <span style="width:100px;text-align:right">Actions</span>
      </div>
      ${badges.map(b => `<div class="lrow" style="flex-wrap:wrap">
        <span style="width:120px;font-weight:600">${escapeHtml(b.serial)}</span>
        <span style="flex:1;min-width:150px">${b.is_control ? '<span class="sc">CONTROL</span>' : escapeHtml(b.staff_name || '—')}
          ${b.note ? `<div style="font-size:11px;color:var(--muted)">${escapeHtml(b.note)}</div>` : ''}</span>
        <span style="width:110px;cursor:pointer" title="Click to advance status" onclick="tldCycleBadgeStatus(${b.id}, '${b.status}')">${stChip(b.status)}</span>
        <span style="width:170px;font-size:11px;color:var(--muted)">
          ${b.issued_at ? 'out ' + escapeHtml(b.issued_at) : ''}${b.collected_at ? ' · in ' + escapeHtml(b.collected_at) : ''}${b.returned_at ? ' · ret ' + escapeHtml(b.returned_at) : ''}</span>
        <span style="width:100px;display:flex;gap:6px;justify-content:flex-end">
          <button class="ghost" style="color:var(--danger,#E25555)" onclick="tldDeleteBadge(${b.id})">Delete</button>
        </span>
      </div>`).join('')}</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        ${counts.collected ? `<button class="ghost" onclick="tldReturnAllCollected()">Mark all collected as returned to provider</button>` : ''}
      </div>
      <div style="font-size:12px;color:var(--muted);margin-top:10px">Click a status chip to advance it: Issued → Collected → Returned.
        Handover/Receiving forms update statuses automatically — use the Forms tab for the documented exchange.</div>`
    : `<div class="listcard"><div class="lrow" style="justify-content:center;padding:24px;color:var(--muted)">No badges registered yet for this cycle.</div></div>`}`;
}

async function tldCreateCycle() {
  const deadline = document.getElementById('tld-new-deadline')?.value || '';
  try {
    await API.post('/tld/cycles', { department: _tldDept, year: _tldYear, quarter: _tldQuarter, exchange_deadline: deadline });
    toast('Cycle created'); loadTldBody();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

function openTldCycleEdit() {
  const c = _tldDetail?.cycle; if (!c) return;
  showModal('tld-cycle-modal', `
    <h3 style="margin:0 0 14px">Edit cycle — ${escapeHtml(_tldDeptLabel(_tldDept))} Q${_tldQuarter} ${_tldYear}</h3>
    <div style="display:grid;gap:12px">
      <label style="font-size:13px">Exchange deadline
        <input id="tld-cy-deadline" class="input" type="date" value="${escapeHtml(c.exchange_deadline || '')}" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Notes (optional)
        <input id="tld-cy-notes" class="input" maxlength="400" value="${escapeHtml(c.notes || '')}" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px;display:flex;align-items:center;gap:8px">
        <input id="tld-cy-closed" type="checkbox" ${c.status === 'closed' ? 'checked' : ''}> Cycle closed (badges returned, report received)</label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
      <button class="btn btn-ghost" onclick="closeModal('tld-cycle-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="saveTldCycle(${c.id})">Save</button>
    </div>`);
}

async function saveTldCycle(cid) {
  try {
    await API.put(`/tld/cycles/${cid}`, {
      exchange_deadline: document.getElementById('tld-cy-deadline').value,
      notes: document.getElementById('tld-cy-notes').value.trim(),
      status: document.getElementById('tld-cy-closed').checked ? 'closed' : 'open',
    });
    closeModal('tld-cycle-modal'); toast('Saved'); loadTldBody();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

function openTldAddBadges() {
  const det = _tldDetail; if (!det) return;
  const missing = det.missing || [];
  showModal('tld-badges-modal', `
    <h3 style="margin:0 0 8px">Add badges — Q${_tldQuarter} ${_tldYear}</h3>
    <div style="font-size:13px;color:var(--muted);margin-bottom:10px">Type each badge's serial number as printed by the provider. Leave blank to skip.</div>
    <div style="max-height:320px;overflow:auto;display:grid;gap:8px">
      ${missing.map(m => `
        <label style="display:flex;align-items:center;gap:8px;font-size:13.5px">
          <span style="flex:1">${escapeHtml(m.name)}</span>
          <input class="input tld-badge-serial" data-tid="${m.id}" placeholder="Serial" maxlength="60" style="width:150px"></label>`).join('')
      || '<div style="font-size:13px;color:var(--muted)">Every active roster member already has a badge in this cycle.</div>'}
      <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;border-top:1px solid var(--border,#e7e4f0);padding-top:10px">
        <span style="flex:1">Control badge (background)</span>
        <input class="input" id="tld-control-serial" placeholder="Serial" maxlength="60" style="width:150px"></label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-ghost" onclick="closeModal('tld-badges-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="tldSubmitBadges(${det.cycle.id})">Add badges</button>
    </div>`);
}

async function tldSubmitBadges(cid) {
  const badges = [];
  document.querySelectorAll('.tld-badge-serial').forEach(inp => {
    const serial = inp.value.trim();
    if (serial) badges.push({ serial, tld_staff_id: Number(inp.getAttribute('data-tid')) });
  });
  const ctrl = document.getElementById('tld-control-serial')?.value.trim();
  if (ctrl) badges.push({ serial: ctrl, is_control: true });
  if (!badges.length) { toast('Enter at least one serial', 'err'); return; }
  try {
    const d = await API.post(`/tld/cycles/${cid}/badges`, { badges });
    closeModal('tld-badges-modal'); toast(`Added ${d.added}`); loadTldBody();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

async function tldCycleBadgeStatus(bid, cur) {
  const next = cur === 'issued' ? 'collected' : (cur === 'collected' ? 'returned' : 'issued');
  try { await API.put(`/tld/badges/${bid}`, { status: next }); loadTldBody(); }
  catch (e) { toast(e.message || 'Failed', 'err'); }
}

async function tldDeleteBadge(bid) {
  if (!confirm('Delete this badge from the cycle?')) return;
  try { await API.delete(`/tld/badges/${bid}`); toast('Deleted'); loadTldBody(); }
  catch (e) { toast(e.message || 'Failed', 'err'); }
}

async function tldReturnAllCollected() {
  const ids = (_tldDetail?.badges || []).filter(b => b.status === 'collected').map(b => b.id);
  if (!ids.length) return;
  if (!confirm(`Mark ${ids.length} collected badge(s) as returned to the provider?`)) return;
  try {
    await API.post(`/tld/cycles/${_tldDetail.cycle.id}/badges/status`, { badge_ids: ids, status: 'returned' });
    toast('Marked returned'); loadTldBody();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

// ── Handover / receiving forms tab ────────────────────────────────────────────
async function _tldLoadForms(body) {
  const det = await _tldFetchCycleDetail();
  if (!det) {
    body.innerHTML = `<div class="listcard"><div class="lrow" style="justify-content:center;padding:24px;color:var(--muted)">
      No ${escapeHtml(_tldDeptLabel(_tldDept))} cycle for Q${_tldQuarter} ${_tldYear} — create it on the Cycles & Badges tab first.</div></div>`;
    return;
  }
  const forms = det.forms || [];
  const scans = (det.attachments || []).filter(a => a.kind === 'form_scan');
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      <div style="font-size:13px;color:var(--muted)">
        <b>Handover</b> = distributing new badges to staff · <b>Receiving</b> = collecting worn badges back.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="open pri" style="width:auto" onclick="openTldFormModal('handover')">+ Handover form</button>
        <button class="open pri" style="width:auto" onclick="openTldFormModal('receiving')">+ Receiving form</button>
      </div>
    </div>
    ${forms.length ? `<div class="listcard">
      ${forms.map(f => {
        const scan = scans.find(a => a.form_id === f.id);
        return `<div class="lrow" style="flex-wrap:wrap">
        <span class="sc ${f.kind === 'handover' ? 'no' : 'warn'}">${f.kind === 'handover' ? 'Handover' : 'Receiving'}</span>
        <span style="width:100px">${escapeHtml(f.form_date)}</span>
        <span style="flex:1;min-width:180px;font-size:13px">${escapeHtml(f.handed_by)} → ${escapeHtml(f.received_by)}
          <span style="color:var(--muted)">· ${f.badge_count} badge(s)</span></span>
        ${scan ? `<a class="ghost" style="text-decoration:none" href="/api/tld/attachments/${scan.id}" target="_blank" rel="noopener">Signed scan</a>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="ghost" onclick="printTldForm(${f.id})">Print / PDF</button>
          <button class="ghost" onclick="openTldAttachModal(${det.cycle.id}, 'form_scan', ${f.id})">Attach signed scan</button>
        </div>
      </div>`;
      }).join('')}</div>`
    : `<div class="listcard"><div class="lrow" style="justify-content:center;padding:24px;color:var(--muted)">No forms yet for this cycle.</div></div>`}
    <div style="font-size:12px;color:var(--muted);margin-top:10px">Saving a handover form marks its badges <b>issued</b>;
      a receiving form marks them <b>collected</b>. Print the form for signatures, or sign directly on screen — you can also attach the scanned signed paper copy.</div>`;
}

let _tldPads = {};
function openTldFormModal(kind) {
  const det = _tldDetail; if (!det) return;
  const badges = det.badges || [];
  // Handover: everything not yet collected/returned. Receiving: what's still out.
  const preselect = b => kind === 'handover' ? b.status === 'issued' : b.status === 'issued';
  const list = kind === 'receiving' ? badges.filter(b => b.status !== 'returned') : badges;
  if (!list.length) { toast('Register the badges on the Cycles & Badges tab first', 'err'); return; }
  const today = new Date().toISOString().slice(0, 10);
  showModal('tld-form-modal', `
    <h3 style="margin:0 0 8px">${kind === 'handover' ? 'Handover (distribution)' : 'Receiving (collection)'} — ${escapeHtml(_tldDeptLabel(_tldDept))} Q${_tldQuarter} ${_tldYear}</h3>
    <div style="display:grid;gap:12px">
      <label style="font-size:13px">Date
        <input id="tld-f-date" class="input" type="date" value="${today}" style="width:100%;margin-top:4px"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label style="font-size:13px">Handed over by
          <input id="tld-f-handed" class="input" maxlength="120" value="${kind === 'handover' ? escapeHtml(currentUser?.username || '') : ''}" style="width:100%;margin-top:4px"></label>
        <label style="font-size:13px">Received by
          <input id="tld-f-received" class="input" maxlength="120" value="${kind === 'receiving' ? escapeHtml(currentUser?.username || '') : ''}" style="width:100%;margin-top:4px"></label>
      </div>
      <div>
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">Badges on this form</div>
        <div style="max-height:200px;overflow:auto;border:1px solid var(--border,#e7e4f0);border-radius:10px;padding:8px">
          ${list.map(b => `<label style="display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:13.5px">
            <input type="checkbox" class="tld-f-badge" value="${b.id}" ${preselect(b) ? 'checked' : ''}>
            <b>${escapeHtml(b.serial)}</b> ${b.is_control ? '<span class="sc">CONTROL</span>' : escapeHtml(b.staff_name || '—')}
            <span style="margin-inline-start:auto;font-size:11px;color:var(--muted)">${b.status}</span></label>`).join('')}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div><div style="font-size:13px;font-weight:600;margin-bottom:4px">Signature — handed over</div>
          <div style="position:relative;border:2px dashed var(--border,#e7e4f0);border-radius:10px;height:110px">
            <canvas id="tld-sig-handed" style="width:100%;height:100%;display:block;touch-action:none"></canvas>
            <button type="button" class="ghost" style="position:absolute;top:4px;left:4px;font-size:11px" onclick="_tldPads.handed?.clear()">Clear</button></div></div>
        <div><div style="font-size:13px;font-weight:600;margin-bottom:4px">Signature — received</div>
          <div style="position:relative;border:2px dashed var(--border,#e7e4f0);border-radius:10px;height:110px">
            <canvas id="tld-sig-received" style="width:100%;height:100%;display:block;touch-action:none"></canvas>
            <button type="button" class="ghost" style="position:absolute;top:4px;left:4px;font-size:11px" onclick="_tldPads.received?.clear()">Clear</button></div></div>
      </div>
      <label style="font-size:13px">Note (optional)
        <input id="tld-f-note" class="input" maxlength="400" style="width:100%;margin-top:4px"></label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-ghost" onclick="closeModal('tld-form-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="saveTldForm('${kind}', ${det.cycle.id})">Save form</button>
    </div>`);
  _tldPads = { handed: _tldInitPad('tld-sig-handed'), received: _tldInitPad('tld-sig-received') };
}

// Small pointer-drawing signature pad (same approach as the consent page).
function _tldInitPad(canvasId) {
  const c = document.getElementById(canvasId);
  if (!c) return null;
  const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  c.width = Math.round(r.width || c.offsetWidth || 300) * dpr;
  c.height = Math.round(r.height || 110) * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#12227a';
  let drawing = false, ink = false;
  const pos = e => { const b = c.getBoundingClientRect(), t = e.touches ? e.touches[0] : e; return { x: t.clientX - b.left, y: t.clientY - b.top }; };
  const start = e => { e.preventDefault(); drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
  const move = e => { if (!drawing) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); ink = true; };
  const end = () => { drawing = false; };
  c.addEventListener('mousedown', start); c.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
  c.addEventListener('touchstart', start, { passive: false }); c.addEventListener('touchmove', move, { passive: false }); c.addEventListener('touchend', end);
  return {
    clear() { ctx.clearRect(0, 0, c.width, c.height); ink = false; },
    data() { try { return ink ? c.toDataURL('image/png') : null; } catch (e) { return null; } },
  };
}

async function saveTldForm(kind, cid) {
  const ids = [...document.querySelectorAll('.tld-f-badge:checked')].map(cb => Number(cb.value));
  const payload = {
    kind,
    form_date: document.getElementById('tld-f-date').value,
    handed_by: document.getElementById('tld-f-handed').value.trim(),
    received_by: document.getElementById('tld-f-received').value.trim(),
    badge_ids: ids,
    note: document.getElementById('tld-f-note').value.trim(),
    handed_sig: _tldPads.handed?.data() || null,
    received_sig: _tldPads.received?.data() || null,
  };
  if (!payload.form_date) { toast('Pick the date', 'err'); return; }
  if (!payload.handed_by || !payload.received_by) { toast('Both names are required', 'err'); return; }
  if (!ids.length) { toast('Select at least one badge', 'err'); return; }
  try {
    const d = await API.post(`/tld/cycles/${cid}/forms`, payload);
    closeModal('tld-form-modal'); toast('Form saved');
    loadTldBody();
    printTldForm(d.id);
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

// Printable A4 form (browser print → Save as PDF), mirroring printEmployeeFile.
async function printTldForm(fid) {
  let d;
  try { d = await API.get(`/tld/forms/${fid}`); }
  catch (e) { toast(e.message || 'Failed to load form', 'err'); return; }
  const f = d.form;
  const badges = Array.isArray(f.badges) ? f.badges : [];
  const kindTitle = f.kind === 'handover' ? 'TLD Badge Handover (Distribution)' : 'TLD Badge Receiving (Collection)';
  const rows = badges.map((b, i) => `<tr>
      <td>${i + 1}</td><td style="font-weight:600">${escapeHtml(b.serial)}</td>
      <td>${b.is_control ? 'CONTROL BADGE' : escapeHtml(b.staff_name || '—')}</td>
      <td>${escapeHtml(b.employee_no || '—')}</td></tr>`).join('');
  const sig = (label, name, img) => `
    <div class="sig">
      <div class="s-lbl">${label}</div>
      ${img ? `<img src="${img}" alt="signature">` : '<div class="s-line"></div>'}
      <div class="s-name">${escapeHtml(name)}</div>
    </div>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print the form', 'err'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8">
    <title>${kindTitle} — ${escapeHtml(f.department)} Q${f.quarter} ${f.year}</title>
    <style>
      *{box-sizing:border-box} body{font-family:'Poppins',system-ui,Arial,sans-serif;color:#2B2458;margin:0;padding:32px 34px}
      .hd{display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #6b4eff;padding-bottom:14px;margin-bottom:18px}
      .hd img{height:38px} .hd .t{text-align:right} .hd .t b{font-size:17px} .hd .t div{font-size:11px;color:#8585A8}
      .meta{display:flex;gap:26px;flex-wrap:wrap;margin-bottom:16px}
      .meta div span{display:block;font-size:10px;color:#8585A8;text-transform:uppercase;letter-spacing:.5px}
      .meta div b{font-size:14px}
      table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
      th{background:#f4f1fb;color:#5b5b78;text-align:left;padding:8px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.4px}
      td{padding:8px 10px;border-bottom:1px solid #eee}
      .sigs{display:flex;gap:40px;margin-top:38px}
      .sig{flex:1;text-align:center}
      .sig img{max-height:70px;max-width:100%}
      .s-line{height:70px;border-bottom:1.5px solid #2B2458}
      .s-lbl{font-size:10px;color:#8585A8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
      .s-name{border-top:1.5px solid #2B2458;margin-top:4px;padding-top:5px;font-size:13px;font-weight:600}
      .note{margin-top:16px;font-size:12px;color:#5b5b78}
      .foot{margin-top:26px;font-size:10px;color:#9a95ba;text-align:center;border-top:1px solid #eee;padding-top:10px}
      @media print{body{padding:0}}
    </style></head><body>
    <div class="hd"><img src="/meena_logo.png" alt="Meena" onerror="this.style.display='none'">
      <div class="t"><b>${kindTitle}</b><div>TLD Dosimetry Program · ${escapeHtml(f.department === 'radiology' ? 'Radiology Department' : 'Dental Department')}</div></div></div>
    <div class="meta">
      <div><span>Department</span><b>${escapeHtml(f.department === 'radiology' ? 'Radiology' : 'Dental')}</b></div>
      <div><span>Cycle</span><b>Q${f.quarter} ${f.year}</b></div>
      <div><span>Date</span><b>${escapeHtml(f.form_date)}</b></div>
      <div><span>Badges</span><b>${badges.length}</b></div>
    </div>
    <table><thead><tr><th>#</th><th>Badge serial</th><th>Assigned to</th><th>Employee No.</th></tr></thead>
      <tbody>${rows}</tbody></table>
    ${f.note ? `<div class="note"><b>Note:</b> ${escapeHtml(f.note)}</div>` : ''}
    <div class="sigs">
      ${sig('Handed over by', f.handed_by, f.handed_sig)}
      ${sig('Received by', f.received_by, f.received_sig)}
    </div>
    <div class="foot">Generated by Meena Health · TLD Dosimetry Program · Form #${f.id}</div>
    <script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script>
    </body></html>`);
  w.document.close();
}

// ── Attachments (dose report / signed scans) ──────────────────────────────────
function openTldAttachModal(cid, kind, formId) {
  const title = kind === 'dose_report' ? "Upload the provider's dose report" : 'Attach the scanned signed form';
  showModal('tld-attach-modal', `
    <h3 style="margin:0 0 12px">${title}</h3>
    <div style="font-size:13px;color:var(--muted);margin-bottom:10px">PDF or a clear photo (JPG/PNG) — stored against this quarter's cycle.</div>
    <input type="file" id="tld-attach-file" accept="image/*,application/pdf" style="width:100%">
    <label style="font-size:13px;display:block;margin-top:10px">Label
      <input id="tld-attach-name" class="input" maxlength="80" value="${kind === 'dose_report' ? `Dose report Q${_tldQuarter} ${_tldYear}` : `Signed form scan`}" style="width:100%;margin-top:4px"></label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-ghost" onclick="closeModal('tld-attach-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="tldSubmitAttach(${cid}, '${kind}', ${formId || 'null'})">Upload</button>
    </div>`);
}

function tldSubmitAttach(cid, kind, formId) {
  const inp = document.getElementById('tld-attach-file');
  const f = inp?.files && inp.files[0];
  if (!f) { toast('Choose a file first', 'err'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await API.post(`/tld/cycles/${cid}/attachments`, {
        kind, form_id: formId || null, file: reader.result,
        name: document.getElementById('tld-attach-name').value.trim() || 'Document',
      });
      closeModal('tld-attach-modal'); toast('Uploaded'); loadTldBody();
    } catch (e) { toast(e.message || 'Upload failed', 'err'); }
  };
  reader.readAsDataURL(f);
}

async function tldDeleteAttachment(aid) {
  if (!confirm('Delete this attachment?')) return;
  try { await API.delete(`/tld/attachments/${aid}`); toast('Deleted'); loadTldBody(); }
  catch (e) { toast(e.message || 'Failed', 'err'); }
}

// ── Quarterly report tab ──────────────────────────────────────────────────────
async function _tldLoadReport(body) {
  const d = await API.get(`/tld/report?department=${_tldDept}&year=${_tldYear}&quarter=${_tldQuarter}`);
  _tldReport = d;
  if (!d.exists) {
    body.innerHTML = `<div class="listcard"><div class="lrow" style="justify-content:center;padding:24px;color:var(--muted)">
      No ${escapeHtml(d.deptLabel)} cycle for Q${_tldQuarter} ${_tldYear} — create it on the Cycles & Badges tab first.
      (${d.roster_count} active staff in the roster.)</div></div>`;
    return;
  }
  const s = d.summary;
  const tile = (n, l, color) => `<div class="listcard" style="flex:1;min-width:110px;text-align:center;padding:14px 10px">
    <div style="font-size:24px;font-weight:800;${color ? `color:${color}` : ''}">${n}</div>
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">${l}</div></div>`;
  const doseReports = (d.attachments || []).filter(a => a.kind === 'dose_report');
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      <div style="font-size:13px;color:var(--muted)">Compliance — <b>${escapeHtml(d.deptLabel)}</b>, Q${_tldQuarter} ${_tldYear}
        ${d.cycle.exchange_deadline ? ` · deadline ${escapeHtml(d.cycle.exchange_deadline)}` : ''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="ghost" onclick="openTldAttachModal(${d.cycle.id}, 'dose_report', null)">Upload dose report (PDF)</button>
        <button class="ghost" onclick="tldExportXlsx()">Export XLSX</button>
        <button class="open pri" style="width:auto" onclick="printTldReport()">Print / PDF</button>
      </div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      ${tile(s.roster_count, 'Roster')}
      ${tile(s.badges_total, 'Badges')}
      ${tile(s.issued, 'Still out', s.issued ? 'var(--danger,#E25555)' : '')}
      ${tile(s.collected, 'Collected', '#E2933F')}
      ${tile(s.returned, 'Returned', '#00A87D')}
      ${tile(s.controls, 'Controls')}
    </div>
    ${s.no_badge?.length ? `<div class="listcard" style="border-color:#E25555;margin-bottom:12px"><div class="lrow" style="flex-wrap:wrap;background:rgba(226,85,85,.06)">
      <strong>No badge this quarter (${s.no_badge.length}):</strong>
      <span style="font-size:13px">${s.no_badge.map(m => escapeHtml(m.name)).join(', ')}</span></div></div>` : ''}
    ${s.not_returned?.length ? `<div class="listcard" style="border-color:#E2933F;margin-bottom:12px"><div class="lrow" style="flex-wrap:wrap;background:rgba(226,147,63,.08)">
      <strong>Badge not yet collected (${s.not_returned.length}):</strong>
      <span style="font-size:13px">${s.not_returned.map(b => `${escapeHtml(b.staff_name || b.serial)}`).join(', ')}</span></div></div>` : ''}
    <div class="listcard" style="margin-bottom:12px">
      <div class="lrow" style="background:var(--card-alt);font-weight:600;font-size:12px">Attachments</div>
      ${(d.attachments || []).length ? d.attachments.map(a => `<div class="lrow" style="flex-wrap:wrap">
        <span class="sc ${a.kind === 'dose_report' ? 'ok' : ''}">${a.kind === 'dose_report' ? 'Dose report' : a.kind === 'form_scan' ? 'Signed scan' : 'File'}</span>
        <a style="flex:1;min-width:160px" href="/api/tld/attachments/${a.id}" target="_blank" rel="noopener">${escapeHtml(a.name)}</a>
        <span style="font-size:12px;color:var(--muted)">${escapeHtml(a.created_at || '')} · ${escapeHtml(a.by_name || '')}</span>
        <button class="ghost" style="color:var(--danger,#E25555)" onclick="tldDeleteAttachment(${a.id})">Delete</button>
      </div>`).join('') : `<div class="lrow" style="justify-content:center;color:var(--muted)">No attachments yet${doseReports.length ? '' : " — upload the provider's quarterly dose report when it arrives"}.</div>`}
    </div>
    <div class="listcard">
      <div class="lrow" style="background:var(--card-alt);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);font-weight:600">
        <span style="width:120px">Serial</span><span style="flex:1;min-width:150px">Holder</span>
        <span style="width:90px">Status</span><span style="width:200px">Issued / Collected / Returned</span>
      </div>
      ${(d.badges || []).map(b => `<div class="lrow" style="flex-wrap:wrap">
        <span style="width:120px;font-weight:600">${escapeHtml(b.serial)}</span>
        <span style="flex:1;min-width:150px">${b.is_control ? 'CONTROL' : escapeHtml(b.staff_name || '—')}</span>
        <span style="width:90px">${escapeHtml(b.status)}</span>
        <span style="width:200px;font-size:12px;color:var(--muted)">${escapeHtml(b.issued_at || '—')} / ${escapeHtml(b.collected_at || '—')} / ${escapeHtml(b.returned_at || '—')}</span>
      </div>`).join('')}
    </div>`;
}

async function tldExportXlsx() {
  const d = _tldReport;
  if (!d || !d.exists) { toast('Nothing to export', 'err'); return; }
  if (!window.XLSX) {
    showLoader('Loading export library…');
    try { await loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'); }
    finally { hideLoader(); }
  }
  const s = d.summary;
  const wsData = [
    [`Meena Health — TLD Dosimetry Compliance Report`],
    [`${d.deptLabel} Department — Q${d.quarter} ${d.year}`],
    [],
    ['Roster (active)', s.roster_count], ['Badges total', s.badges_total], ['Control badges', s.controls],
    ['Issued (still out)', s.issued], ['Collected', s.collected], ['Returned to provider', s.returned],
    [],
    ['Serial', 'Holder', 'Employee No.', 'Type', 'Status', 'Issued', 'Collected', 'Returned', 'Note'],
    ...(d.badges || []).map(b => [b.serial, b.is_control ? 'CONTROL' : (b.staff_name || ''), b.employee_no || '',
      b.is_control ? 'Control' : 'Staff', b.status, b.issued_at || '', b.collected_at || '', b.returned_at || '', b.note || '']),
    [],
    ['Staff without a badge this quarter'],
    ...(s.no_badge || []).map(m => [m.name, m.employee_no || '']),
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 16 }, { wch: 28 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, ws, `Q${d.quarter} ${d.year}`);
  XLSX.writeFile(wb, `TLD-${d.deptLabel}-Q${d.quarter}-${d.year}.xlsx`);
  toast('XLSX exported');
}

function printTldReport() {
  const d = _tldReport;
  if (!d || !d.exists) { toast('Nothing to print', 'err'); return; }
  const s = d.summary;
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const rows = (d.badges || []).map((b, i) => `<tr>
    <td>${i + 1}</td><td style="font-weight:600">${escapeHtml(b.serial)}</td>
    <td>${b.is_control ? 'CONTROL BADGE' : escapeHtml(b.staff_name || '—')}</td>
    <td>${escapeHtml(b.status)}</td>
    <td>${escapeHtml(b.issued_at || '—')}</td><td>${escapeHtml(b.collected_at || '—')}</td><td>${escapeHtml(b.returned_at || '—')}</td></tr>`).join('');
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print the report', 'err'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8">
    <title>TLD Compliance — ${escapeHtml(d.deptLabel)} Q${d.quarter} ${d.year}</title>
    <style>
      *{box-sizing:border-box} body{font-family:'Poppins',system-ui,Arial,sans-serif;color:#2B2458;margin:0;padding:32px 34px}
      .hd{display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #6b4eff;padding-bottom:14px;margin-bottom:18px}
      .hd img{height:38px} .hd .t{text-align:right} .hd .t b{font-size:17px} .hd .t div{font-size:11px;color:#8585A8}
      .meta{display:flex;gap:26px;flex-wrap:wrap;margin-bottom:16px}
      .meta div span{display:block;font-size:10px;color:#8585A8;text-transform:uppercase;letter-spacing:.5px}
      .meta div b{font-size:15px}
      table{width:100%;border-collapse:collapse;font-size:11.5px;margin-top:8px}
      th{background:#f4f1fb;color:#5b5b78;text-align:left;padding:7px 9px;font-size:9.5px;text-transform:uppercase;letter-spacing:.4px}
      td{padding:7px 9px;border-bottom:1px solid #eee}
      .warn{margin-top:14px;font-size:12px} .warn b{color:#c0261a}
      .foot{margin-top:24px;font-size:10px;color:#9a95ba;text-align:center;border-top:1px solid #eee;padding-top:10px}
      @media print{body{padding:0}}
    </style></head><body>
    <div class="hd"><img src="/meena_logo.png" alt="Meena" onerror="this.style.display='none'">
      <div class="t"><b>TLD Dosimetry — Quarterly Compliance Report</b>
      <div>${escapeHtml(d.deptLabel)} Department · Q${d.quarter} ${d.year}</div></div></div>
    <div class="meta">
      <div><span>Department</span><b>${escapeHtml(d.deptLabel)}</b></div>
      <div><span>Quarter</span><b>Q${d.quarter} ${d.year}</b></div>
      <div><span>Deadline</span><b>${escapeHtml(d.cycle.exchange_deadline || '—')}</b></div>
      <div><span>Roster</span><b>${s.roster_count}</b></div>
      <div><span>Badges</span><b>${s.badges_total} (${s.controls} control)</b></div>
      <div><span>Returned</span><b>${s.returned} / ${s.badges_total}</b></div>
      <div><span>Generated</span><b>${today}</b></div>
    </div>
    <table><thead><tr><th>#</th><th>Serial</th><th>Holder</th><th>Status</th><th>Issued</th><th>Collected</th><th>Returned</th></tr></thead>
      <tbody>${rows}</tbody></table>
    ${s.no_badge?.length ? `<div class="warn"><b>Staff without a badge this quarter (${s.no_badge.length}):</b> ${s.no_badge.map(m => escapeHtml(m.name)).join(', ')}</div>` : ''}
    ${s.not_returned?.length ? `<div class="warn"><b>Badges not yet collected (${s.not_returned.length}):</b> ${s.not_returned.map(b => escapeHtml(b.staff_name || b.serial)).join(', ')}</div>` : ''}
    <div class="foot">Generated by Meena Health · TLD Dosimetry Program · ${today}</div>
    <script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script>
    </body></html>`);
  w.document.close();
}
