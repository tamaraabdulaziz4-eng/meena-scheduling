// ── Equipment maintenance ─────────────────────────────────────────────────────
// Devices per branch with a next preventive-maintenance due date + a service log.
// The lead is reminded before the PM is due.

let _eqList = [];
let _eqBranch = '';
let _eqKinds = ['preventive', 'corrective', 'calibration', 'inspection', 'other'];

function _eqIsAdmin() { return ['admin', 'manager', 'superadmin'].includes(currentUser?.role); }

// Returns [label, .sc chip modifier] — overdue/due → no (red), soon → warn, healthy → ok.
function _eqStatus(d) {
  if (d === null || d === undefined || d === '') return ['No PM set', ''];
  d = Number(d);
  if (d < 0) return [`Overdue ${Math.abs(d)}d`, 'no'];
  if (d === 0) return ['Due today', 'no'];
  if (d <= 30) return [`${d}d left`, 'warn'];
  return [`${d}d left`, 'ok'];
}

async function renderEquipmentPage() {
  setTopbar('Maintenance', 'Equipment & preventive maintenance');
  const c = document.getElementById('content');
  const canPickBranch = ['manager', 'superadmin'].includes(currentUser?.role);
  c.innerHTML = `
    <div class="cc">
    ${pageHero('Maintenance', 'Maintenance', 'Track devices and preventive maintenance — get reminded before each PM is due')}
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      ${canPickBranch ? `<select id="eq-branch" class="rep-select" style="max-width:220px"></select>` : '<div></div>'}
      ${_eqIsAdmin() ? `<button class="open pri" style="width:auto" onclick="openEqModal()">+ Add device</button>` : ''}
    </div>
    <div id="eq-checks"></div>
    <div id="eq-list">${LOADING_HTML}</div>
    </div>`;
  if (typeof renderHomeShiftChecks === 'function') renderHomeShiftChecks('eq-checks');   // "Equipment checks today" moved here from Home
  if (canPickBranch) {
    try { if (!allBranches.length) await loadBranches(); } catch (e) {}
    const sel = document.getElementById('eq-branch');
    if (sel) {
      sel.innerHTML = allBranches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
      if (!_eqBranch) _eqBranch = String(allBranches[0]?.id || '');
      sel.value = _eqBranch;
      sel.onchange = () => { _eqBranch = sel.value; loadEquipment(); };
    }
  }
  loadEquipment();
}

async function loadEquipment() {
  const box = document.getElementById('eq-list');
  if (!box) return;
  const qs = _eqBranch ? `?branch_id=${_eqBranch}` : '';
  let d;
  try { d = await API.get(`/equipment${qs}`); }
  catch (e) { box.innerHTML = `<div class="rep-empty">${escapeHtml(e.message || 'Failed to load')}</div>`; return; }
  _eqList = d.equipment || [];
  if (d.kinds) _eqKinds = d.kinds;
  const isAdmin = _eqIsAdmin();
  if (!_eqList.length) {
    box.innerHTML = `<div class="listcard"><div class="lrow" style="justify-content:center;padding:24px;color:var(--muted)">No devices yet.${isAdmin ? ' Add one to start tracking maintenance.' : ''}</div></div>`;
    return;
  }
  box.innerHTML = `<div class="listcard">${_eqList.map(e => {
      const [txt, cls] = _eqStatus(e.days_left);
      const adminBtns = isAdmin ? `
        <button class="open pri" style="width:auto" onclick="openMaintModal(${e.id})">Log service</button>
        <button class="ghost" onclick="openEqHistory(${e.id})">History</button>
        <button class="ghost" onclick='openEqModal(${JSON.stringify(e).replace(/'/g, "&#39;")})'>Edit</button>
        <button class="ghost" style="color:var(--danger,#E25555)" onclick="deleteEquipment(${e.id})">Delete</button>` : '';
      return `
      <div class="lrow" style="flex-wrap:wrap">
        <div style="flex:1;min-width:170px">
          <strong>${escapeHtml(e.name)}</strong>${e.model ? ` <span style="font-size:11px;color:var(--muted)">${escapeHtml(e.model)}</span>` : ''}
          <div style="font-size:11.5px;color:var(--muted);margin-top:2px">Serial ${escapeHtml(e.serial || '—')} · ${escapeHtml(e.vendor || 'No vendor')}</div>
        </div>
        <div style="font-size:12.5px;color:var(--muted);white-space:nowrap">Next PM <b style="color:var(--ink,inherit)">${escapeHtml(e.next_pm_date || '—')}</b></div>
        <span class="sc ${cls}">${txt}</span>
        ${adminBtns ? `<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${adminBtns}</div>` : ''}
      </div>`;
    }).join('')}</div>`;
}

function _eqItem(id) { return _eqList.find(e => e.id === id) || {}; }

