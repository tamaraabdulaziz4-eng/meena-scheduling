// ── App entry point ───────────────────────────────────────────────────────────
let currentPage = 'schedule';

// Ping a tiny endpoint on a timer so the serverless database never goes cold —
// that idle cold-start was the main reason the first load after a break stalled.
// Only runs while the tab is visible, and fires immediately on load.
let _keepaliveTimer = null;
function startKeepalive() {
  if (_keepaliveTimer) return;
  const ping = () => {
    if (document.visibilityState === 'visible') {
      fetch('/api/health', { credentials: 'include' }).catch(() => {});
    }
  };
  ping();
  _keepaliveTimer = setInterval(ping, 4 * 60 * 1000);   // every 4 minutes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ping();  // warm up on refocus
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();

  const params = new URLSearchParams(location.search);
  // A registration link (?register=CODE&as=staff|admin|manager) opens onboarding.
  const regCode = params.get('register');
  if (regCode) { startRegistration(regCode, params.get('as') || 'staff'); return; }
  // A password-reset link (?reset=TOKEN) jumps straight to the set-password form.
  const resetToken = params.get('reset');
  if (resetToken) { startPasswordReset(resetToken); return; }

  startKeepalive();   // keep the (serverless) DB warm so loads don't stall

  showLoader('Starting…');
  const authed = await checkAuth();
  hideLoader();

  if (!authed) {
    showLoginView();
    // Tell the user why they landed here — idle timeout or an expired session.
    const e = document.getElementById('login-error');
    if (sessionStorage.getItem('idleLogout')) {
      sessionStorage.removeItem('idleLogout');
      if (e) e.textContent = 'You were signed out due to inactivity.';
    } else if (sessionStorage.getItem('sessionExpired')) {
      sessionStorage.removeItem('sessionExpired');
      if (e) e.textContent = 'Your session expired — please sign in again.';
    }
    return;
  }

  initApp();
});

