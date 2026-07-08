// ── Consumables inventory ─────────────────────────────────────────────────────
// Staff log what they take from stock → quantity drops; when it reaches the
// reorder level the branch lead is alerted to reorder.

let _invItems = [];
let _invBranch = '';

function _invIsAdmin() { return ['admin', 'manager', 'superadmin'].includes(currentUser?.role); }

async function renderInventoryPage() {
  setTopbar('Inventory', 'Consumables stock');
  const c = document.getElementById('content');
  const canPickBranch = ['manager', 'superadmin'].includes(currentUser?.role);
  c.innerHTML = `
    <div class="cc">
    ${pageHero('Inventory', 'Inventory', 'Track consumables — staff log what they take, the lead is alerted at the reorder level')}
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      ${canPickBranch ? `<select id="inv-branch" class="rep-select" style="max-width:220px"></select>` : '<div></div>'}
      ${_invIsAdmin() ? `<button class="open pri" style="width:auto" onclick="openInvItemModal()">+ Add item</button>` : ''}
    </div>
    <div id="inv-list">${LOADING_HTML}</div>
    </div>`;
  if (canPickBranch) {
    try { if (!allBranches.length) await loadBranches(); } catch (e) {}
    const sel = document.getElementById('inv-branch');
    if (sel) {
      sel.innerHTML = allBranches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
      if (!_invBranch) _invBranch = String(allBranches[0]?.id || '');
      sel.value = _invBranch;
      sel.onchange = () => { _invBranch = sel.value; loadInventory(); };
    }
  }
  loadInventory();
}

async function loadInventory() {
  const box = document.getElementById('inv-list');
  if (!box) return;
  const qs = _invBranch ? `?branch_id=${_invBranch}` : '';
  let d;
  try { d = await API.get(`/inventory${qs}`); }
  catch (e) { box.innerHTML = `<div class="rep-empty">${escapeHtml(e.message || 'Failed to load')}</div>`; return; }
  _invItems = d.items || [];
  const isAdmin = _invIsAdmin();
  if (!_invItems.length) {
    box.innerHTML = `<div class="listcard"><div class="lrow" style="justify-content:center;padding:24px;color:var(--muted)">No stock items yet.${isAdmin ? ' Add one to start tracking.' : ''}</div></div>`;
    return;
  }
  box.innerHTML = `<div class="listcard">${_invItems.map(it => {
      const unit = it.unit ? ' ' + escapeHtml(it.unit) : '';
      const fill = Math.max(3, Math.min(100, it.pct));
      const bar = `<div class="rep-load"><div class="rep-load-track"><div class="rep-load-fill${it.low ? ' hot' : ''}" style="width:${fill}%"></div></div></div>`;
      const status = it.low
        ? `<span class="sc no">Reorder</span>`
        : (it.pct <= 75 ? `<span class="sc warn">${it.pct}%</span>` : `<span class="sc ok">${it.pct}%</span>`);
      const adminBtns = isAdmin ? `
        <button class="ghost" onclick="openInvRestock(${it.id})">Restock</button>
        <button class="ghost" onclick="openInvHistory(${it.id})">History</button>
        <button class="ghost" onclick='openInvItemModal(${JSON.stringify(it).replace(/'/g, "&#39;")})'>Edit</button>
        <button class="ghost" style="color:var(--danger,#E25555)" onclick="deleteInvItem(${it.id})">Delete</button>` : '';
      return `
      <div class="lrow" style="flex-wrap:wrap">
        <div style="flex:1;min-width:150px">
          <strong>${escapeHtml(it.name)}</strong>${it.unit ? ` <span style="font-size:11px;color:var(--muted)">(${escapeHtml(it.unit)})</span>` : ''}
          <div style="margin-top:5px;max-width:220px">${bar}</div>
        </div>
        <div style="font-size:13px;white-space:nowrap"><b style="color:${it.low ? 'var(--danger,#E25555)' : 'inherit'}">${it.qty}</b> / ${it.full_qty}${unit}</div>
        ${status}
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="open pri" style="width:auto" onclick="openInvTake(${it.id})">Take</button>
          ${adminBtns}
        </div>
      </div>`;
    }).join('')}</div>
    <div style="font-size:12px;color:var(--muted);margin-top:10px">When an item drops to its reorder level it turns red and the branch lead is notified to reorder.</div>`;
}

function _invItem(id) { return _invItems.find(i => i.id === id) || {}; }

function openInvTake(id) {
  const it = _invItem(id);
  showModal('inv-take-modal', `
    <h3 style="margin:0 0 12px">Take from stock — ${escapeHtml(it.name || '')}</h3>
    <div style="font-size:13px;color:var(--muted);margin-bottom:10px">Remaining: <b>${it.qty}</b> / ${it.full_qty}${it.unit ? ' ' + escapeHtml(it.unit) : ''}</div>
    <label style="font-size:13px">Amount taken
      <input id="inv-take-amount" class="input" type="number" min="0" step="any" value="1" style="width:100%;margin-top:4px"></label>
    <label style="font-size:13px;margin-top:10px;display:block">Note (optional)
      <input id="inv-take-reason" class="input" maxlength="120" style="width:100%;margin-top:4px"></label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-ghost" onclick="closeModal('inv-take-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="submitInvTake(${id})">Confirm</button>
    </div>`);
}

