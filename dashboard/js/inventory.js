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
    ${pageHero('Inventory', 'Inventory', 'Track consumables — staff log what they take, the lead is alerted at the reorder level')}
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      ${canPickBranch ? `<select id="inv-branch" class="rep-select" style="max-width:220px"></select>` : '<div></div>'}
      ${_invIsAdmin() ? `<button class="btn btn-sm btn-primary" onclick="openInvItemModal()">+ Add item</button>` : ''}
    </div>
    <div id="inv-list">${LOADING_HTML}</div>`;
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
    box.innerHTML = `<div class="rep-card"><div class="rep-empty">No stock items yet.${isAdmin ? ' Add one to start tracking.' : ''}</div></div>`;
    return;
  }
  box.innerHTML = `<div class="rep-card" style="padding:0;overflow:hidden"><div class="table-wrap" style="box-shadow:none;border:none;border-radius:0;background:transparent"><table>
    <thead><tr><th>Item</th><th style="min-width:160px">Stock</th><th>Remaining</th><th></th></tr></thead>
    <tbody>${_invItems.map(it => {
      const unit = it.unit ? ' ' + escapeHtml(it.unit) : '';
      const fill = Math.max(3, Math.min(100, it.pct));
      const bar = `<div class="rep-load"><div class="rep-load-track"><div class="rep-load-fill${it.low ? ' hot' : ''}" style="width:${fill}%"></div></div></div>`;
      const status = it.low
        ? `<span class="rep-pill rep-pill-red">Reorder</span>`
        : (it.pct <= 75 ? `<span class="rep-pill rep-pill-amber">${it.pct}%</span>` : `<span class="rep-pill rep-pill-ok">${it.pct}%</span>`);
      const adminBtns = isAdmin ? `
        <button class="btn btn-xs btn-ghost" onclick="openInvRestock(${it.id})">Restock</button>
        <button class="btn btn-xs btn-ghost" onclick="openInvHistory(${it.id})">History</button>
        <button class="btn btn-xs btn-ghost" onclick='openInvItemModal(${JSON.stringify(it).replace(/'/g, "&#39;")})'>Edit</button>
        <button class="btn btn-xs btn-ghost" style="color:#E25555" onclick="deleteInvItem(${it.id})">Delete</button>` : '';
      return `<tr>
        <td style="font-weight:600">${escapeHtml(it.name)}${it.unit ? ` <span style="font-size:11px;color:var(--muted)">(${escapeHtml(it.unit)})</span>` : ''}</td>
        <td>${bar}</td>
        <td><b style="color:${it.low ? '#E25555' : 'inherit'}">${it.qty}</b> / ${it.full_qty}${unit} &nbsp; ${status}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-xs btn-primary" onclick="openInvTake(${it.id})">Take</button>
          ${adminBtns}
        </td>
      </tr>`;
    }).join('')}</tbody></table></div></div>
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
  document.getElementById('inv-hist-body').innerHTML = rows.length ? `<div class="table-wrap" style="box-shadow:none;border:1px solid var(--border)"><table>
    <thead><tr><th>Change</th><th>Note</th><th>By</th><th>When</th></tr></thead>
    <tbody>${rows.map(m => `<tr>
      <td style="font-weight:700;color:${m.delta < 0 ? '#E25555' : '#00A87D'}">${m.delta > 0 ? '+' : ''}${m.delta}</td>
      <td>${escapeHtml(m.reason || '—')}</td><td>${escapeHtml(m.by_name || '')}</td>
      <td>${m.created_at ? new Date(m.created_at).toLocaleString('en-GB') : ''}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="rep-empty">No movements yet.</div>`;
}