async function initApp() {
  document.getElementById('sidebar-user').textContent = `${currentUser.username} · ${currentUser.role}`;

  // Roles: viewer < staff < admin (team lead) < manager < superadmin (full admin)
  const role = currentUser.role;
  const isStaff = role === 'staff';
  const isManager = role === 'manager';
  const isSuperAdmin = role === 'superadmin';
  // "Admin tools" (branches, shift types, users, audit) are for the full admin only.
  // The manager is intentionally kept focused: Schedule, Staff, Leave, Review.
  const showAdminTools = isSuperAdmin;
  // A staff member gets a stripped-down portal: only My Schedule + Leave.
  const canSeeStaff = !isStaff;
  // Reviewers (manager + full admin) get the Review page.
  const isReviewer = ['manager','superadmin'].includes(role);

  // Home dashboard — reviewers and team leads (staff get My Schedule instead).
  const homeNav = document.getElementById('nav-home');
  const canSeeHome = ADMIN_ROLES.includes(role);
  if (homeNav) homeNav.style.display = canSeeHome ? 'flex' : 'none';
  // Staff self-service nav item.
  const mySchedNav = document.getElementById('nav-myschedule');
  if (mySchedNav) mySchedNav.style.display = isStaff ? 'flex' : 'none';
  // Hide the team rota / staff list / etc. from a staff member.
  const schedNav = document.getElementById('nav-schedule');
  if (schedNav) schedNav.style.display = isStaff ? 'none' : 'flex';

  document.getElementById('nav-section-admin').style.display = showAdminTools ? 'block' : 'none';
  document.getElementById('nav-branches').style.display    = showAdminTools ? 'flex' : 'none';
  document.getElementById('nav-shifts').style.display      = showAdminTools ? 'flex' : 'none';
  document.getElementById('nav-users').style.display       = showAdminTools ? 'flex' : 'none';
  const hisNav = document.getElementById('nav-hisaccess');
  if (hisNav) hisNav.style.display = showAdminTools ? 'flex' : 'none';
  document.getElementById('nav-audit').style.display       = showAdminTools ? 'flex' : 'none';
  const staffNav = document.getElementById('nav-staff');
  if (staffNav) staffNav.style.display = canSeeStaff ? 'flex' : 'none';
  // Review page for reviewers (manager + full admin)
  const reviewNav = document.getElementById('nav-review');
  if (reviewNav) reviewNav.style.display = isReviewer ? 'flex' : 'none';
  // Reports for team leads + managers (a lead sees their own branch).
  const reportsNav = document.getElementById('nav-reports');
  if (reportsNav) reportsNav.style.display = ADMIN_ROLES.includes(role) ? 'flex' : 'none';
  const messagesNav = document.getElementById('nav-messages');
  if (messagesNav) messagesNav.style.display = ADMIN_ROLES.includes(role) ? 'flex' : 'none';
  // Radiology WORKFLOW pages (worklist, handoff, patient lookup, CD transfers).
  // Team leads / managers / full admins have them by role; a plain staff member only
  // when granted the per-user radiology privilege (so access goes to certain people,
  // not every staff account). Rad Stats stays team-lead-and-up; Orders (order history)
  // follows the worklist grant.
  const staffHasRad = role === 'staff' && !!(currentUser.can_use_radiology || currentUser.can_file_radiology);
  const canRad = ADMIN_ROLES.includes(role) || staffHasRad;
  const canRadMgmt = ADMIN_ROLES.includes(role);
  // Radiology handoff.
  const handoffNav = document.getElementById('nav-handoff');
  if (handoffNav) handoffNav.style.display = canRad ? 'flex' : 'none';
  // Unified patient / exam lookup.
  const patientSearchNav = document.getElementById('nav-patientsearch');
  if (patientSearchNav) patientSearchNav.style.display = canRad ? 'flex' : 'none';
  // Radiology statistics — management/analytics (team leads + managers).
  const radstatsNav = document.getElementById('nav-radstats');
  if (radstatsNav) radstatsNav.style.display = canRadMgmt ? 'flex' : 'none';
  // Radiology RIS worklist — the operator's main screen.
  const worklistNav = document.getElementById('nav-worklist');
  if (worklistNav) worklistNav.style.display = canRad ? 'flex' : 'none';
  // Critical results — closed-loop communication (anyone who works radiology).
  const criticalNav = document.getElementById('nav-critical');
  if (criticalNav) criticalNav.style.display = canRad ? 'flex' : 'none';
  if (canRad && typeof crRefreshBadge === 'function') { try { crRefreshBadge(); } catch (e) {} }
  // "Radiology" section label — visible whenever any radiology item is.
  const radSection = document.getElementById('nav-section-radiology');
  if (radSection) radSection.style.display = canRad ? 'block' : 'none';
  // Radiology order lifecycle board — the order history / turnaround view. Gated the
  // same as the worklist (anyone who works radiology) so a privileged staff operator can
  // see where their reports landed; Rad Stats stays management-only.
  const ordersNav = document.getElementById('nav-orders');
  if (ordersNav) ordersNav.style.display = canRad ? 'flex' : 'none';
  // Radiology CD transfers.
  const cdxferNav = document.getElementById('nav-cdxfer');
  if (cdxferNav) cdxferNav.style.display = canRad ? 'flex' : 'none';
  // RIS-first: for anyone who works radiology, float the whole Radiology section to the
  // TOP of the sidebar so the RIS is the base of the app (the operator's home). Purely a
  // reorder of existing nodes — role gating + handlers are untouched. Non-radiology users
  // keep the scheduling-first order (the radiology section stays hidden for them).
  if (canRad) {
    const nav = document.querySelector('.sidebar-nav');
    const radIds = ['nav-section-radiology', 'nav-worklist', 'nav-critical', 'nav-orders', 'nav-handoff',
                    'nav-patientsearch', 'nav-radstats', 'nav-cdxfer'];
    if (nav) {
      // Insert each at the front in REVERSE so the original visual order is preserved on top.
      radIds.map((id) => document.getElementById(id)).filter(Boolean).reverse()
        .forEach((el) => nav.insertBefore(el, nav.firstChild));
    }
  }
  // Swaps page for everyone except plain viewers (staff request & track theirs).
  const swapsNav = document.getElementById('nav-swaps');
  if (swapsNav) swapsNav.style.display = (role === 'viewer') ? 'none' : 'flex';
  // A staff member can still reach the Leave page (their own requests only).
  const leavesNav = document.getElementById('nav-leaves');
  if (leavesNav) leavesNav.style.display = (role === 'viewer') ? 'none' : 'flex';
  // Downtime registration: every working staff member can log a patient.
  const downtimeNav = document.getElementById('nav-downtime');
  if (downtimeNav) downtimeNav.style.display = (role === 'viewer') ? 'none' : 'flex';
  const inventoryNav = document.getElementById('nav-inventory');
  if (inventoryNav) inventoryNav.style.display = (role === 'viewer') ? 'none' : 'flex';
  const equipmentNav = document.getElementById('nav-equipment');
  if (equipmentNav) equipmentNav.style.display = (role === 'viewer') ? 'none' : 'flex';
  // Kick off in-app notification polling once the user is in.
  if (typeof startNotifPolling === 'function') startNotifPolling();
  // Register the service worker + reflect device-notification state in the bell.
  if (typeof initPush === 'function') initPush();
  // Auto sign-out after a stretch of inactivity.
  if (typeof startIdleWatch === 'function') startIdleWatch();
  // Load org settings (leave cutoff day) so the leave UI can warn early.
  try { const st = await API.get('/settings'); if (st?.leave_cutoff_day) leaveCutoffDay = st.leave_cutoff_day; } catch (e) {}
  // Pre-load the pending-review count so the badge shows on login
  if (isReviewer && typeof loadReviewBadgeCount === 'function') {
    loadReviewBadgeCount();
  }
  // Open-ticket badge (team leads + reviewers).
  if (typeof loadTicketsBadge === 'function') loadTicketsBadge();
  // Unacknowledged action-required circulars badge (everyone).
  if (typeof loadAnnouncementsBadge === 'function') loadAnnouncementsBadge();
  // Landing page: anyone who works radiology (team leads / managers / admins, or a
  // staff member granted the privilege) opens straight onto the Worklist. A staff
  // member WITHOUT radiology lands on their schedule; other roles on the schedule.
  window._defaultPage = canRad ? 'worklist' : (isStaff ? 'myschedule' : 'schedule');
  // Kick the landing page's lazy chunk NOW so it downloads in parallel with the login
  // data fetches below — by the time showPage() runs it's already in hand (no-op for an
  // eager landing page). This keeps the radiology operator's cold open fast.
  const _dp = new URLSearchParams(location.search).get('p') || pageFromHash() || window._defaultPage;
  prefetchPageAssets(_dp);

  // Load global data. Staff don't need the full roster up front (only the swap
  // modal does, and it lazy-loads it) — so don't make them wait on it before the
  // first page paints.
  showLoader('Loading data…');
  try {
    const loads = [loadBranches()];
    if (!isStaff) loads.push(loadStaff());
    await Promise.all(loads);
  } catch (e) { console.error('Data load error:', e); }
  hideLoader();

  // Await the first page render so the welcome splash — shown by doLogin — stays
  // up until the page is on screen. Honour a deep-link hash (e.g. after a
  // refresh or a shared link) when it points to a page this user may see.
  // A notification tap can open the app at /?p=<page>.
  const deepLink = new URLSearchParams(location.search).get('p');
  await showPage(deepLink || pageFromHash() || window._defaultPage || 'schedule');
}

