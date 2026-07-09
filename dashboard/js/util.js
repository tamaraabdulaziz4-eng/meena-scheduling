// ── Shared helpers ────────────────────────────────────────────────────────────
function escapeHtml(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
// Management roles: team lead (admin), manager, and full admin (superadmin). Shared
// so the role gate isn't a bare literal repeated across ~20 sites.
const ADMIN_ROLES = ['admin', 'manager', 'superadmin'];
// Can the current user FILE a radiology result into the HIS? Team leads / managers /
// full admins always can; a plain staff member only if granted the per-user privilege.
function canFileRadiology() {
  if (typeof currentUser === 'undefined' || !currentUser) return false;
  if (ADMIN_ROLES.includes(currentUser.role)) return true;
  return currentUser.role === 'staff' && !!currentUser.can_file_radiology;
}

// ── Imaging modality vocab (shared by the worklist + orders board + rad stats) ──
// One map + renderer (was OD_MOD/odModBadges in orders and WL_MOD/wlModBadges in
// worklist). Superset of both: orders' MRI/DX/CR aliases + worklist's neutral
// fallback. Pass { fallbackCls } to style an unrecognised modality's badge.
const MOD = {
  CT:  { label: 'CT',    cls: 'ct'  },
  MR:  { label: 'MRI',   cls: 'mri' },
  MRI: { label: 'MRI',   cls: 'mri' },
  US:  { label: 'US',    cls: 'us'  },
  XR:  { label: 'X-Ray', cls: 'xr'  },
  DX:  { label: 'X-Ray', cls: 'xr'  },
  CR:  { label: 'X-Ray', cls: 'xr'  },
  MG:  { label: 'Mammo', cls: 'mm'  },
};
function modBadges(modality, { fallbackCls = '' } = {}) {
  if (!modality) return '';
  return String(modality).split(',').map((m) => {
    const k = m.trim().toUpperCase(), info = MOD[k];
    if (info) return `<span class="mod ${info.cls}">${escapeHtml(info.label)}</span>`;
    // HIS sends bone-density exams as a long free-text modality ("DEXA WHOLE BODY")
    // with no clean code, so it slips past the MOD map — normalise it to a tidy badge.
    if (/\bDEXA\b|\bDXA\b|\bBMD\b|BONE\s*DENSIT|DENSITOMET/.test(k)) return '<span class="mod bmd">BMD</span>';
    return `<span class="mod${fallbackCls ? ' ' + fallbackCls : ''}">${escapeHtml(k)}</span>`;
  }).join(' ');
}
// Modality → chart colour (shared by rad stats + rad report).
const MOD_COLOR = { CT: 'var(--accent,#6b4eff)', MRI: '#0ea5e9', 'X-Ray': '#22c55e', Ultrasound: '#f59e0b', Mammography: '#ec4899', 'DEXA / Bone Density': '#14b8a6', Fluoroscopy: '#8b5cf6', Other: '#94a3b8' };

// Female-gender detection — the SINGLE source of truth for radiation-safety gating
// (non-pregnancy consent + β-hCG), shared by the worklist and the patient card so the two
// screens can never disagree. Covers Latin ("F", "Female") and the Arabic spellings the HIS
// records: أنثى / انثى (female) and امرأة (woman).
function isFemaleGender(g) {
  const s = String(g == null ? '' : g).trim().toLowerCase();
  if (!s) return false;
  return s.startsWith('f') || s.includes('female') || /أنث|انث|امرأ/.test(s);
}

// ── Radiology study viewer ────────────────────────────────────────────────────
// Opens a modal with the radiology report TEXT + status + a button to the cloud
// image viewer — all live from Siratech (FetchRadiologyReport / FetchRadiologyImage
// / cpoeStatusDescription), no DePACS. Keyed by mrno + accession (+ optional exact
// per-exam invPatTestResultId). Shared by the Orders board and the worklist (was
// defined in orders.js as odOpenStudy and reached into cross-page).
async function openStudyViewer(btn, mrno, accession, invId) {
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '… loading'; }
  let d;
  try {
    const qs = new URLSearchParams({ mrno });
    if (invId) qs.set('invPatTestResultId', invId);   // exact per-exam key (preferred)
    if (accession) qs.set('accession', accession);
    d = await API.get('/radiology/study?' + qs.toString());
  } catch (e) { d = { ok: false, error: (e && e.message) || 'failed' }; }
  if (btn) { btn.disabled = false; btn.textContent = old; }
  showStudyModal(mrno, d || {});
}