function openEqModal(eq) {
  const e = eq || null;
  showModal('eq-modal', `
    <h3 style="margin:0 0 14px">${e ? 'Edit device' : 'Add device'}</h3>
    <div style="display:grid;gap:12px">
      <label style="font-size:13px">Device name
        <input id="eq-name" class="input" maxlength="120" value="${e ? escapeHtml(e.name || '') : ''}" placeholder="e.g. CT Scanner" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Model (optional)
        <input id="eq-model" class="input" maxlength="80" value="${e ? escapeHtml(e.model || '') : ''}" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Serial (optional)
        <input id="eq-serial" class="input" maxlength="80" value="${e ? escapeHtml(e.serial || '') : ''}" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Service vendor (optional)
        <input id="eq-vendor" class="input" maxlength="80" value="${e ? escapeHtml(e.vendor || '') : ''}" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Next preventive maintenance date
        <input id="eq-pm" type="date" class="input" value="${e ? (e.next_pm_date || '') : ''}" style="width:100%;margin-top:4px"></label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
      <button class="btn btn-ghost" onclick="closeModal('eq-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="saveEquipment(${e ? e.id : 'null'})">${e ? 'Save' : 'Add'}</button>
    </div>`);
}

async function saveEquipment(id) {
  const v = i => { const el = document.getElementById(i); return el ? el.value.trim() : ''; };
  const payload = { name: v('eq-name'), model: v('eq-model'), serial: v('eq-serial'), vendor: v('eq-vendor'), next_pm_date: v('eq-pm') };
  if (_eqBranch) payload.branch_id = Number(_eqBranch);
  if (!payload.name) { toast('Device name is required', 'err'); return; }
  try {
    if (id) await API.put(`/equipment/${id}`, payload);
    else await API.post('/equipment', payload);
    closeModal('eq-modal'); toast(id ? 'Saved' : 'Added'); loadEquipment();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

async function deleteEquipment(id) {
  if (!confirm('Delete this device and its maintenance history?')) return;
  try { await API.delete(`/equipment/${id}`); toast('Deleted'); loadEquipment(); }
  catch (e) { toast(e.message || 'Failed', 'err'); }
}

function openMaintModal(id) {
  const e = _eqItem(id);
  const today = new Date().toISOString().slice(0, 10);
  showModal('maint-modal', `
    <h3 style="margin:0 0 14px">Log service — ${escapeHtml(e.name || '')}</h3>
    <div style="display:grid;gap:12px">
      <label style="font-size:13px">Type
        <select id="mt-kind" class="input" style="width:100%;margin-top:4px">${_eqKinds.map(k => `<option value="${k}">${k.charAt(0).toUpperCase() + k.slice(1)}</option>`).join('')}</select></label>
      <label style="font-size:13px">Service date
        <input id="mt-date" type="date" class="input" value="${today}" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Next PM due <span style="color:var(--muted)">(sets the reminder)</span>
        <input id="mt-next" type="date" class="input" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Vendor (optional)
        <input id="mt-vendor" class="input" maxlength="80" value="${escapeHtml(e.vendor || '')}" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Cost (optional)
        <input id="mt-cost" type="number" min="0" step="any" class="input" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Note (optional)
        <input id="mt-note" class="input" maxlength="200" style="width:100%;margin-top:4px"></label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
      <button class="btn btn-ghost" onclick="closeModal('maint-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="saveMaintenance(${id})">Save</button>
    </div>`);
}

async function saveMaintenance(id) {
  const v = i => { const el = document.getElementById(i); return el ? el.value.trim() : ''; };
  const payload = { kind: v('mt-kind'), service_date: v('mt-date'), next_due: v('mt-next'), vendor: v('mt-vendor'), cost: v('mt-cost'), note: v('mt-note') };
  if (!payload.service_date) { toast('Service date is required', 'err'); return; }
  try {
    await API.post(`/equipment/${id}/maintenance`, payload);
    closeModal('maint-modal'); toast('Service logged'); loadEquipment();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

async function openEqHistory(id) {
  const e = _eqItem(id);
  showModal('eq-hist-modal', `<h3 style="margin:0 0 12px">Maintenance history — ${escapeHtml(e.name || '')}</h3><div id="eq-hist-body">${LOADING_HTML}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btn-ghost" onclick="closeModal('eq-hist-modal')">Close</button></div>`);
  let d;
  try { d = await API.get(`/equipment/${id}/maintenance`); } catch (er) { document.getElementById('eq-hist-body').innerHTML = `<div class="rep-empty">${escapeHtml(er.message)}</div>`; return; }
  const rows = d.records || [];
  document.getElementById('eq-hist-body').innerHTML = rows.length ? `<div class="table-wrap" style="box-shadow:none;border:1px solid var(--border)"><table>
    <thead><tr><th>Date</th><th>Type</th><th>Next due</th><th>Vendor</th><th>Cost</th><th>Note</th></tr></thead>
    <tbody>${rows.map(m => `<tr>
      <td style="font-weight:600">${escapeHtml(m.service_date)}</td><td>${escapeHtml(m.kind)}</td>
      <td>${escapeHtml(m.next_due || '—')}</td><td>${escapeHtml(m.vendor || '—')}</td>
      <td>${m.cost != null ? escapeHtml(String(m.cost)) : '—'}</td><td>${escapeHtml(m.note || '—')}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="rep-empty">No maintenance logged yet.</div>`;
}
