// ── Home dashboard ────────────────────────────────────────────────────────────
// At-a-glance KPIs for managers / team leads: what needs action + today's cases.

async function renderHomePage() {
  const name = currentUser?.username || '';
  const today = new Date();
  const greg = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hij = (typeof hijriFull === 'function') ? hijriFull(today.getFullYear(), today.getMonth() + 1, today.getDate()) : '';
  setTopbar('Home', `${greg}${hij ? ' · ' + hij : ''}`);
  const c = document.getElementById('content');
  c.innerHTML = `<div id="home-kpis" class="kpi-grid">
      <div class="empty"><div class="empty-icon">⏳</div><p>Loading…</p></div>
    </div>`;
  let d;
  try { d = await API.get('/dashboard'); }
  catch (e) { document.getElementById('home-kpis').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠️</div><p>${escapeHtml(e.message)}</p></div>`; return; }

  const ct = d.cases_today || {};
  const casesDone = (ct.total && ct.submitted >= ct.total);
  const cards = [];
  if (['manager', 'superadmin'].includes(d.role)) {
    cards.push(kpiCard('Pending reviews', d.pending_reviews, '📤', 'review', d.pending_reviews > 0));
  }
  if (['manager', 'superadmin', 'admin'].includes(d.role)) {
    cards.push(kpiCard('Pending leave', d.pending_leaves, '🌴', 'leaves', d.pending_leaves > 0));
    cards.push(kpiCard('New registrations', d.pending_registrations || 0, '🧾', 'staff', (d.pending_registrations || 0) > 0));
  }
  cards.push(kpiCard('Swaps need you', d.pending_swaps, '🔄', 'swaps', d.pending_swaps > 0));
  if (ct.total) {
    cards.push(kpiCard('Today\'s cases', `${ct.submitted}/${ct.total}`, casesDone ? '✅' : '📊',
      'cases', !casesDone, casesDone ? 'all submitted' : 'branches submitted'));
  }
  document.getElementById('home-kpis').innerHTML = cards.join('');
}

function kpiCard(label, value, icon, link, alert, sub) {
  return `<button class="kpi-card${alert ? ' kpi-alert' : ''}" onclick="showPage('${link}')">
      <div class="kpi-ico">${icon}</div>
      <div class="kpi-val">${value}</div>
      <div class="kpi-label">${escapeHtml(label)}</div>
      ${sub ? `<div class="kpi-sub">${escapeHtml(sub)}</div>` : ''}
    </button>`;
}
