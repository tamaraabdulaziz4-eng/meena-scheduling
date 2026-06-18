// ── Home dashboard ────────────────────────────────────────────────────────────
// A professional overview for managers / team leads: a branded greeting hero +
// "needs your attention" KPI cards + today's cases progress.

function _greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

async function renderHomePage() {
  setTopbar('Home', 'Your overview at a glance');
  const c = document.getElementById('content');
  const today = new Date();
  const greg = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hij = (typeof hijriFull === 'function') ? hijriFull(today.getFullYear(), today.getMonth() + 1, today.getDate()) : '';
  const roleLabel = { superadmin: 'Administrator', manager: 'Manager', admin: 'Team Lead' }[currentUser?.role] || currentUser?.role || '';

  c.innerHTML = `
    <div class="home-hero">
      <div class="home-hero-text">
        <div class="home-hello">${_greeting()},</div>
        <div class="home-name">${escapeHtml(currentUser?.username || '')}</div>
        <div class="home-sub">${escapeHtml(roleLabel)} · ${greg}${hij ? ' · ' + hij : ''}</div>
      </div>
      <div class="home-hero-logo"><img src="/meena_logo_transparent.png" alt="Meena"></div>
    </div>
    <div class="home-section-label">Needs your attention</div>
    <div id="home-kpis" class="kpi-grid"></div>`;

  let d;
  try { d = await API.get('/dashboard'); }
  catch (e) {
    document.getElementById('home-kpis').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠️</div><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }

  const ct = d.cases_today || {};
  const casesDone = (ct.total && ct.submitted >= ct.total);
  const isReviewer = ['manager', 'superadmin'].includes(d.role);
  const cards = [];
  if (isReviewer) cards.push(kpiCard('Schedules to review', d.pending_reviews, scheduleIco(), '#6B4EFF', 'review', d.pending_reviews > 0));
  if (['manager', 'superadmin', 'admin'].includes(d.role)) {
    cards.push(kpiCard('Leave requests', d.pending_leaves, leaveIco(), '#00A87D', 'leaves', d.pending_leaves > 0));
    cards.push(kpiCard('New registrations', d.pending_registrations || 0, regIco(), '#8B76FF', 'staff', (d.pending_registrations || 0) > 0));
  }
  cards.push(kpiCard('Swaps awaiting you', d.pending_swaps, swapIco(), '#FFA73C', 'swaps', d.pending_swaps > 0));
  document.getElementById('home-kpis').innerHTML = cards.join('');

  // Today's cases progress card (its own row below the KPIs).
  if (ct.total) {
    const pct = ct.total ? Math.round((ct.submitted / ct.total) * 100) : 0;
    const block = document.createElement('div');
    block.className = 'home-cases';
    block.onclick = () => showPage('cases');
    block.innerHTML = `
      <div class="home-cases-head">
        <div>
          <div class="home-cases-title">${casesDone ? '✅ Today\'s cases complete' : '📊 Today\'s cases'}</div>
          <div class="home-cases-sub">${ct.submitted} of ${ct.total} branches submitted${casesDone ? '' : ' — ' + (ct.total - ct.submitted) + ' pending'}</div>
        </div>
        <div class="home-cases-pct">${pct}%</div>
      </div>
      <div class="home-bar"><div class="home-bar-fill ${casesDone ? 'done' : ''}" style="width:${pct}%"></div></div>`;
    document.getElementById('content').appendChild(block);
  }
}

function kpiCard(label, value, icon, color, link, alert) {
  return `<button class="kpi-card${alert ? ' kpi-alert' : ''}" onclick="showPage('${link}')">
      <div class="kpi-top">
        <span class="kpi-ico" style="background:${color}1a;color:${color}">${icon}</span>
        ${alert ? '<span class="kpi-dot"></span>' : ''}
      </div>
      <div class="kpi-val">${value}</div>
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-link">View →</div>
    </button>`;
}

// Inline SVG icons (stroke = currentColor so they pick up the chip colour).
function _svg(p) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`; }
function scheduleIco() { return _svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4"/>'); }
function leaveIco()    { return _svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'); }
function swapIco()     { return _svg('<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'); }
function regIco()      { return _svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>'); }