// Resolve role-based redirects up front so a blocked route animates ONCE to its
// real destination instead of fading twice (old code fell into the switch, then
// recursively called showPage → double transition).
function resolvePage(page) {
  const role = currentUser?.role;
  if (page === 'home' && !ADMIN_ROLES.includes(role))
    return role === 'staff' ? 'myschedule' : 'schedule';
  if (page === 'schedule'   && role === 'staff')  return 'myschedule';
  if (page === 'swaps' && role === 'viewer') return 'schedule';
  // Branches, shift types, and the audit log are full-admin (superadmin) tools —
  // the backend rejects everyone else, so the route guard must match (a team lead
  // reaching them via a stale link would otherwise see a page that then 403s).
  if (page === 'reports' && !ADMIN_ROLES.includes(role)) return role === 'staff' ? 'myschedule' : 'schedule';
  if (page === 'messages' && !ADMIN_ROLES.includes(role)) return role === 'staff' ? 'myschedule' : 'schedule';
  // Radiology workflow pages: team leads/managers/admins by role; a staff member
  // only with the granted radiology privilege.
  const canRadRoute = ADMIN_ROLES.includes(role)
    || (role === 'staff' && !!(currentUser?.can_use_radiology || currentUser?.can_file_radiology));
  const radElse = role === 'staff' ? 'myschedule' : 'schedule';
  if (page === 'handoff' && !canRadRoute) return radElse;
  if (page === 'patientsearch' && !canRadRoute) return radElse;
  if (page === 'worklist' && !canRadRoute) return radElse;
  if (page === 'cdxfer' && !canRadRoute) return radElse;
  // Radiology management/analytics: Rad Stats stays team-lead-and-up. Orders (the order
  // history / turnaround view) is gated the same as the worklist — a privileged staff
  // operator who works the board can also see where their reports ended up.
  if (page === 'radstats' && !ADMIN_ROLES.includes(role)) return canRadRoute ? 'worklist' : radElse;
  if (page === 'orders' && !canRadRoute) return radElse;
  if (page === 'critical' && !canRadRoute) return radElse;
  if (page === 'branches' && role !== 'superadmin') return 'schedule';
  if (page === 'shifts'   && role !== 'superadmin') return 'schedule';
  if (page === 'audit'    && role !== 'superadmin') return 'schedule';
  if (page === 'users'    && role !== 'superadmin') return 'schedule';
  if (page === 'hisaccess' && role !== 'superadmin') return 'schedule';
  return page;
}

