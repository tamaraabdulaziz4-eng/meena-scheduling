/**
 * Nest Config admin page — view and edit nest/section configuration.
 * Superadmin only.
 */

// ── State ─────────────────────────────────────────────────────────────────────
let nestConfigData = {};   // { NEST1: [...sections], NEST2: [...], ... }
let branchSettingsCache = {};  // branch_id → { max_consecutive, min_shifts_default }

// ── Page render ───────────────────────────────────────────────────────────────

async function renderNestConfigPage() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <div>
        <h2 style="margin:0;font-size:20px">Nest Configuration</h2>
        <p style="margin:4px 0 0;color:var(--muted);font-size:13px">
          Edit solver settings per nest and section. Changes take effect on the next schedule generation.
        </p>
      </div>
      <button class="btn btn-sm" onclick="openNestSectionModal()">+ Add Section</button>
    </div>
    <div id="nest-config-list">
      <div style="color:var(--muted);text-align:center;padding:40px">Loading…</div>
    </div>
  `;

  try {
    const data = await API.get('/nest-config');
    nestConfigData = data.nests || {};
    // Load branch settings for each branch
    branchSettingsCache = {};
    for (const b of (allBranches || [])) {
      try {
        const s = await API.get(`/branch-settings/${b.id}`);
        branchSettingsCache[b.id] = s;
      } catch(e) { branchSettingsCache[b.id] = { max_consecutive: 5, min_shifts_default: 17 }; }
    }
    renderNestConfigList();
  } catch (err) {
    document.getElementById('nest-config-list').innerHTML =
      `<div class="msg err">${err.message}</div>`;
  }
}

function renderNestConfigList() {
  const el = document.getElementById('nest-config-list');
  const nestKeys = Object.keys(nestConfigData).sort();

  if (!nestKeys.length) {
    el.innerHTML = `<div style="color:var(--muted);text-align:center;padding:40px">No nest configs found. Add a section to get started.</div>`;
    return;
  }

  el.innerHTML = nestKeys.map(nestKey => {
    const sections = nestConfigData[nestKey] || [];
    // Find branch_id for this nest
    const nestToBranch = {'NEST1':1,'NEST2':2,'NEST3':3,'NEST4':4,'NEST6':5,'Y5':6};
    const bid = nestToBranch[nestKey];
    const settings = branchSettingsCache[bid] || { max_consecutive: 5, min_shifts_default: 17 };
    return `
      <div class="nest-block" style="margin-bottom:28px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <h3 style="margin:0;font-size:16px;color:var(--accent)">${nestKey}</h3>
          <button class="btn btn-sm" style="font-size:11px;padding:4px 10px"
            onclick="openNestSectionModal(null, '${nestKey}')">+ Add Section</button>
        </div>

        <div class="card" style="padding:12px 16px;margin-bottom:10px;border-radius:10px;background:var(--surface);border:1px solid var(--border);display:flex;align-items:center;gap:16px;flex-wrap:wrap">
          <span style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">⚙️ Solver Settings</span>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px">
            Max consecutive working days:
            <input type="number" min="1" max="14" value="${settings.max_consecutive}"
              id="max-consec-${nestKey}"
              style="width:60px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:var(--text);font-size:13px">
            <button class="btn btn-sm" style="padding:4px 12px;font-size:12px"
              onclick="saveMaxConsecutive('${nestKey}', ${bid})">Save</button>
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px">
            Min shifts / staff / month:
            <input type="number" min="0" max="31" value="${settings.min_shifts_default ?? 17}"
              id="min-shifts-${nestKey}"
              style="width:60px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:var(--text);font-size:13px">
            <button class="btn btn-sm" style="padding:4px 12px;font-size:12px"
              onclick="saveMinShiftsDefault('${nestKey}', ${bid})">Save</button>
          </label>
        </div>

        <div style="display:flex;flex-direction:column;gap:10px">
          ${sections.map(sec => renderSectionCard(sec)).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function renderSectionCard(sec) {
  const dbNames = sec.staff_db_names || {};
  const staffList = (sec.staff || []).map(key => {
    const dbName = dbNames[key] || '';
    return `<span style="display:inline-block;background:var(--surface2,rgba(107,78,255,0.1));border-radius:6px;padding:2px 8px;font-size:12px;margin:2px">${key}${dbName ? ` <span style="color:var(--muted)">(${dbName})</span>` : ''}</span>`;
  }).join('');

  return `
    <div class="card" style="padding:16px;border-radius:10px;background:var(--surface);border:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div>
          <strong style="font-size:15px">${sec.section_name}</strong>
          <span style="color:var(--muted);font-size:12px;margin-left:8px">sort: ${sec.sort_order}</span>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" style="font-size:12px"
            onclick="openNestSectionModal(${sec.id})">✏️ Edit</button>
          <button class="btn btn-ghost btn-sm" style="font-size:12px;color:#cc4444"
            onclick="deleteNestSection(${sec.id}, '${sec.nest_key}', '${sec.section_name}')">🗑</button>
        </div>
      </div>

      <div style="margin-bottom:8px">
        <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Staff (${sec.staff.length})</div>
        <div>${staffList || '<span style="color:var(--muted);font-size:12px">—</span>'}</div>
      </div>

      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px">
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Allowed Shifts</div>
          <code style="font-size:12px">${(sec.allowed_shifts || []).join(', ')}</code>
        </div>
      </div>
    </div>
  `;
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function openNestSectionModal(id = null, nestKeyDefault = '') {
  const modal = document.getElementById('nest-section-modal-overlay');
  const title = document.getElementById('nest-section-modal-title');
  document.getElementById('ns-msg').textContent = '';

  if (id) {
    // Find the section across all nests
    let found = null;
    for (const sections of Object.values(nestConfigData)) {
      found = sections.find(s => s.id === id);
      if (found) break;
    }
    if (!found) { toast('Section not found'); return; }

    title.textContent = `Edit ${found.nest_key} / ${found.section_name}`;
    document.getElementById('ns-edit-id').value       = found.id;
    document.getElementById('ns-nest-key').value      = found.nest_key;
    document.getElementById('ns-section-name').value  = found.section_name;
    document.getElementById('ns-sort-order').value    = found.sort_order ?? 0;
    document.getElementById('ns-staff').value         = (found.staff || []).join('\n');
    document.getElementById('ns-allowed-shifts').value = (found.allowed_shifts || []).join(',');

    // DB names: SOLVER_KEY = DB Name, one per line
    const dbNames = found.staff_db_names || {};
    document.getElementById('ns-db-names').value =
      Object.entries(dbNames).map(([k,v]) => `${k} = ${v}`).join('\n');
  } else {
    title.textContent = 'Add Section';
    document.getElementById('ns-edit-id').value       = '';
    document.getElementById('ns-nest-key').value      = nestKeyDefault;
    document.getElementById('ns-section-name').value  = '';
    document.getElementById('ns-sort-order').value    = '0';
    document.getElementById('ns-staff').value         = '';
    document.getElementById('ns-db-names').value      = '';
    document.getElementById('ns-allowed-shifts').value = 'M,N,O,AL,SL';
  }

  modal.style.display = 'flex';
}

function closeNestSectionModal() {
  document.getElementById('nest-section-modal-overlay').style.display = 'none';
}

async function saveNestSection() {
  const msg      = document.getElementById('ns-msg');
  const nestKey  = document.getElementById('ns-nest-key').value.trim().toUpperCase();
  const secName  = document.getElementById('ns-section-name').value.trim();

  if (!nestKey || !secName) {
    msg.className = 'msg err'; msg.textContent = 'Nest key and section name are required.'; return;
  }

  // Parse staff (one per line)
  const staff = document.getElementById('ns-staff').value
    .split('\n').map(s => s.trim().toUpperCase()).filter(Boolean);

  // Parse db names (KEY = Value, one per line)
  const staff_db_names = {};
  for (const line of document.getElementById('ns-db-names').value.split('\n')) {
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toUpperCase();
    const val = line.slice(idx + 1).trim();
    if (key && val) staff_db_names[key] = val;
  }

  // Parse allowed shifts
  const allowed_shifts = document.getElementById('ns-allowed-shifts').value
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

  const sort_order = Number(document.getElementById('ns-sort-order').value) || 0;

  msg.className = 'msg'; msg.textContent = 'Saving…';

  try {
    await API.put(`/nest-config/${nestKey}/${encodeURIComponent(secName)}`, {
      staff,
      staff_db_names,
      allowed_shifts,
      sort_order,
    });

    toast(`${nestKey} / ${secName} saved`);
    closeNestSectionModal();

    // Reload
    const data = await API.get('/nest-config');
    nestConfigData = data.nests || {};
    renderNestConfigList();
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = err.message;
  }
}

async function saveMaxConsecutive(nestKey, branchId) {
  const val = parseInt(document.getElementById(`max-consec-${nestKey}`).value);
  if (!val || val < 1 || val > 14) { toast('Enter a value between 1 and 14', 'err'); return; }
  try {
    await API.put(`/branch-settings/${branchId}`, { max_consecutive: val });
    branchSettingsCache[branchId] = { ...(branchSettingsCache[branchId] || {}), max_consecutive: val };
    toast(`${nestKey} max consecutive days set to ${val}`);
  } catch (err) { toast(err.message, 'err'); }
}

async function saveMinShiftsDefault(nestKey, branchId) {
  const val = parseInt(document.getElementById(`min-shifts-${nestKey}`).value);
  if (val < 0 || val > 31) { toast('Enter a value between 0 and 31', 'err'); return; }
  try {
    await API.put(`/branch-settings/${branchId}`, { min_shifts_default: val });
    branchSettingsCache[branchId] = { ...(branchSettingsCache[branchId] || {}), min_shifts_default: val };
    toast(`${nestKey} min shifts default set to ${val}`);
  } catch (err) { toast(err.message, 'err'); }
}

async function deleteNestSection(id, nestKey, secName) {
  const ok = await showConfirm('Delete Section', `Delete ${nestKey} / ${secName}? This cannot be undone.`, 'Delete');
  if (!ok) return;

  try {
    await API.delete(`/nest-config/${id}`);
    toast(`${nestKey} / ${secName} deleted`);

    const data = await API.get('/nest-config');
    nestConfigData = data.nests || {};
    renderNestConfigList();
  } catch (err) {
    toast(err.message, 'err');
  }
}
