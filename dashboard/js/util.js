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
function showLoader(label = 'Loading…') {
  const el = document.getElementById('page-loader');
  document.getElementById('loader-label').textContent = label;
  el.classList.add('show');
}
function hideLoader() {
  document.getElementById('page-loader').classList.remove('show');
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
