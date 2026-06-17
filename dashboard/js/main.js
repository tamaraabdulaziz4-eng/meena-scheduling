// ── App entry point ───────────────────────────────────────────────────────────
let currentPage = 'schedule';

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  showLoader('Starting…');

  const authed = await checkAuth();
  hideLoader();

  if (!authed) {
    document.getElementById('login-overlay').style.display = 'flex';
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
  // Swaps page for anyone who can edit or review (not plain viewers/staff).
  const swapsNav = document.getElementById('nav-swaps');
  if (swapsNav) swapsNav.style.display = ['admin','superadmin','manager'].includes(role) ? 'flex' : 'none';
  // A staff member can still reach the Leave page (their own requests only).
  const leavesNav = document.getElementById('nav-leaves');
  if (leavesNav) leavesNav.style.display = (role === 'viewer') ? 'none' : 'flex';
  // Kick off in-app notification polling once the user is in.
  if (typeof startNotifPolling === 'function') startNotifPolling();
  // Pre-load the pending-review count so the badge shows on login
  if (isReviewer && typeof loadReviewBadgeCount === 'function') {
    loadReviewBadgeCount();
  }
  // Staff land on their own schedule; a manager on Review; others on Schedule.
  window._defaultPage = isStaff ? 'myschedule' : (isManager ? 'review' : 'schedule');

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

async function showPage(page) {
  currentPage = page;

  // Update nav active state
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navEl = document.getElementById(`nav-${page}`);
  if (navEl) navEl.classList.add('active');

  const content = document.getElementById('content');
  // Smooth fade: dim the old content, render the new page, then fade it back in
  // so pages don't snap into view abruptly.
  content.style.transition = 'opacity .22s ease';
  content.style.opacity = '0';
  await new Promise(r => setTimeout(r, 140));

  switch (page) {
    case 'myschedule':
      await renderMySchedulePage();
      break;

    case 'schedule':
      if (currentUser?.role === 'staff') { showPage('myschedule'); return; }
      await renderSchedulePage();
      break;

    case 'review':
      await renderReviewPage();
      break;

    case 'staff':
      try { await loadStaff(); } catch(e){}
      renderStaffPage();
      break;

    case 'leaves':
      renderLeavesPage();
      break;

    case 'swaps':
      if (!['admin','superadmin','manager'].includes(currentUser?.role)) { showPage('schedule'); return; }
      try { await loadStaff(); } catch(e){}
      renderSwapsPage();
      break;

    case 'branches':
      if (!['admin','superadmin'].includes(currentUser?.role)) { showPage('schedule'); return; }
      try { await loadBranches(); } catch(e){}
      renderBranchesPage();
      break;

    case 'shifts':
      if (!['admin','superadmin'].includes(currentUser?.role)) { showPage('schedule'); return; }
      try { await Promise.all([loadBranches(), loadAllShiftTypesRaw()]); } catch(e){}
      renderShiftsPage();
      break;

    case 'users':
      if (currentUser?.role !== 'superadmin') { showPage('schedule'); return; }
      try { await loadUsers(); } catch(e){}
      renderUsersPage();
      break;

    case 'audit':
      if (!['admin','superadmin'].includes(currentUser?.role)) { showPage('schedule'); return; }
      await renderAuditPage();
      break;

    case 'nest-config':
      // Deprecated page; keep route for old bookmarks but redirect.
      showPage('schedule');
      break;

    default:
      content.innerHTML = `<div class="empty"><p>Page not found</p></div>`;
  }
  // Fade the freshly rendered page back in smoothly.
  requestAnimationFrame(() => { content.style.opacity = '1'; });
}

// Close shift picker when clicking outside
document.addEventListener('click', (e) => {
  const picker = document.getElementById('shift-picker');
  if (picker && picker.style.display !== 'none' && !picker.contains(e.target)) {
    // closePicker already attached via once listener, but guard here too
  }
});

// Keyboard shortcut: Escape closes any open modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    document.getElementById('shift-picker').style.display = 'none';
  }
});
