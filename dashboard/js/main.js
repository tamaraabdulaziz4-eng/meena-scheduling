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

  // Hide admin nav items for non-admins
  const isAdmin  = ['admin','superadmin'].includes(currentUser.role);
  const isSuperAdmin = currentUser.role === 'superadmin';
  document.getElementById('nav-section-admin').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('nav-branches').style.display    = isSuperAdmin ? 'flex' : 'none';
  document.getElementById('nav-shifts').style.display      = isAdmin ? 'flex' : 'none';
  document.getElementById('nav-users').style.display       = isSuperAdmin ? 'flex' : 'none';
  // Nest Config is deprecated; keep hidden.
  const nestNav = document.getElementById('nav-nest-config');
  if (nestNav) nestNav.style.display = 'none';
  document.getElementById('nav-audit').style.display       = isAdmin ? 'flex' : 'none';
  // Review page is manager-only
  const reviewNav = document.getElementById('nav-review');
  if (reviewNav) reviewNav.style.display = isSuperAdmin ? 'flex' : 'none';
  // Pre-load the pending-review count so the badge shows on login
  if (isSuperAdmin && typeof loadReviewBadgeCount === 'function') {
    loadReviewBadgeCount();
  }

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
  await showPage('schedule');
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
  content.style.transition = 'opacity .18s ease';
  content.style.opacity = '0';
  await new Promise(r => setTimeout(r, 120));

  switch (page) {
    case 'schedule':
      await renderSchedulePage();
      break;

    case 'review':
      await renderReviewPage();
      break;

    case 'staff':
      showLoader('Loading staff…');
      try { await loadStaff(); } finally { hideLoader(); }
      renderStaffPage();
      break;

    case 'leaves':
      renderLeavesPage();
      break;

    case 'branches':
      if (!['admin','superadmin'].includes(currentUser?.role)) { showPage('schedule'); return; }
      showLoader('Loading branches…');
      try { await loadBranches(); } finally { hideLoader(); }
      renderBranchesPage();
      break;

    case 'shifts':
      if (!['admin','superadmin'].includes(currentUser?.role)) { showPage('schedule'); return; }
      showLoader('Loading shift types…');
      try {
        await Promise.all([loadBranches(), loadAllShiftTypesRaw()]);
      } finally { hideLoader(); }
      renderShiftsPage();
      break;

    case 'users':
      if (currentUser?.role !== 'superadmin') { showPage('schedule'); return; }
      showLoader('Loading users…');
      try { await loadUsers(); } finally { hideLoader(); }
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