// ── On-demand page modules (lazy-load) ────────────────────────────────────────
// The core (api/auth/util/main + the login-time badge/push/notif modules + shared
// helpers like consent) ships eagerly in index.html. The big page modules below are
// NOT in that eager set — they're fetched the first time their page is opened, so a
// user only downloads the pages they actually use (e.g. a radiology operator gets the
// worklist chunk, never the schedule chunk). Value = the /js files a page needs; a
// page whose module calls another lazy module lists both (home embeds the rad-stats
// widget via a typeof-guarded call, so it pulls radstats too).
// NOTE: schedule.js and leaves.js stay EAGER — schedule is coupled to review.js/export.js
// (eager) via shared globals, and portal.js's "Request Leave" button calls leaves.js's
// openLeaveModal; radstats.js and radreport.js are mutually coupled, so radstats always
// pulls radreport, and home (which embeds the rad-stats widget) pulls both.
// The radiology WORKFLOW modules are mutually coupled and must load together: the worklist
// opens the patient card (renderPsDetail/psState from patientsearch) and the handoff flow
// (handoff.js); patientsearch calls back into worklist (wlNeedsRadSafety); home embeds the
// patient-lookup + handoff quick actions. So they ship as one cluster on any radiology page
// — a rad operator uses all three anyway, and non-radiology users still never download them.
const RAD_JS = ['/js/worklist.js', '/js/patientsearch.js', '/js/handoff.js', '/js/criticalresults.js'];
// Each page lists the /js AND /css it needs. The two biggest, cleanly-namespaced CSS blocks
// were split out of style.css (which keeps ALL shared rules) so a user only downloads those
// styles for pages they open: worklist.css (.cc + .rw board, ~35KB) and radstats.css
// (.rs- + .rsr-, ~25KB, also pulled by home which embeds the rad-stats widget).
const PAGE_ASSETS = {
  worklist:      [...RAD_JS, '/css/worklist.css'],
  patientsearch: RAD_JS,
  handoff:       RAD_JS,
  reports:       ['/js/reports.js'],
  critical:      ['/js/criticalresults.js', '/css/worklist.css'],
  radstats:      ['/js/radstats.js', '/js/radreport.js', '/css/radstats.css'],
  home:          ['/js/home.js', ...RAD_JS, '/js/radstats.js', '/js/radreport.js', '/css/radstats.css'],
};
// Cache-buster for injected chunks: the server stamps the content-hash BUILD_ID into
// <meta name="meena-build"> and rewrites every ?v= in index.html to it, and stamps the
// SW cache name to match — so reusing it here makes lazy chunks bust + cache exactly
// like the eager scripts, per deploy. Falls back to 'dev' when unstamped (local file).
const _ASSET_VER = (document.querySelector('meta[name="meena-build"]') || {}).content || 'dev';
const _loadedAssets = new Set();
const _loadingAssets = new Map();   // url -> Promise (dedup concurrent/hover-prefetch loads)
// Load a /js (<script>) or /css (<link rel=stylesheet>) asset once, resolving on load.
function _loadAssetOnce(url) {
  if (_loadedAssets.has(url)) return Promise.resolve();
  if (_loadingAssets.has(url)) return _loadingAssets.get(url);
  const isCss = url.endsWith('.css');
  const p = new Promise((resolve, reject) => {
    let el;
    if (isCss) {
      el = document.createElement('link');
      el.rel = 'stylesheet';
      el.href = url + '?v=' + _ASSET_VER;
    } else {
      el = document.createElement('script');
      el.src = url + '?v=' + _ASSET_VER;
      el.async = false;   // preserve execution order when several scripts are injected together
    }
    el.onload = () => { _loadedAssets.add(url); _loadingAssets.delete(url); resolve(); };
    el.onerror = () => { _loadingAssets.delete(url); reject(new Error('Failed to load ' + url)); };
    document.head.appendChild(el);
  });
  _loadingAssets.set(url, p);
  return p;
}
// Ensure a page's assets (JS + CSS) are loaded before we render it, so there's no unstyled
// flash. Eager pages (not in the map) resolve instantly. Rejects if an asset fails to load
// → showPage shows its retry card.
async function loadPageAssets(page) {
  const assets = PAGE_ASSETS[page];
  if (!assets || !assets.length) return;
  const t0 = performance.now();
  await Promise.all(assets.map(_loadAssetOnce));
  try {
    const ms = Math.round(performance.now() - t0);
    if (ms > 1 && window.__perf) window.__perf.record({ path: 'chunk:' + page, ms, ok: true, bytes: null, at: Date.now() });
  } catch (_) {}
}
// Prefetch a page's assets on nav-hover so the click paints instantly (no-op once loaded).
function prefetchPageAssets(page) {
  const assets = PAGE_ASSETS[page];
  if (assets) assets.forEach((u) => { if (!_loadedAssets.has(u)) _loadAssetOnce(u).catch(() => {}); });
}

