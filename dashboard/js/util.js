// ── Shared helpers ────────────────────────────────────────────────────────────
function escapeHtml(s) { return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// Animated success checkmark overlay. Auto-dismisses after ~1.6s.
function showSuccess(msg = 'Done') {
  const ov = document.getElementById('success-overlay');
  if (!ov) return;
  document.getElementById('success-msg').textContent = msg;
  clearTimeout(ov._t);
  ov.classList.remove('out');
  ov.classList.add('show');           // make it visible FIRST
  // Now that it's displayed, restart the SVG draw animations reliably.
  const anim = ov.querySelectorAll('.success-circle, .success-path, .success-msg');
  anim.forEach(el => { el.style.animation = 'none'; });
  void ov.offsetWidth;                // force reflow while visible
  anim.forEach(el => { el.style.animation = ''; });
  ov._t = setTimeout(() => {
    ov.classList.add('out');
    setTimeout(() => { ov.classList.remove('show', 'out'); }, 350);
  }, 1600);
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
let _loaderMsgTimer, _loaderHideTimer;
// While a page transition is running we suppress the full-screen splash and let
// the slim top progress bar carry the feedback — stops the two from fighting
// (the old "content dims → full overlay pops → dims again" jump).
let _navigating = false;
function showLoader(label = 'Loading…') {
  // Don't stack the page loader on top of the welcome splash.
  const splash = document.getElementById('welcome-splash');
  if (splash && splash.style.display !== 'none' && !splash.classList.contains('done')) return;
  if (_navigating) { startTopBar(); return; }   // routed to the top bar instead
  clearTimeout(_loaderHideTimer);               // cancel any pending hide (race fix)
  const el = document.getElementById('page-loader');
  document.getElementById('loader-label').textContent = label;
  el.classList.remove('fading');
  el.classList.add('show');
}
function hideLoader() {
  clearInterval(_loaderMsgTimer);
  if (_navigating) { stopTopBar(); return; }
  const el = document.getElementById('page-loader');
  if (!el) return;
  // Fade out smoothly, then hide. Keep the timer cancellable so a quick
  // show-right-after-hide doesn't get wiped by this stale callback.
  el.classList.add('fading');
  clearTimeout(_loaderHideTimer);
  _loaderHideTimer = setTimeout(() => { el.classList.remove('show', 'fading'); }, 300);
}

// ── Slim top progress bar ─────────────────────────────────────────────────────
// Lightweight navigation feedback (à la GitHub/YouTube) so switching pages feels
// responsive without a full-screen takeover.
let _topBarEl, _topBarTimer, _topBarDepth = 0;
function _ensureTopBar() {
  if (_topBarEl) return _topBarEl;
  _topBarEl = document.createElement('div');
  _topBarEl.id = 'topbar-progress';
  document.body.appendChild(_topBarEl);
  return _topBarEl;
}
function startTopBar() {
  // Stay quiet behind the login welcome splash (it already covers the screen).
  const splash = document.getElementById('welcome-splash');
  if (splash && splash.style.display !== 'none' && !splash.classList.contains('done')) return;
  const el = _ensureTopBar();
  _topBarDepth++;
  if (_topBarDepth > 1) return;        // already running — don't restart the bar
  clearTimeout(_topBarTimer);
  el.classList.remove('done');
  el.classList.add('show');
  // ease toward ~75% so it always feels like it's making progress
  el.style.width = '8%';
  requestAnimationFrame(() => { el.style.width = '75%'; });
}
function stopTopBar() {
  if (!_topBarEl) return;
  _topBarDepth = Math.max(0, _topBarDepth - 1);
  if (_topBarDepth > 0) return;        // still other work in flight
  const el = _topBarEl;
  el.style.width = '100%';
  el.classList.add('done');
  _topBarTimer = setTimeout(() => { el.classList.remove('show', 'done'); el.style.width = '0%'; }, 240);
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

// Org-wide leave-request cutoff (day of the prior month). Loaded at login.
let leaveCutoffDay = 15;
// Mirror of the backend rule: a request for month M must arrive on/before the
// cutoff day of the PREVIOUS month — so same-month and late next-month requests
// are both blocked. Returns { ok, msg }.
function leaveWindowOpen(targetDateStr, cutoffDay = leaveCutoffDay) {
  const [y, m] = String(targetDateStr).split('-').map(n => parseInt(n, 10));
  const today = new Date();
  const pmYear = m > 1 ? y : y - 1;
  const pmMonth = m > 1 ? m - 1 : 12;
  const deadline = new Date(pmYear, pmMonth - 1, Math.min(cutoffDay, 28));
  deadline.setHours(23, 59, 59, 999);
  if (today <= deadline) return { ok: true };
  const ds = `${pmYear}-${String(pmMonth).padStart(2,'0')}-${String(Math.min(cutoffDay,28)).padStart(2,'0')}`;
  return { ok: false, msg: `Leave requests for ${y}-${String(m).padStart(2,'0')} closed on ${ds} (must be requested before day ${cutoffDay} of the previous month).` };
}

// ── Hijri (Umm al-Qura) dates via the browser's Intl calendar ─────────────────
// No external library: modern browsers ship the islamic-umalqura calendar.
let _hijriDayFmt, _hijriFullFmt;
try {
  _hijriDayFmt  = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'short' });
  _hijriFullFmt = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' });
} catch (e) { _hijriDayFmt = _hijriFullFmt = null; }

// Short Hijri "DD Mon" for a Gregorian y/m/d (1-based month). '' if unsupported.
function hijriShort(year, month, day) {
  if (!_hijriDayFmt) return '';
  try { return _hijriDayFmt.format(new Date(year, month - 1, day)); }
  catch (e) { return ''; }
}
// Full Arabic Hijri date for tooltips/labels.
function hijriFull(year, month, day) {
  if (!_hijriFullFmt) return '';
  try { return _hijriFullFmt.format(new Date(year, month - 1, day)) + ' هـ'; }
  catch (e) { return ''; }
}

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