function showStudyModal(mrno, d) {
  document.getElementById('od-study-modal')?.remove();
  const rep = (d.reportText || '').trim();
  const wrap = document.createElement('div');
  wrap.id = 'od-study-modal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  const statusPill = d.status ? `<span class="ris ${/scan done|complet|verif|report|final/i.test(d.status) ? 'final' : 'prelim'}"><span class="rd"></span>${escapeHtml(d.status)}</span>` : '';
  const imgBtn = d.imageUrl
    ? `<a class="btn btn-sm btn-primary" style="text-decoration:none" href="${escapeHtml(d.imageUrl)}" target="_blank" rel="noopener">🖼 Open images</a>`
    : `<span style="color:var(--muted);font-size:12px">No image link</span>`;
  const body = !d.ok
    ? `<div style="color:var(--danger,#E25555)">Couldn't load: ${escapeHtml(d.error || 'error')}</div>`
    : d.found === false
      ? `<div style="color:var(--muted)">No matching exam found in Siratech for this order.</div>`
      : `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
           ${statusPill}
           ${d.modality ? `<span class="mod">${escapeHtml(String(d.modality))}</span>` : ''}
           ${d.reportDate ? `<span style="color:var(--muted);font-size:12px">Reported ${escapeHtml(String(d.reportDate))}</span>` : ''}
           <span style="flex:1"></span>${imgBtn}
         </div>
         ${d.verifiedBy ? `<div style="font-size:12px;color:var(--muted);margin-bottom:6px">Verified by ${escapeHtml(d.verifiedBy)}</div>` : ''}
         ${rep
            ? `<pre style="white-space:pre-wrap;font-family:inherit;font-size:13.5px;line-height:1.6;background:var(--surface,#f7f7fb);border:1px solid var(--border,#e5e5ee);border-radius:10px;padding:12px;max-height:52vh;overflow:auto;margin:0">${escapeHtml(rep)}</pre>`
            : `<div style="color:var(--muted)">${d.hasReport ? 'Report is filed but has no readable text.' : 'No report yet — images may still be available above.'}</div>`}`;
  wrap.innerHTML = `<div class="card" style="max-width:760px;width:100%;max-height:86vh;overflow:auto;padding:16px 18px">
      <div style="display:flex;align-items:center;margin-bottom:10px">
        <div style="font-weight:700;font-size:15px">Radiology report${d.serviceName ? ' · ' + escapeHtml(String(d.serviceName)) : ''}
          <span style="color:var(--muted);font-weight:500;font-size:12.5px"> · ${escapeHtml(String(mrno))}</span></div>
        <span style="flex:1"></span>
        <button class="ghost" onclick="document.getElementById('od-study-modal').remove()">✕</button>
      </div>
      ${body}
      <div style="margin-top:8px;font-size:11px;color:var(--muted)">Live from Siratech · read-only</div>
    </div>`;
  document.body.appendChild(wrap);
}

