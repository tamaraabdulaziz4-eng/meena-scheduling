// ── Shift Types page ──────────────────────────────────────────────────────────
let allShiftTypes    = [];   // global shift types (used by schedule grid)
let allShiftTypesRaw = [];   // same as allShiftTypes (kept for compatibility)

// Used by schedule.js — loads global shift types
async function loadShiftTypes(branchId) {
  allShiftTypes = await API.get('/shift-types');
  return allShiftTypes;
}

// Used by settings page — loads every row (global)
async function loadAllShiftTypesRaw() {
  allShiftTypesRaw = await API.get('/shift-types/all');
}

function renderShiftsPage() {
  const canEdit = ['admin', 'superadmin'].includes(currentUser?.role);

  setTopbar('Shift Types', `Global shift list (all branches)`,
    canEdit ? `<button class="btn btn-sm" onclick="openShiftModal()">+ Add Shift</button>` : ''
  );

  const c = document.getElementById('content');
  c.innerHTML = `
    <div id="shift-tables-wrap"></div>`;

  renderShiftTable();
}

function renderShiftTable() {
  const wrap = document.getElementById('shift-tables-wrap');
  if (!wrap) return;
  const canEdit = ['admin', 'superadmin'].includes(currentUser?.role);
  const shifts = (allShiftTypesRaw || []).slice().sort((a, b) => (a.sort_order - b.sort_order) || a.code.localeCompare(b.code));

  const rowsHtml = shifts.map((st, idx) => {
    const hours = calcHours(st.start_time, st.end_time);
    const flags = [st.is_off && 'Off', st.is_leave && 'Leave', st.is_oncall && 'On-Call'].filter(Boolean).join(', ') || '—';

    let actions = '';
    if (canEdit) {
      actions = `<button class="action-btn" onclick="openShiftModal(${st.id})">Edit</button>`;
    }

    return `<tr>
      <td style="color:var(--muted);font-size:12px;text-align:center;width:36px">${idx + 1}</td>
      <td>
        <span style="display:inline-flex;padding:4px 12px;border-radius:6px;background:${st.color};color:${contrastColor(st.color)};font-weight:700;font-size:12px">${st.code}</span>
      </td>
      <td>${st.label}</td>
      <td>${fmt12(st.start_time)}</td>
      <td>${fmt12(st.end_time)}</td>
      <td>${hours}</td>
      <td><div style="width:24px;height:24px;border-radius:6px;background:${st.color};border:1px solid var(--border)"></div></td>
      <td><span style="font-size:11px;color:var(--muted)">${flags}</span></td>
      ${canEdit ? `<td>${actions}</td>` : ''}
    </tr>`;
  }).join('');

  const total = shifts.length;
  const workCount = shifts.filter(s => !s.is_off && !s.is_leave && !s.is_oncall).length;

  wrap.innerHTML = `
    <div style="margin-bottom:10px;font-size:13px;color:var(--muted)">
      <strong style="color:var(--text)">${total}</strong> shift types
      &nbsp;·&nbsp; <strong style="color:var(--text)">${workCount}</strong> work shifts
      &nbsp;·&nbsp; <strong style="color:var(--text)">${total - workCount}</strong> status codes
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th style="width:36px">#</th><th>Code</th><th>Label</th><th>Start</th><th>End</th><th>Hours</th><th>Colour</th><th>Type</th>
          ${canEdit ? '<th>Actions</th>' : ''}
        </tr></thead>
        <tbody>${rowsHtml || '<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:20px">No shifts</td></tr>'}</tbody>
      </table>
    </div>`;
}

function calcHours(start, end) {
  if (!start || !end) return '—';
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ── Modal ─────────────────────────────────────────────────────────────────────
let _editShiftId = null;

function openShiftModal(id) {
  _editShiftId = id || null;
  const st = id ? allShiftTypesRaw.find(x => x.id === id) : null;
  document.getElementById('shift-modal-title').textContent = id ? 'Edit Shift' : 'Add Shift';
  document.getElementById('shift-edit-id').value     = id || '';
  document.getElementById('shift-code').value        = st?.code || '';
  document.getElementById('shift-code').disabled     = !!id;
  document.getElementById('shift-label').value       = st?.label || '';
  document.getElementById('shift-start').value       = st?.start_time || '';
  document.getElementById('shift-end').value         = st?.end_time || '';
  document.getElementById('shift-color').value       = st?.color || '#6B4EFF';
  document.getElementById('shift-is-off').checked    = st?.is_off || false;
  document.getElementById('shift-is-leave').checked  = st?.is_leave || false;
  document.getElementById('shift-is-oncall').checked = st?.is_oncall || false;
  document.getElementById('shift-msg').textContent   = '';

  document.getElementById('shift-modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById(id ? 'shift-label' : 'shift-code').focus(), 50);
}

function closeShiftModal() {
  document.getElementById('shift-modal-overlay').classList.remove('open');
  document.getElementById('shift-code').disabled = false;
}

async function saveShiftType() {
  const msg = document.getElementById('shift-msg');
  const id  = document.getElementById('shift-edit-id').value;
  const body = {
    code:       document.getElementById('shift-code').value.trim().toUpperCase(),
    label:      document.getElementById('shift-label').value.trim(),
    start_time: document.getElementById('shift-start').value || null,
    end_time:   document.getElementById('shift-end').value || null,
    color:      document.getElementById('shift-color').value,
    is_off:     document.getElementById('shift-is-off').checked,
    is_leave:   document.getElementById('shift-is-leave').checked,
    is_oncall:  document.getElementById('shift-is-oncall').checked,
  };
  if (!body.code || !body.label) { msg.className = 'msg err'; msg.textContent = 'Code and label required'; return; }

  try {
    let st;
    if (id) {
      st = await API.put(`/shift-types/${id}`, body);
      const idx = allShiftTypesRaw.findIndex(x => x.id === Number(id));
      if (idx >= 0) allShiftTypesRaw[idx] = st;
    } else {
      st = await API.post('/shift-types', body);
      const idx = allShiftTypesRaw.findIndex(x => x.id === st.id);
      if (idx >= 0) allShiftTypesRaw[idx] = st; else allShiftTypesRaw.push(st);
    }
    closeShiftModal();
    renderShiftsPage();
    showSuccess('Shift saved');
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
}

async function deleteShiftConfirm(id, code) {
  const ok = await showConfirm('Reset Shift Times', `Reset "${code}" to default times?`);
  if (!ok) return;
  try {
    await API.delete(`/shift-types/${id}`);
    allShiftTypesRaw = allShiftTypesRaw.filter(s => s.id !== id);
    renderShiftsPage();
    toast(`${code} reset to default`);
  } catch (err) { toast(err.message, 'err'); }
}
