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
// Navigation has its own feedback (skeleton + page reveal) and never calls these.
// showLoader/hideLoader are for explicit ACTIONS (save, delete, approve…): a
// small, tasteful centred spinner — not the progress bar, not the full splash.
let _loaderMsgTimer, _loaderHideTimer, _busyDepth = 0;
function _busyEl() {
  let el = document.getElementById('busy-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'busy-overlay';
    el.innerHTML = '<div class="busy-card"><div class="busy-spin"></div><div class="busy-label"></div></div>';
    document.body.appendChild(el);
  }
  return el;
}
function showLoader(label = 'Working…') {
  const el = _busyEl();
  el.querySelector('.busy-label').textContent = label;
  _busyDepth++;
  el.classList.add('show');
}
function hideLoader() {
  clearInterval(_loaderMsgTimer);
  _busyDepth = Math.max(0, _busyDepth - 1);
  if (_busyDepth === 0) {
    const el = document.getElementById('busy-overlay');
    if (el) el.classList.remove('show');
  }
  // If a heavy op (Generate) put up the full-screen loader, dismiss it too.
  const pl = document.getElementById('page-loader');
  if (pl && pl.classList.contains('show')) {
    pl.classList.add('fading');
    clearTimeout(_loaderHideTimer);
    _loaderHideTimer = setTimeout(() => { pl.classList.remove('show', 'fading'); }, 300);
  }
}
// Kept as no-ops so existing call sites stay valid (the bar was removed).
function startTopBar() {}
function stopTopBar() {}

// Animated inline loading state (no static hourglass).
const LOADING_HTML = '<div class="loading-inline"><span class="mini-spin"></span><span>Loading…</span></div>';

// Replay a soft fade+rise on any element (used when a grid/list re-renders, e.g.
// changing month) so content never just snaps in.
function animateIn(elOrId) {
  const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  if (!el) return;
  el.classList.remove('anim-in'); void el.offsetWidth; el.classList.add('anim-in');
}

// Cascade a table's rows in. Table pages render a single wrapper, so the page
// reveal alone is nearly invisible — this gives them a clear, staggered
// entrance. Force a reflow so the animation replays on every navigation.
function revealTable(elOrId) {
  const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  if (!el) return;
  el.classList.remove('table-reveal'); void el.offsetWidth; el.classList.add('table-reveal');
}

// ── Premium page reveal ───────────────────────────────────────────────────────
// An elegant motion when a new page lands: the panel clears from a soft blur as
// its showcase cards rise and fade in, lightly staggered. Restarts each
// navigation; the class is dropped once done so in-page refreshes (e.g. the
// live cases page) don't re-trigger it.
let _revealTimer;
function playPageReveal() {
  const content = document.getElementById('content');
  if (!content) return;
  content.classList.remove('page-reveal');
  void content.offsetWidth;            // force reflow so the animation replays
  content.classList.add('page-reveal');
  clearTimeout(_revealTimer);
  _revealTimer = setTimeout(() => content.classList.remove('page-reveal'), 900);
}

// A shimmer skeleton shown only while a slow page is still fetching, so a
// navigation feels instant instead of freezing on the old page.
const PAGE_SKELETON = `
  <div class="skel-wrap">
    <div class="skel skel-line lg"></div>
    <div class="skel-grid">
      <div class="skel skel-card"></div><div class="skel skel-card"></div>
      <div class="skel skel-card"></div><div class="skel skel-card"></div>
    </div>
    <div class="skel skel-block"></div>
  </div>`;
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