// ── Inline line icons (Feather-style) ─────────────────────────────────────────
// Returns a self-contained inline SVG string for a named glyph so onclick /
// template strings can drop clean `currentColor` stroke icons in place of emoji.
// Feather geometry: 24x24 viewBox, no fill, 2px round strokes. Unknown → ''.
function icon(name) {
  const P = {
    search:        '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    printer:       '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    image:         '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    'file-text':   '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
    inbox:         '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    users:         '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    user:          '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    'id-card':     '<rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><line x1="12" y1="9" x2="18" y2="9"/><line x1="12" y1="13" x2="18" y2="13"/><circle cx="7.5" cy="10" r="2"/>',
    badge:         '<rect x="3" y="4" width="18" height="16" rx="2" ry="2"/><line x1="8" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/>',
    phone:         '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    mail:          '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    download:      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    info:          '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    alert:         '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    'bar-chart':   '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    lock:          '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    clock:         '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    camera:        '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    edit:          '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    droplet:       '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
    check:         '<polyline points="20 6 9 17 4 12"/>',
    x:             '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    'chevron-right':'<polyline points="9 18 15 12 9 6"/>',
    'chevron-down':'<polyline points="6 9 12 15 18 9"/>',
    calendar:      '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    refresh:       '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    clinic:        '<path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M12 8v6"/><path d="M9 11h6"/>',
  };
  const p = P[name];
  if (!p) return '';
  return `<svg class="mi-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

// For values dropped into a single-quoted onclick JS string: escape the JS
// string itself (backslash + quotes + the HTML), so a name like O'Brien is safe.
function jsAttr(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }

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
  // During the login welcome splash, don't stack the busy overlay on top of it
  // (the "Loading…" spinner appearing over the splash). Still track depth so the
  // paired hideLoader stays balanced.
  if (window._splashActive) { _busyDepth++; return; }
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
  window._splashActive = true;   // suppress the busy overlay while the splash is up
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
  window._splashActive = false;
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
  if (localStorage.getItem('theme') === 'dark') applyDark(); else applyLight();
}
function _setThemeColor(c) {
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', c);
}
function applyDark() {
  document.body.classList.add('dark');
  const i = document.getElementById('theme-icon'); if (i) i.textContent = '☀️';
  const l = document.getElementById('theme-label'); if (l) l.textContent = 'Light Mode';
  _setThemeColor('#0d0b1a');
}
function applyLight() {
  document.body.classList.remove('dark');
  const i = document.getElementById('theme-icon'); if (i) i.textContent = '🌙';
  const l = document.getElementById('theme-label'); if (l) l.textContent = 'Dark Mode';
  _setThemeColor('#f6f5fb');
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

// Top-nav world: the "sidebar" is the horizontal primary nav (#sidebar). On
// phones it collapses behind the hamburger as a drop-down menu — toggleSidebar
// opens/closes that menu with a tap-to-close backdrop. On desktop the nav is
// always visible, so this is effectively a mobile-only affordance.
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  const open = sb.classList.toggle('mobile-open');
  _sidebarBackdrop().classList.toggle('show', open);
  document.body.classList.toggle('drawer-open', open);
}

function closeSidebarMobile() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  sb.classList.remove('mobile-open');
  const bd = document.getElementById('sidebar-backdrop');
  if (bd) bd.classList.remove('show');
  document.body.classList.remove('drawer-open');
}

// ── User menu (top-nav account dropdown) ──────────────────────────────────────
// Holds change-password / theme toggle / sign-out. Opens on click, closes on an
// outside click.
function toggleUserMenu(e) {
  if (e) e.stopPropagation();
  const m = document.getElementById('user-menu');
  if (m) m.classList.toggle('open');
}
document.addEventListener('click', (e) => {
  const m = document.getElementById('user-menu');
  if (m && m.classList.contains('open') && !m.contains(e.target)) m.classList.remove('open');
});

// ── Icon-rail: retired with the move to a top navigation bar. Kept as safe
// no-ops so any stale caller / inline handler doesn't throw.
function applyRailState() { /* no-op */ }
function toggleRail() { /* no-op */ }

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
  // English (Latin) Hijri so dates never render in Arabic script.
  _hijriFullFmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' });
} catch (e) { _hijriDayFmt = _hijriFullFmt = null; }

// Short Hijri "DD Mon" for a Gregorian y/m/d (1-based month). '' if unsupported.
function hijriShort(year, month, day) {
  if (!_hijriDayFmt) return '';
  try { return _hijriDayFmt.format(new Date(year, month - 1, day)); }
  catch (e) { return ''; }
}
// Full Hijri date (English) for tooltips/labels.
function hijriFull(year, month, day) {
  if (!_hijriFullFmt) return '';
  try { return _hijriFullFmt.format(new Date(year, month - 1, day)) + ' AH'; }
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
// Reports and Schedule PDF exports. openReport() drops the built markup into
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

// ── Time formatting ───────────────────────────────────────────────────────────
// Convert "HH:MM" 24h → "H:MM AM/PM"
function fmt12(t) {
  if (!t) return '—';
  const [h, m] = t.split(':').map(Number);
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12  = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ampm}` : `${h12}:00 ${ampm}`;
}
// ── Relative time ─────────────────────────────────────────────────────────────
// One shared "time ago" for every page (was reimplemented in review/announcements/
// tickets/notifications/radstats). Options:
//   utc:true          → server sent UTC without a timezone (append 'Z')
//   weekFallback:true → after a week, show the locale date instead of "Nd ago"
function timeAgo(ts, { utc = false, weekFallback = false } = {}) {
  if (!ts && ts !== 0) return '';
  const d = new Date(utc ? ts + 'Z' : ts);
  const t = d.getTime();
  if (!Number.isFinite(t)) return 'just now';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (weekFallback && s >= 604800) return d.toLocaleDateString('en-GB');
  return `${Math.floor(s / 86400)}d ago`;
}

