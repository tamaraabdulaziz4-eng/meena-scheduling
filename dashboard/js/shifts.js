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

// Shift types are global across every branch, so only a superadmin may change
// them (the API enforces the same — require_superadmin).
function canEditShifts() { return currentUser?.role === 'superadmin'; }

function renderShiftsPage() {
  setTopbar('Shift Types', `Global shift list (all branches)`,
    canEditShifts() ? `<button class="btn btn-sm" onclick="openShiftModal()">+ Add Shift</button>` : ''
  );

  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="cc">
    ${pageHero('Global shift list — all branches', 'Shift Types')}
    <div id="shift-tables-wrap"></div>
    </div>`;

  renderShiftTable();
}

function renderShiftTable() {
  const wrap = document.getElementById('shift-tables-wrap');
  if (!wrap) return;
  const canEdit = canEditShifts();
  const shifts = (allShiftTypesRaw || []).slice().sort((a, b) => (a.sort_order - b.sort_order) || a.code.localeCompare(b.code));

  const rowsHtml = shifts.map((st, idx) => {
    const hours = calcHours(st.start_time, st.end_time);
    const flags = [st.is_off && 'Off', st.is_leave && 'Leave', st.is_oncall && 'On-Call'].filter(Boolean);

    let actions = '';
    if (canEdit) {
      actions = `<button class="ghost" onclick="openShiftModal(${st.id})">Edit</button>`;
    }

    return `<div class="lrow">
      <div style="width:26px;text-align:center;color:var(--muted);font-size:12px;flex:none">${idx + 1}</div>
      <div style="flex:none">
        <span style="display:inline-flex;padding:4px 12px;border-radius:6px;background:${st.color};color:${contrastColor(st.color)};font-weight:700;font-size:12px">${st.code}</span>
      </div>
      <div style="flex:2;min-width:120px;font-weight:600">${st.label}</div>
      <div style="flex:2;min-width:140px;font-size:12px;color:var(--muted)">
        ${(st.start_time && st.end_time) ? `${fmt12(st.start_time)} – ${fmt12(st.end_time)} · ${hours}` : '—'}
      </div>
      <div style="flex:1;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${flags.length ? flags.map(f => `<span class="sc warn">${f}</span>`).join('') : '<span style="font-size:11px;color:var(--muted)">—</span>'}
      </div>
      <div style="width:24px;height:24px;border-radius:6px;background:${st.color};border:1px solid var(--border);flex:none" title="Shift colour"></div>
      ${canEdit ? `<div style="white-space:nowrap;flex:none">${actions}</div>` : ''}
    </div>`;
  }).join('');

  const total = shifts.length;
  const workCount = shifts.filter(s => !s.is_off && !s.is_leave && !s.is_oncall).length;

  wrap.innerHTML = `
    <div class="kpis">
      <div class="kpi a"><div class="kl"><span class="kd" style="background:var(--amber,#F59E0B)"></span>Shift types</div><div class="kv">${total}</div><div class="kt">global — all branches</div></div>
      <div class="kpi b"><div class="kl"><span class="kd" style="background:var(--blue,#3BA0FF)"></span>Work shifts</div><div class="kv">${workCount}</div><div class="kt">scheduled duty codes</div></div>
      <div class="kpi c"><div class="kl"><span class="kd" style="background:var(--green,#00C896)"></span>Status codes</div><div class="kv">${total - workCount}</div><div class="kt">off / leave / on-call</div></div>
    </div>
    <div class="listcard" id="shifts-wrap">
      ${rowsHtml || '<div style="text-align:center;color:var(--muted);padding:20px">No shifts</div>'}
    </div>`;
  animateIn('shifts-wrap');
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
  document.getElementById('shift-color').value       = st?.color || 'var(--accent,#6b4eff)';
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
