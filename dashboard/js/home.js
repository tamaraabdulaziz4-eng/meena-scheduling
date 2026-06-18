// ── Home dashboard ────────────────────────────────────────────────────────────
// Clean overview centred on TODAY'S CASES, with a compact action strip.

function _greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

async function renderHomePage() {
  setTopbar('Home', 'Your overview at a glance');
  const today = new Date();
  const greg = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const date = (typeof operationalDate === 'function') ? operationalDate() : fmtDate(today);

  document.getElementById('content').innerHTML = `
    <div class="hm-greet">
      <div>
        <div class="hm-hi">${_greeting()}, <b>${escapeHtml(currentUser?.username || '')}</b></div>
        <div class="hm-date">${greg}</div>
      </div>
    </div>
    <div id="hm-actions" class="hm-actions"></div>
    <div class="hm-card">
      <div class="hm-card-head">
        <div class="hm-card-title">📊 Today's cases</div>
        <div class="hm-card-meta" id="hm-cases-meta"></div>
      </div>
      <div class="home-bar"><div class="home-bar-fill" id="hm-bar" style="width:0%"></div></div>
      <div id="hm-cases-list" class="hm-branch-list"><div class="hm-muted">Loading…</div></div>
    </div>`;

  // Action counters (compact) + per-branch cases in parallel.
  const [dash, ov] = await Promise.all([
    API.get('/dashboard').catch(() => null),
    API.get(`/daily-cases/overview?date=${date}`).catch(() => null),
  ]);
  renderHomeActions(dash);
  renderHomeCases(ov);
}

function renderHomeActions(d) {
  const box = document.getElementById('hm-actions');
  if (!box || !d) { if (box) box.innerHTML = ''; return; }
  const items = [];
  if (['manager', 'superadmin'].includes(d.role)) items.push(['Reviews', d.pending_reviews, 'review']);
  if (['manager', 'superadmin', 'admin'].includes(d.role)) {
    items.push(['Leave', d.pending_leaves, 'leaves']);
    items.push(['Registrations', d.pending_registrations || 0, 'staff']);
  }
  items.push(['Swaps', d.pending_swaps, 'swaps']);
  box.innerHTML = items.map(([label, n, link]) => `
    <button class="hm-chip${n > 0 ? ' on' : ''}" onclick="showPage('${link}')">
      <span class="hm-chip-n">${n}</span>
      <span class="hm-chip-l">${label}</span>
    </button>`).join('');
}

function renderHomeCases(ov) {
  const list = document.getElementById('hm-cases-list');
  const meta = document.getElementById('hm-cases-meta');
  const bar  = document.getElementById('hm-bar');
  if (!ov || !list) { if (list) list.innerHTML = `<div class="hm-muted">Couldn't load today's cases.</div>`; return; }
  const branches = ov.branches || [];
  const s = ov.summary || {};
  const total = branches.length;
  const submitted = branches.filter(b => b.case && b.case.locked).length;
  const pct = total ? Math.round((submitted / total) * 100) : 0;
  if (bar) { bar.style.width = pct + '%'; bar.classList.toggle('done', total && submitted >= total); }
  if (meta) meta.innerHTML = `<b>${submitted}/${total}</b> submitted · ${s.total_cases || 0} cases · ${s.total_pt || 0} patients`;
  if (!total) { list.innerHTML = `<div class="hm-muted">No branches yet.</div>`; return; }
  list.innerHTML = branches.map(b => {
    const c = b.case, done = c && c.locked;
    return `<div class="hm-branch" onclick="showPage('cases')">
      <span class="hm-branch-name">${escapeHtml(b.branch_name)}</span>
      ${done
        ? `<span class="hm-branch-cases">${c.total_cases} cases · ${c.total_pt || 0} pt</span>
           <span class="hm-pill ok">Submitted</span>`
        : `<span class="hm-branch-cases hm-muted">—</span>
           <span class="hm-pill wait">Pending</span>`}
    </div>`;
  }).join('');
}