// A date rendered as "3 Jun 2026" (UTC). Shared by leave/swap/home/portal/employee
// file — was previously defined in leaves.js and relied on by everything via load order.
function fmtDateDisplay(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric', timeZone:'UTC' });
}

// ── Colour brightness ─────────────────────────────────────────────────────────
function contrastColor(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return (r*299 + g*587 + b*114) / 1000 > 128 ? '#2B2458' : '#ffffff';
}

// ── Employee file: document slots + printable file ────────────────────────────
// The canonical checklist every staff file must carry (CBAHI RD.1.2 / SCFHS).
// `exp:true` documents drive expiry reminders; the rest are one-off records.
const DOC_TYPES = [
  { kind: 'cv',           en: 'Updated CV',              ar: 'السيرة الذاتية',            exp: false },
  { kind: 'moh_license',  en: 'MOH License',             ar: 'رخصة وزارة الصحة',          exp: true  },
  { kind: 'scfhs',        en: 'Saudi Council Card',      ar: 'تصنيف هيئة التخصصات',      exp: true  },
  { kind: 'transcript',   en: 'Transcript of Records',   ar: 'كشف الدرجات',              exp: false },
  { kind: 'diploma',      en: 'Diploma',                 ar: 'الشهادة الجامعية',          exp: false },
  { kind: 'bls',          en: 'BLS Certificate',         ar: 'شهادة الإنعاش (BLS)',       exp: true  },
  { kind: 'national_id',  en: 'National ID / Iqama',     ar: 'الهوية / الإقامة',          exp: true  },
  { kind: 'malpractice',  en: 'Malpractice Insurance',   ar: 'تأمين الأخطاء الطبية',      exp: true  },
  { kind: 'other',        en: 'Other Certificate',       ar: 'شهادات أخرى',              exp: false },
];

// Status of one document slot given its saved record (or undefined if missing).
// → { code:'ok'|'soon'|'expired'|'missing'|'nodate', color, label }
function docStatus(def, rec) {
  if (!rec || (!rec.expiry_date && !rec.issue_date && !rec.number)) {
    return { code: 'missing', color: 'var(--danger-ink,#e25555)', label: 'Missing' };
  }
  if (!def.exp) return { code: 'ok', color: '#2BAE66', label: 'On file' };
  if (!rec.expiry_date) return { code: 'nodate', color: '#E2933F', label: 'No expiry' };
  const days = (rec.days_left != null)
    ? rec.days_left
    : Math.round((new Date(rec.expiry_date) - new Date()) / 86400000);
  if (days < 0)  return { code: 'expired', color: 'var(--danger-ink,#e25555)', label: 'Expired' };
  if (days <= 60) return { code: 'soon', color: '#E2933F', label: `${days}d left` };
  return { code: 'ok', color: '#2BAE66', label: 'Valid' };
}

