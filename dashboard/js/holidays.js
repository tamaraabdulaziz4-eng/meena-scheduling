// ── Public holidays ───────────────────────────────────────────────────────────
// `holidayMap` maps 'YYYY-MM-DD' → holiday name, consumed by the rota grid to
// flag non-working days. Hijri dates are rendered straight from Intl (util.js).
let holidayMap = {};
let _holidayList = [];

async function loadHolidaysForMonth(year, month) {
  try {
    const rows = await API.get(`/holidays?year=${year}&month=${month}`);
    holidayMap = {};
    rows.forEach(h => { holidayMap[h.date] = h.name; });
    return rows;
  } catch (e) { holidayMap = {}; return []; }
}

// ── Management modal (superadmin) ─────────────────────────────────────────────
async function openHolidaysModal() {
  document.getElementById('holiday-msg').textContent = '';
  document.getElementById('holiday-date').value = '';
  document.getElementById('holiday-name').value = '';
  document.getElementById('cutoff-msg').textContent = '';
  const ci = document.getElementById('leave-cutoff-input');
  if (ci) ci.value = (typeof leaveCutoffDay !== 'undefined' ? leaveCutoffDay : 15);
  document.getElementById('holidays-modal-overlay').classList.add('open');
  loadEmailConfig();
  await reloadHolidayList();
}

async function loadEmailConfig() {
  const info = document.getElementById('email-config-info');
  if (!info) return;
  try {
    const c = await API.get('/email-config');
    if (c.provider === 'none') {
      info.innerHTML = `⚠️ <b>No provider configured.</b> Set <code>RESEND_API_KEY</code> in your environment.`;
    } else {
      const warn = c.app_url_set ? '' : ' · ⚠️ APP_URL not set (logo/button hidden)';
      info.innerHTML = `Provider: <b>${c.provider}</b> · From: <b>${escapeHtml(c.from)}</b>${warn}`;
    }
    const t = document.getElementById('email-test-to');
    if (t && !t.value && currentUser?.email) t.value = currentUser.email;
  } catch (e) { info.textContent = ''; }
}

async function sendTestEmail() {
  const msg = document.getElementById('email-test-msg');
  const to  = document.getElementById('email-test-to').value.trim();
  msg.className = 'msg'; msg.textContent = 'Sending…';
  try {
    const r = await API.post('/email-test', to ? { to } : {});
    msg.className = 'msg'; msg.style.color = 'var(--green)';
    msg.textContent = `✅ Sent to ${r.sent_to} (from ${r.from}). Check the inbox/spam.`;
  } catch (e) {
    msg.className = 'msg err'; msg.style.color = '';
    msg.textContent = e.message;   // shows the real Resend error (e.g. domain not verified)
  }
}

async function saveLeaveCutoff() {
  const msg = document.getElementById('cutoff-msg');
  const v = parseInt(document.getElementById('leave-cutoff-input').value, 10);
  if (!(v >= 1 && v <= 28)) { msg.className = 'msg err'; msg.textContent = 'Day must be between 1 and 28'; return; }
  try {
    const r = await API.put('/settings', { leave_cutoff_day: v });
    leaveCutoffDay = r.leave_cutoff_day;
    msg.className = 'msg'; msg.textContent = '';
    toast(`Leave cutoff set to day ${leaveCutoffDay}`);
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
}

function closeHolidaysModal() {
  document.getElementById('holidays-modal-overlay').classList.remove('open');
}

async function reloadHolidayList() {
  const year = new Date().getFullYear();
  try {
    _holidayList = await API.get(`/holidays?year=${year}`);
  } catch (e) { _holidayList = []; }
  renderHolidayList();
}

function renderHolidayList() {
  const box = document.getElementById('holiday-list');
  if (!box) return;
  if (!_holidayList.length) {
    box.innerHTML = `<div style="padding:16px;text-align:center;color:var(--muted);font-size:13px">No holidays this year</div>`;
    return;
  }
  box.innerHTML = _holidayList.map(h => {
    const d = new Date(h.date);
    const greg = d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric', timeZone:'UTC' });
    const hij  = hijriFull(d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDate());
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border)">
      <div style="flex:1">
        <div style="font-weight:600;font-size:13px">${escapeHtml(h.name)}</div>
        <div style="font-size:11px;color:var(--muted)">${greg}${hij ? ' · ' + hij : ''}</div>
      </div>
      <button class="action-btn danger" onclick="deleteHoliday(${h.id})">Delete</button>
    </div>`;
  }).join('');
}

async function saveHoliday() {
  const msg  = document.getElementById('holiday-msg');
  const date = document.getElementById('holiday-date').value;
  const name = document.getElementById('holiday-name').value.trim();
  if (!date || !name) { msg.className='msg err'; msg.textContent='Date and name are required'; return; }
  msg.className='msg'; msg.textContent='';
  try {
    await API.post('/holidays', { date, name });
    document.getElementById('holiday-date').value = '';
    document.getElementById('holiday-name').value = '';
    await reloadHolidayList();
    toast('Holiday added');
  } catch (e) { msg.className='msg err'; msg.textContent = e.message; }
}

async function deleteHoliday(id) {
  const ok = await showConfirm('Delete Holiday', 'Remove this public holiday?');
  if (!ok) return;
  try {
    await API.delete(`/holidays/${id}`);
    await reloadHolidayList();
    toast('Holiday removed');
  } catch (e) { toast(e.message, 'err'); }
}
