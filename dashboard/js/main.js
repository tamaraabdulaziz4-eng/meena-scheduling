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
  const canSeeHome = ['admin', 'manager', 'superadmin'].includes(role);
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
  document.getElementById('nav-audit').style.display       = showAdminTools ? 'flex' : 'none';
  const staffNav = document.getElementById('nav-staff');
  if (staffNav) staffNav.style.display = canSeeStaff ? 'flex' : 'none';
  // Nest Config is deprecated; keep hidden.
  const nestNav = document.getElementById('nav-nest-config');
  if (nestNav) nestNav.style.display = 'none';
  // Review page for reviewers (manager + full admin)
  const reviewNav = document.getElementById('nav-review');
  if (reviewNav) reviewNav.style.display = isReviewer ? 'flex' : 'none';
  // Reports for team leads + managers (a lead sees their own branch).
  const reportsNav = document.getElementById('nav-reports');
  if (reportsNav) reportsNav.style.display = ['admin','manager','superadmin'].includes(role) ? 'flex' : 'none';
  const messagesNav = document.getElementById('nav-messages');
  if (messagesNav) messagesNav.style.display = ['admin','manager','superadmin'].includes(role) ? 'flex' : 'none';
  // Radiology handoff for team leads + managers.
  const handoffNav = document.getElementById('nav-handoff');
  if (handoffNav) handoffNav.style.display = ['admin','manager','superadmin'].includes(role) ? 'flex' : 'none';
  // Unified patient / exam lookup for team leads + managers.
  const patientSearchNav = document.getElementById('nav-patientsearch');
  if (patientSearchNav) patientSearchNav.style.display = ['admin','manager','superadmin'].includes(role) ? 'flex' : 'none';
  // Radiology statistics for team leads + managers.
  const radstatsNav = document.getElementById('nav-radstats');
  if (radstatsNav) radstatsNav.style.display = ['admin','manager','superadmin'].includes(role) ? 'flex' : 'none';
  // Radiology CD transfers for team leads + managers.
  const cdxferNav = document.getElementById('nav-cdxfer');
  if (cdxferNav) cdxferNav.style.display = ['admin','manager','superadmin'].includes(role) ? 'flex' : 'none';
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
  // Staff land on their own schedule; everyone else on the Home dashboard.
  window._defaultPage = isStaff ? 'myschedule' : 'home';

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
  if (page === 'home' && !['admin','manager','superadmin'].includes(role))
    return role === 'staff' ? 'myschedule' : 'schedule';
  if (page === 'schedule'   && role === 'staff')  return 'myschedule';
  if (page === 'nest-config')                     return 'schedule';
  if (page === 'swaps' && role === 'viewer') return 'schedule';
  // Branches, shift types, and the audit log are full-admin (superadmin) tools —
  // the backend rejects everyone else, so the route guard must match (a team lead
  // reaching them via a stale link would otherwise see a page that then 403s).
  if (page === 'reports' && !['admin','manager','superadmin'].includes(role)) return role === 'staff' ? 'myschedule' : 'schedule';
  if (page === 'messages' && !['admin','manager','superadmin'].includes(role)) return role === 'staff' ? 'myschedule' : 'schedule';
  if (page === 'handoff' && !['admin','manager','superadmin'].includes(role)) return role === 'staff' ? 'myschedule' : 'schedule';
  if (page === 'patientsearch' && !['admin','manager','superadmin'].includes(role)) return role === 'staff' ? 'myschedule' : 'schedule';
  if (page === 'radstats' && !['admin','manager','superadmin'].includes(role)) return role === 'staff' ? 'myschedule' : 'schedule';
  if (page === 'cdxfer' && !['admin','manager','superadmin'].includes(role)) return role === 'staff' ? 'myschedule' : 'schedule';
  if (page === 'branches' && role !== 'superadmin') return 'schedule';
  if (page === 'shifts'   && role !== 'superadmin') return 'schedule';
  if (page === 'audit'    && role !== 'superadmin') return 'schedule';
  if (page === 'users'    && role !== 'superadmin') return 'schedule';
  return page;
}

async function renderRoute(page) {
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
    case 'cdxfer':     await renderCdxferPage(); break;
    case 'announcements': renderAnnouncementsPage(); break;
    case 'messages':   await renderMessagesPage(); break;
    case 'branches':   try { await loadBranches(); } catch(e){}  renderBranchesPage(); break;
    case 'shifts':     try { await Promise.all([loadBranches(), loadAllShiftTypesRaw()]); } catch(e){}  renderShiftsPage(); break;
    case 'users':      try { await loadUsers(); } catch(e){}  renderUsersPage(); break;
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
  'leaves','swaps','downtime','inventory','equipment','tickets','announcements','messages','reports','handoff','radstats','cdxfer','branches','shifts','users','audit']);
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

async function showPage(requested) {
  const page = resolvePage(requested);
  const seq = ++_navSeq;
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