// Build a tidy, print-ready A4 employee-file document and open the print dialog.
// `staff` = { name, branch_name, speciality, employee_id }, `docs` = credential rows.
function printEmployeeFile(staff, docs) {
  const byKind = {};
  (docs || []).forEach(d => { if (!byKind[d.kind]) byKind[d.kind] = d; });
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const rows = DOC_TYPES.map(def => {
    const rec = byKind[def.kind];
    const st  = docStatus(def, rec);
    const fmt = v => v ? fmtDateDisplay(v) : '—';
    return `<tr>
      <td class="doc">${escapeHtml(def.en)}<span class="ar">${escapeHtml(def.ar)}</span></td>
      <td>${rec && rec.number ? escapeHtml(rec.number) : '—'}</td>
      <td>${rec ? fmt(rec.issue_date) : '—'}</td>
      <td>${def.exp ? (rec ? fmt(rec.expiry_date) : '—') : '<span class="na">N/A</span>'}</td>
      <td><span class="pill" style="color:${st.color};border-color:${st.color}">${st.label}</span></td>
    </tr>`;
  }).join('');
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print the file', 'err'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8">
    <title>Employee File — ${escapeHtml(staff.name || '')}</title>
    <style>
      *{box-sizing:border-box} body{font-family:'Poppins',system-ui,Arial,sans-serif;color:#2B2458;margin:0;padding:32px 34px}
      .hd{display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid var(--accent,#6b4eff);padding-bottom:14px;margin-bottom:18px}
      .hd img{height:38px} .hd .t{text-align:right} .hd .t b{font-size:18px} .hd .t div{font-size:11px;color:#8585A8}
      h1{font-size:20px;margin:6px 0 2px} .sub{color:#8585A8;font-size:12px;margin-bottom:18px}
      .meta{display:flex;gap:26px;flex-wrap:wrap;margin-bottom:18px}
      .meta div span{display:block;font-size:10px;color:#8585A8;text-transform:uppercase;letter-spacing:.5px}
      .meta div b{font-size:14px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th{background:#f4f1fb;color:#5b5b78;text-align:left;padding:9px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.4px}
      td{padding:9px 10px;border-bottom:1px solid #eee;vertical-align:middle}
      td.doc{font-weight:600} td.doc .ar{display:block;font-size:10px;color:#8585A8;font-weight:400}
      .pill{border:1px solid;border-radius:20px;padding:2px 9px;font-size:10px;font-weight:600;white-space:nowrap}
      .na{color:#b9b6cf} .foot{margin-top:22px;font-size:10px;color:#9a95ba;text-align:center;border-top:1px solid #eee;padding-top:10px}
      @media print{body{padding:0}}
    </style></head><body>
    <div class="hd"><img src="/meena_logo.png" alt="Meena" onerror="this.style.display='none'">
      <div class="t"><b>Employee File</b><div>ملف الموظف · Radiology</div></div></div>
    <h1>${escapeHtml(staff.name || '')}</h1>
    <div class="sub">${escapeHtml(staff.speciality || staff.role || '')}</div>
    <div class="meta">
      ${staff.employee_id ? `<div><span>Employee ID</span><b>${escapeHtml(String(staff.employee_id))}</b></div>` : ''}
      ${staff.branch_name ? `<div><span>Branch</span><b>${escapeHtml(staff.branch_name)}</b></div>` : ''}
      <div><span>Generated</span><b>${today}</b></div>
    </div>
    <table><thead><tr><th>Document</th><th>Number</th><th>Issue</th><th>Expiry</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <div class="foot">Generated by Meena Health · This file reflects documents recorded in the system as of ${today}.</div>
    <script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script>
    </body></html>`);
  w.document.close();
}
