// ── Shared helpers ────────────────────────────────────────────────────────────
function escapeHtml(s) { return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// Animated success checkmark overlay. Auto-dismisses after ~1.4s.
function showSuccess(msg = 'Done') {
  const ov = document.getElementById('success-overlay');
  if (!ov) return;
  document.getElementById('success-msg').textContent = msg;
  ov.classList.remove('out');
  // restart the SVG animations by reflowing
  ov.querySelectorAll('.success-circle, .success-path, .success-card, .success-msg').forEach(el => {
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  });
  ov.classList.add('show');
  clearTimeout(ov._t);
  ov._t = setTimeout(() => {
    ov.classList.add('out');
    setTimeout(() => { ov.classList.remove('show', 'out'); }, 300);
  }, 1400);
}

// Count a number up from 0 to target inside an element (for KPIs).
function countUp(el, target, dur = 700) {
  if (!el) return;
  const start = performance.now();
  const from = 0;
  function tick(now) {
    const p = Math.min((now - start) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    el.textContent = Math.round(from + (target - from) * eased);
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = target;
  }
  requestAnimationFrame(tick);
}

// ── Toast ────────────────────────────────────────────────────────────────────
let _toastTimer;
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show toast-${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

// ── Loader ───────────────────────────────────────────────────────────────────
let _loaderMsgTimer;
function showLoader(label = 'Loading…') {
  // Don't stack the page loader on top of the welcome splash.
  const splash = document.getElementById('welcome-splash');
  if (splash && splash.style.display !== 'none' && !splash.classList.contains('done')) return;
  const el = document.getElementById('page-loader');
  document.getElementById('loader-label').textContent = label;
  el.classList.add('show');
}
function hideLoader() {
  clearInterval(_loaderMsgTimer);
  document.getElementById('page-loader').classList.remove('show');
}
// Loader variant that cycles through several messages (for long waits like Generate)
function showLoaderCycling(messages = ['Working…'], intervalMs = 1400) {
  const el = document.getElementById('page-loader');
  const labelEl = document.getElementById('loader-label');
  let i = 0;
  labelEl.textContent = messages[0];
  el.classList.add('show');
  clearInterval(_loaderMsgTimer);
  _loaderMsgTimer = setInterval(() => {
    i = (i + 1) % messages.length;
    labelEl.style.animation = 'none'; void labelEl.offsetWidth;
    labelEl.style.animation = 'loaderMsgFade .5s ease';
    labelEl.textContent = messages[i];
  }, intervalMs);
}

// ── Welcome splash ───────────────────────────────────────────────────────────
// Shows a branded greeting with the user's name and cycling status messages
// while the app loads its first data. Resolves (fades out) when told to.
function showWelcomeSplash(name) {
  const splash = document.getElementById('welcome-splash');
  const nameEl = document.getElementById('wsplash-name');
  const statusEl = document.getElementById('wsplash-status');
  if (!splash) return;

  // First name only, capitalised
  const first = (name || 'there').trim().split(/\s+/)[0];
  nameEl.textContent = first.charAt(0).toUpperCase() + first.slice(1);

  const messages = [
    'Signing you in…',
    'Loading your schedule…',
    'Fetching staff & shifts…',
    'Almost ready…',
  ];
  splash.style.display = 'flex';
  splash.classList.remove('done');
  let i = 0;
  statusEl.textContent = messages[0];
  splash._timer = setInterval(() => {
    i = (i + 1) % messages.length;
    statusEl.style.animation = 'none'; void statusEl.offsetWidth;
    statusEl.style.animation = 'wsplashStatusCycle .5s ease';
    statusEl.textContent = messages[i];
  }, 1100);
}
function hideWelcomeSplash() {
  const splash = document.getElementById('welcome-splash');
  if (!splash) return;
  clearInterval(splash._timer);
  splash.classList.add('done');
  setTimeout(() => { splash.style.display = 'none'; }, 600);
}

// ── Confirm dialog ────────────────────────────────────────────────────────────
let _confirmResolve;
function confirmResolve(val) {
  document.getElementById('confirm-overlay').classList.remove('open');
  if (_confirmResolve) _confirmResolve(val);
}
function showConfirm(title, body, okLabel = 'Delete', okClass = 'confirm-ok') {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').textContent  = body;
  document.getElementById('confirm-ok').textContent    = okLabel;
  document.getElementById('confirm-overlay').classList.add('open');
  return new Promise(r => { _confirmResolve = r; });
}

// ── Theme ────────────────────────────────────────────────────────────────────
function initTheme() {
  if (localStorage.getItem('theme') === 'dark') applyDark();
}
function applyDark() {
  document.body.classList.add('dark');
  document.getElementById('theme-icon').textContent = '☀️';
  document.getElementById('theme-label').textContent = 'Light Mode';
}
function applyLight() {
  document.body.classList.remove('dark');
  document.getElementById('theme-icon').textContent = '🌙';
  document.getElementById('theme-label').textContent = 'Dark Mode';
}
function toggleTheme() {
  if (document.body.classList.contains('dark')) {
    applyLight(); localStorage.setItem('theme', 'light');
  } else {
    applyDark(); localStorage.setItem('theme', 'dark');
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const btn = document.getElementById('sidebar-toggle');
  sb.classList.toggle('collapsed');
  btn.innerHTML = sb.classList.contains('collapsed') ? '&#10095;' : '&#10094;';
}

// ── Date helpers ──────────────────────────────────────────────────────────────
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }
function dayOfWeek(year, month, day) { return new Date(year, month - 1, day).getDay(); }
function fmtDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function monthLabel(year, month) { return `${MONTHS[month-1]} ${year}`; }

// ── Topbar ────────────────────────────────────────────────────────────────────
function setTopbar(title, meta = '', actionsHtml = '') {
  document.getElementById('topbar-title').textContent = title;
  document.getElementById('topbar-meta').textContent  = meta;
  document.getElementById('topbar-actions').innerHTML = actionsHtml;
}

// ── Populate select ───────────────────────────────────────────────────────────
function populateSelect(selectId, items, valueKey, labelKey, placeholder = '') {
  const el = document.getElementById(selectId);
  el.innerHTML = placeholder ? `<option value="">${placeholder}</option>` : '';
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item[valueKey];
    opt.textContent = item[labelKey];
    el.appendChild(opt);
  });
}

// ── Time formatting ───────────────────────────────────────────────────────────
// Convert "HH:MM" 24h → "H:MM AM/PM"
function fmt12(t) {
  if (!t) return '—';
  const [h, m] = t.split(':').map(Number);
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12  = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ampm}` : `${h12}:00 ${ampm}`;
}
// Format a shift's time range: "8:00 AM - 8:00 PM"
function fmtTimeRange(start, end) {
  if (!start || !end) return '—';
  return `${fmt12(start)} - ${fmt12(end)}`;
}

// ── Colour brightness ─────────────────────────────────────────────────────────
function contrastColor(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return (r*299 + g*587 + b*114) / 1000 > 128 ? '#2B2458' : '#ffffff';
}
