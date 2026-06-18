// ── App entry point ───────────────────────────────────────────────────────────
let currentPage = 'schedule';

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();

  const params = new URLSearchParams(location.search);
  // A staff-registration link (?register=CODE) opens the public onboarding form.
  const regCode = params.get('register');
  if (regCode) { startRegistration(regCode); return; }
  // A password-reset link (?reset=TOKEN) jumps straight to the set-password form.
  const resetToken = params.get('reset');
  if (resetToken) { startPasswordReset(resetToken); return; }

  showLoader('Starting…');
  const authed = await checkAuth();
  hideLoader();

  if (!authed) {
    showLoginView();
    // Tell the user if they landed here because of an idle timeout.
    if (sessionStorage.getItem('idleLogout')) {
      sessionStorage.removeItem('idleLogout');
      const e = document.getElementById('login-error');
      if (e) e.textContent = 'You were signed out due to inactivity.';
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
  // Swaps page for everyone except plain viewers (staff request & track theirs).
  const swapsNav = document.getElementById('nav-swaps');
  if (swapsNav) swapsNav.style.display = (role === 'viewer') ? 'none' : 'flex';
  // A staff member can still reach the Leave page (their own requests only).
  const leavesNav = document.getElementById('nav-leaves');
  if (leavesNav) leavesNav.style.display = (role === 'viewer') ? 'none' : 'flex';
  // Daily Cases: managers/leads view; staff (night/eligible) fill.
  const casesNav = document.getElementById('nav-cases');
  if (casesNav) casesNav.style.display = (role === 'viewer') ? 'none' : 'flex';
  // Kick off in-app notification polling once the user is in.
  if (typeof startNotifPolling === 'function') startNotifPolling();
  // Auto sign-out after a stretch of inactivity.
  if (typeof startIdleWatch === 'function') startIdleWatch();
  // Load org settings (leave cutoff day) so the leave UI can warn early.
  try { const st = await API.get('/settings'); if (st?.leave_cutoff_day) leaveCutoffDay = st.leave_cutoff_day; } catch (e) {}
  // Pre-load the pending-review count so the badge shows on login
  if (isReviewer && typeof loadReviewBadgeCount === 'function') {
    loadReviewBadgeCount();
  }
  // Staff land on their own schedule; everyone else on the Home dashboard.
  window._defaultPage = isStaff ? 'myschedule' : 'home';

  // Load global data
  showLoader('Loading data…');
  try {
    await Promise.all([
      loadBranches(),
      loadStaff(),
    ]);
  } catch (e) { console.error('Data load error:', e); }
  hideLoader();

  // Await the first page render (schedule) so the welcome splash — which is
  // shown by doLogin — stays up until the rota is actually on screen.
  await showPage(window._defaultPage || 'schedule');
}

// Resolve role-based redirects up front so a blocked route animates ONCE to its
// real destination instead of fading twice (old code fell into the switch, then
// recursively called showPage → double transition).
function resolvePage(page) {
  const role = currentUser?.role;
  const adminish = ['admin','superadmin'].includes(role);
  if (page === 'home' && !['admin','manager','superadmin'].includes(role))
    return role === 'staff' ? 'myschedule' : 'schedule';
  if (page === 'schedule'   && role === 'staff')  return 'myschedule';
  if (page === 'nest-config')                     return 'schedule';
  if (['swaps','cases'].includes(page) && role === 'viewer') return 'schedule';
  if (page === 'branches' && !adminish)           return 'schedule';
  if (page === 'shifts'   && !adminish)           return 'schedule';
  if (page === 'audit'    && !adminish)           return 'schedule';
  if (page === 'users'    && role !== 'superadmin') return 'schedule';
  return page;
}

async function renderRoute(page) {
  switch (page) {
    case 'home':       await renderHomePage(); break;
    case 'myschedule': await renderMySchedulePage(); break;
    case 'schedule':   await renderSchedulePage(); break;
    case 'review':     await renderReviewPage(); break;
    case 'staff':      try { await loadStaff(); } catch(e){}  await renderStaffPage(); break;
    case 'leaves':     await renderLeavesPage(); break;
    case 'swaps':      try { await loadStaff(); } catch(e){}  renderSwapsPage(); break;
    case 'cases':      renderCasesPage(); break;
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
async function showPage(requested) {
  const page = resolvePage(requested);
  const seq = ++_navSeq;
  currentPage = page;

  // Nav active state (highlight the resolved destination).
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navEl = document.getElementById(`nav-${page}`);
  if (navEl) navEl.classList.add('active');
  // On a phone, picking a page closes the slide-in drawer.
  if (typeof closeSidebarMobile === 'function') closeSidebarMobile();

  const content = document.getElementById('content');
  // Show a shimmer skeleton only if the page is still loading after a beat —
  // instant feedback for slow fetches, no flash for fast ones.
  let done = false;
  const skelTimer = setTimeout(() => {
    if (!done && seq === _navSeq) content.innerHTML = PAGE_SKELETON;
  }, 120);
  try { await renderRoute(page); }
  catch (e) { console.error('Page render error:', e); }
  done = true; clearTimeout(skelTimer);
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