async function renderRoute(page) {
  // Lazy pages: fetch the module before dispatching. showPage already shows the top-bar
  // loading state and awaits this, so there's no extra placeholder to manage.
  await loadPageAssets(page);
  // showPage already paints the animated shimmer skeleton before we get here,
  // so fetch-first pages keep that during their load — no extra placeholder.
  switch (page) {
    case 'home':       await renderHomePage(); break;
    case 'myschedule': await renderMySchedulePage(); break;
    case 'schedule':   await renderSchedulePage(); break;
    case 'review':     await renderReviewPage(); break;
    case 'staff':      try { await loadStaff(); } catch(e){}  renderStaffPage();
                       // Pending registrations load in the background, then fill in.
                       loadRegistrations().then(() => { if (currentPage === 'staff') renderPendingRegs(); }).catch(()=>{});
                       break;
    case 'leaves':     await renderLeavesPage(); break;
    case 'swaps':      renderSwapsPage();
                       // Staff list (for the request modal) loads in the background.
                       if (!allStaff || !allStaff.length) loadStaff().catch(()=>{});
                       break;
    case 'inventory':  await renderInventoryPage(); break;
    case 'equipment':  await renderEquipmentPage(); break;
    case 'downtime':   await renderDowntimePage(); break;
    case 'tickets':    await renderTicketsPage(); break;
    case 'reports':    await renderReportsPage(); break;
    case 'handoff':    await renderHandoffPage(); break;
    case 'patientsearch': renderPatientSearchPage(); break;
    case 'radstats':   await renderRadStatsPage(); break;
    case 'worklist':   await renderWorklistPage(); break;
    case 'critical':   renderCriticalResultsPage(); break;
    case 'orders':     await renderOrdersPage(); break;
    case 'cdxfer':     await renderCdxferPage(); break;
    case 'announcements': renderAnnouncementsPage(); break;
    case 'messages':   await renderMessagesPage(); break;
    case 'branches':   try { await loadBranches(); } catch(e){}  renderBranchesPage(); break;
    case 'shifts':     try { await Promise.all([loadBranches(), loadAllShiftTypesRaw()]); } catch(e){}  renderShiftsPage(); break;
    case 'users':      try { await loadUsers(); } catch(e){}  renderUsersPage(); break;
    case 'hisaccess':  renderHisAccessPage(); break;
    case 'audit':      await renderAuditPage(); break;
    default:
      document.getElementById('content').innerHTML = `<div class="empty"><p>Page not found</p></div>`;
  }
}