async function submitInvTake(id) {
  const amount = Number(document.getElementById('inv-take-amount').value);
  if (!(amount > 0)) { toast('Enter an amount', 'err'); return; }
  try {
    await API.post(`/inventory/${id}/take`, { amount, reason: document.getElementById('inv-take-reason').value.trim() });
    closeModal('inv-take-modal'); toast('Recorded'); loadInventory();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

function openInvRestock(id) {
  const it = _invItem(id);
  showModal('inv-restock-modal', `
    <h3 style="margin:0 0 12px">Restock — ${escapeHtml(it.name || '')}</h3>
    <label style="font-size:13px">Amount added
      <input id="inv-restock-amount" class="input" type="number" min="0" step="any" value="${it.full_qty || 1}" style="width:100%;margin-top:4px"></label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-ghost" onclick="closeModal('inv-restock-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="submitInvRestock(${id})">Add</button>
    </div>`);
}

async function submitInvRestock(id) {
  const amount = Number(document.getElementById('inv-restock-amount').value);
  if (!(amount > 0)) { toast('Enter an amount', 'err'); return; }
  try {
    await API.post(`/inventory/${id}/restock`, { amount });
    closeModal('inv-restock-modal'); toast('Restocked'); loadInventory();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

function openInvItemModal(item) {
  const it = item || null;
  showModal('inv-item-modal', `
    <h3 style="margin:0 0 14px">${it ? 'Edit item' : 'Add stock item'}</h3>
    <div style="display:grid;gap:12px">
      <label style="font-size:13px">Item name
        <input id="inv-name" class="input" maxlength="120" value="${it ? escapeHtml(it.name || '') : ''}" placeholder="e.g. Contrast 100ml" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Unit (optional)
        <input id="inv-unit" class="input" maxlength="20" value="${it ? escapeHtml(it.unit || '') : ''}" placeholder="box / bottle / pcs" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Full quantity (when fully stocked)
        <input id="inv-full" class="input" type="number" min="0" step="any" value="${it ? it.full_qty : ''}" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px">Reorder level <span style="color:var(--muted)">(alert at; default half)</span>
        <input id="inv-reorder" class="input" type="number" min="0" step="any" value="${it ? it.reorder_level : ''}" placeholder="auto = half" style="width:100%;margin-top:4px"></label>
      ${it ? '' : `<label style="font-size:13px">Current quantity now <span style="color:var(--muted)">(default = full)</span>
        <input id="inv-qty" class="input" type="number" min="0" step="any" placeholder="= full" style="width:100%;margin-top:4px"></label>`}
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
      <button class="btn btn-ghost" onclick="closeModal('inv-item-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="saveInvItem(${it ? it.id : 'null'})">${it ? 'Save' : 'Add'}</button>
    </div>`);
}

async function saveInvItem(id) {
  const v = i => { const e = document.getElementById(i); return e ? e.value.trim() : ''; };
  const payload = { name: v('inv-name'), unit: v('inv-unit'), full_qty: v('inv-full'), reorder_level: v('inv-reorder') };
  if (_invBranch) payload.branch_id = Number(_invBranch);
  if (!payload.name || payload.full_qty === '') { toast('Name and full quantity are required', 'err'); return; }
  const qtyEl = document.getElementById('inv-qty');
  if (qtyEl && qtyEl.value !== '') payload.qty = qtyEl.value.trim();
  try {
    if (id) await API.put(`/inventory/${id}`, payload);
    else await API.post('/inventory', payload);
    closeModal('inv-item-modal'); toast(id ? 'Saved' : 'Added'); loadInventory();
  } catch (e) { toast(e.message || 'Failed', 'err'); }
}

async function deleteInvItem(id) {
  if (!confirm('Delete this item and its history?')) return;
  try { await API.delete(`/inventory/${id}`); toast('Deleted'); loadInventory(); }
  catch (e) { toast(e.message || 'Failed', 'err'); }
}

async function openInvHistory(id) {
  const it = _invItem(id);
  showModal('inv-hist-modal', `<h3 style="margin:0 0 12px">History — ${escapeHtml(it.name || '')}</h3><div id="inv-hist-body">${LOADING_HTML}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btn-ghost" onclick="closeModal('inv-hist-modal')">Close</button></div>`);
  let d;
  try { d = await API.get(`/inventory/${id}/movements`); } catch (e) { document.getElementById('inv-hist-body').innerHTML = `<div class="rep-empty">${escapeHtml(e.message)}</div>`; return; }
  const rows = d.movements || [];
  document.getElementById('inv-hist-body').innerHTML = rows.length ? `<div class="cc"><div class="listcard">
    <div class="lrow" style="background:var(--card-alt);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);font-weight:600">
      <span style="width:70px">Change</span>
      <span style="flex:1;min-width:120px">Note</span>
      <span style="width:120px">By</span>
      <span style="width:150px">When</span>
    </div>
    ${rows.map(m => `<div class="lrow" style="flex-wrap:wrap">
      <span style="width:70px;font-weight:700;color:${m.delta < 0 ? 'var(--danger-ink,#e25555)' : '#00A87D'}">${m.delta > 0 ? '+' : ''}${m.delta}</span>
      <span style="flex:1;min-width:120px">${escapeHtml(m.reason || '—')}</span>
      <span style="width:120px">${escapeHtml(m.by_name || '')}</span>
      <span style="width:150px">${m.created_at ? new Date(m.created_at).toLocaleString('en-GB') : ''}</span>
    </div>`).join('')}</div></div>`
    : `<div class="rep-empty">No movements yet.</div>`;
}