// Destructive confirm that makes you TYPE an exact word (e.g. the branch name)
// before the action unlocks — guards irreversible, cascading deletes.
function showTypedConfirm(title, body, requiredText, okLabel = 'Delete') {
  const bodyEl = document.getElementById('confirm-body');
  const okBtn  = document.getElementById('confirm-ok');
  document.getElementById('confirm-title').textContent = title;
  bodyEl.innerHTML = `<div style="margin-bottom:10px">${escapeHtml(body)}</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Type <b>${escapeHtml(requiredText)}</b> to confirm:</div>
    <input id="confirm-typed-input" type="text" autocomplete="off"
      style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px" placeholder="${escapeHtml(requiredText)}">`;
  okBtn.textContent = okLabel;
  okBtn.disabled = true;
  okBtn.style.opacity = '0.5';
  const input = document.getElementById('confirm-typed-input');
  input.addEventListener('input', () => {
    const ok = input.value.trim() === requiredText;
    okBtn.disabled = !ok;
    okBtn.style.opacity = ok ? '1' : '0.5';
  });
  document.getElementById('confirm-overlay').classList.add('open');
  setTimeout(() => input.focus(), 60);
  return new Promise(r => {
    _confirmResolve = (val) => {
      // Restore the shared dialog so the next plain confirm isn't left disabled.
      okBtn.disabled = false; okBtn.style.opacity = '1';
      r(val);
    };
  });
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
function _isMobile() { return window.matchMedia('(max-width: 820px)').matches; }

function _sidebarBackdrop() {
  let el = document.getElementById('sidebar-backdrop');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sidebar-backdrop';
    el.onclick = closeSidebarMobile;
    document.body.appendChild(el);
  }
  return el;
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const btn = document.getElementById('sidebar-toggle');
  if (_isMobile()) {
    // Off-canvas drawer: slide in over the content with a tap-to-close backdrop.
    const open = sb.classList.toggle('mobile-open');
    _sidebarBackdrop().classList.toggle('show', open);
    document.body.classList.toggle('drawer-open', open);
  } else {
    sb.classList.toggle('collapsed');
    if (btn) btn.innerHTML = sb.classList.contains('collapsed') ? '&#10095;' : '&#10094;';
  }
}

function closeSidebarMobile() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  sb.classList.remove('mobile-open');
  const bd = document.getElementById('sidebar-backdrop');
  if (bd) bd.classList.remove('show');
  document.body.classList.remove('drawer-open');
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

// Splash-style page hero (lavender gradient, floating orbs, white logo chip,
// gradient headline). Prepended to a page's content so every screen shares the
// welcome-splash identity. `eyebrow`/`title` are escaped; `sub` may carry HTML.
function pageHero(eyebrow, title, sub = '') {
  return `
    <div class="phero no-print">
      <div class="phero-orb p1"></div><div class="phero-orb p2"></div>
      <div class="phero-inner">
        <div class="phero-logo"><img src="/meena_logo.png" alt="Meena"></div>
        <div class="phero-text">
          <div class="phero-hi">${escapeHtml(eyebrow || '')}</div>
          <div class="phero-title">${escapeHtml(title || '')}</div>
          ${sub ? `<div class="phero-sub" id="phero-sub">${sub}</div>` : ''}
        </div>
      </div>
    </div>`;
}

// ── Branded PDF report canvas ─────────────────────────────────────────────────
// Builds the polished "dashboard report" look (logo chip + title) shared by the
// Daily Cases and Schedule PDF exports. openReport() drops the built markup into
// #report-root, flips the body into report-print mode, prints, then restores.
function reportHeader(title, sub) {
  return `
    <div class="rep-head">
      <div class="rep-logo"><img src="/meena_logo.png" alt="Meena"></div>
      <div class="rep-head-text">
        <div class="rep-title">${escapeHtml(title)}</div>
        <div class="rep-sub">${escapeHtml(sub || '')}</div>
      </div>
    </div>`;
}
function openReport(innerHtml, landscape = false) {
  const root = document.getElementById('report-root');
  if (!root) return;
  root.innerHTML = innerHtml;
  document.body.classList.add('mode-report');
  document.body.classList.toggle('mode-report-ls', !!landscape);
  const restore = () => {
    document.body.classList.remove('mode-report', 'mode-report-ls');
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  setTimeout(() => window.print(), 80);   // let layout settle first
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