// Monotonic token: if the user navigates again mid-load, the older render bails
// (and the newer one finalises #content), so they never fight. No page fade —
// the old content stays put until the new one is ready, with only the slim top
// bar for feedback. Instant and flash-free.
let _navSeq = 0;
// Page-level hash routing: keep the URL (#/page) in sync so the browser back
// button, a refresh, and shared links all land on the right screen.
const VALID_PAGES = new Set(['home','myschedule','schedule','review','staff',
  'leaves','swaps','downtime','inventory','equipment','tickets','announcements','messages','reports','handoff','orders','worklist','critical','patientsearch','radstats','cdxfer','branches','shifts','users','audit']);
function pageFromHash() {
  const h = (location.hash || '').replace(/^#\/?/, '').split('?')[0].trim();
  return VALID_PAGES.has(h) ? h : null;
}
// Query params carried in the hash, e.g. #/schedule?branch=3&month=2026-06
function hashParams() {
  return Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
}
window.addEventListener('hashchange', () => {
  const p = pageFromHash();
  // Only act on a real change (e.g. the back button) — showPage sets the hash
  // itself, and that echo is ignored because it already matches currentPage.
  if (p && p !== currentPage) showPage(p);
});
// Warm a page's lazy chunk the instant the operator hovers/focuses its nav item, so the
// actual click renders with the module already in hand. Delegated so it survives the
// radiology-section reorder in initApp. Cheap and idempotent (dedup in _loadScriptOnce).
document.addEventListener('pointerover', (e) => {
  const item = e.target.closest && e.target.closest('.nav-item[id^="nav-"]');
  if (item) prefetchPageAssets(item.id.slice(4));
}, { passive: true });

async function showPage(requested) {
  const page = resolvePage(requested);
  const seq = ++_navSeq;
  const _t0 = performance.now();   // page-open timing (nav → rendered)
  currentPage = page;
  // Reflect the resolved page in the URL hash (the hashchange echo is a no-op
  // since it now matches currentPage).
  if (pageFromHash() !== page) { try { location.hash = '#/' + page; } catch (e) {} }

  // Nav active state (highlight the resolved destination).
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navEl = document.getElementById(`nav-${page}`);
  if (navEl) navEl.classList.add('active');
  // On a phone, picking a page closes the slide-in drawer.
  if (typeof closeSidebarMobile === 'function') closeSidebarMobile();

  const content = document.getElementById('content');
  // Each page draws its own content (and its own loading placeholder where it
  // fetches). We deliberately do NOT pre-inject a skeleton here — an earlier
  // version did and it could overwrite a page's DOM mid-load, freezing it.
  try {
    await renderRoute(page);
  } catch (e) {
    console.error('Page render error:', e);
    if (seq === _navSeq) {
      content.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div>
        <p>Couldn't load this page. Please try again.</p>
        <button class="btn btn-sm" style="margin-top:12px" onclick="showPage('${page}')">Retry</button></div>`;
    }
    return;
  }
  if (seq !== _navSeq) return;                 // superseded by a newer navigation
  content.scrollTop = 0;
  const main = document.getElementById('main'); if (main) main.scrollTop = 0;
  // Page-open timing → perf ring buffer (path 'page:<name>' so __perf.summary('page:') groups them).
  try {
    const ms = Math.round(performance.now() - _t0);
    if (window.__perf) window.__perf.record({ path: 'page:' + page, ms, ok: true, bytes: null, at: Date.now() });
    if (ms > 800) console.debug(`[nav] ${page} rendered in ${ms}ms`);
  } catch (_) {}
  // Premium entrance motion for the freshly rendered page.
  playPageReveal();
}

// Close shift picker when clicking outside
document.addEventListener('click', (e) => {
  const picker = document.getElementById('shift-picker');
  if (picker && picker.style.display !== 'none' && !picker.contains(e.target)) {
    // closePicker already attached via once listener, but guard here too
  }
});

// Keyboard shortcut: Escape closes any open modal (and the mobile drawer)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    document.getElementById('shift-picker').style.display = 'none';
    if (typeof closeSidebarMobile === 'function') closeSidebarMobile();
  }
});

// Don't leave the mobile drawer/backdrop stuck when resizing up to desktop.
window.addEventListener('resize', () => {
  if (window.innerWidth > 820 && typeof closeSidebarMobile === 'function') closeSidebarMobile();
});
