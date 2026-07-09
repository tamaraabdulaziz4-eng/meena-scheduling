// ── Manager Review page ───────────────────────────────────────────────────────
let reviewYear  = new Date().getFullYear();
let reviewMonth = new Date().getMonth() + 1;
let reviewFilter = 'all';
let reviewData   = { branches: [], summary: {} };

// Clinical Calm pill per schedule state (rejected-like states → red chip).
const STATUS_META = {
  submitted:     { html: '<span class="ris progress"><span class="rd"></span>Pending review</span>' },
  reviewed:      { html: '<span class="ris progress"><span class="rd"></span>Pending review</span>' },
  approved:      { html: '<span class="ris final"><span class="rd"></span>Approved</span>' },
  not_submitted: { html: '<span class="sc no">✕ Not submitted</span>' },
  draft:         { html: '<span class="ris scheduled"><span class="rd"></span>Draft</span>' },
  returned:      { html: '<span class="sc warn">↩ Returned</span>' },
};

async function renderReviewPage() {
  setTopbar('Review', '', '');
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="cc">
    ${pageHero('Approve or return schedules across all branches', 'Schedule Review')}
    <div class="kpis" id="review-kpis"></div>
    <div class="review-filters">
      <div class="month-nav" style="margin:0">
        <button onclick="changeReviewMonth(-1)">&#8249;</button>
        <span class="month-label" id="review-month-label"></span>
        <button onclick="changeReviewMonth(1)">&#8250;</button>
      </div>
      <div class="tabs" id="review-seg">
        <button data-f="all" class="tab on">All</button>
        <button data-f="pending" class="tab">Pending</button>
        <button data-f="not_submitted" class="tab">Not submitted</button>
        <button data-f="approved" class="tab">Approved</button>
      </div>
    </div>
    <div class="board">
      <div class="bhead">
        <div class="bhrow">
          <div class="btitle">Branch schedules <span id="review-board-sub"></span></div>
        </div>
      </div>
      <div class="rows" id="review-list"></div>
    </div>
    </div>`;

  document.getElementById('review-month-label').textContent = monthLabel(reviewYear, reviewMonth);
  document.querySelectorAll('#review-seg button').forEach(b => {
    b.onclick = () => {
      reviewFilter = b.dataset.f;
      document.querySelectorAll('#review-seg button').forEach(x => x.classList.toggle('on', x === b));
      renderReviewList();
    };
  });
  await loadReviewData();
}

async function changeReviewMonth(delta) {
  reviewMonth += delta;
  if (reviewMonth > 12) { reviewMonth = 1; reviewYear++; }
  if (reviewMonth < 1)  { reviewMonth = 12; reviewYear--; }
  document.getElementById('review-month-label').textContent = monthLabel(reviewYear, reviewMonth);
  await loadReviewData();
}

async function loadReviewData() {
  const list = document.getElementById('review-list');
  if (list) list.innerHTML = LOADING_HTML;
  try {
    reviewData = await API.get(`/schedules/review-overview?year=${reviewYear}&month=${reviewMonth}`);
    renderReviewKpis();
    renderReviewList();
    updateReviewBadge();
    animateIn('review-list');
  } catch (e) {
    if (list) list.innerHTML =
      `<div class="empty"><div class="empty-icon">⚠️</div><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderReviewKpis() {
  const s = reviewData.summary || {};
  const kpis = [
    { v: s.pending || 0,       l: 'Pending review', sub: 'Awaiting your action', a: 'a', dot: 'var(--amber,#F59E0B)' },
    { v: s.not_submitted || 0, l: 'Not submitted',  sub: 'No rota yet',          a: 'b', dot: 'var(--blue,#3BA0FF)' },
    { v: s.approved || 0,      l: 'Approved',       sub: 'Signed off',           a: 'c', dot: 'var(--green,#00C896)' },
    { v: s.total || 0,         l: 'Total branches', sub: monthLabel(reviewYear, reviewMonth), a: 'd', dot: 'var(--violet,#6B4EFF)' },
  ];
  document.getElementById('review-kpis').innerHTML = kpis.map(k => `
    <div class="kpi ${k.a}">
      <div class="kl"><span class="kd" style="background:${k.dot}"></span>${k.l}</div>
      <div class="kv">${k.v}</div>
      <div class="kt">${escapeHtml(k.sub)}</div>
    </div>`).join('');
}

function renderReviewList() {
  const list = document.getElementById('review-list');
  let items = reviewData.branches || [];
  if (reviewFilter === 'pending')       items = items.filter(b => ['submitted','reviewed'].includes(b.status));
  else if (reviewFilter === 'not_submitted') items = items.filter(b => b.status === 'not_submitted');
  else if (reviewFilter === 'approved') items = items.filter(b => b.status === 'approved');

  const sub = document.getElementById('review-board-sub');
  if (sub) sub.textContent = `${monthLabel(reviewYear, reviewMonth)} · ${items.length} branch${items.length !== 1 ? 'es' : ''}`;

  if (!items.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">📭</div><p>No schedules in this view</p></div>`;
    return;
  }

  list.innerHTML = items.map(b => {
    const meta = STATUS_META[b.status] || STATUS_META.draft;
    const submitted = ['submitted','reviewed','approved'].includes(b.status);
    const when = b.updated_at ? timeAgo(b.updated_at) : '';
    const who  = b.created_by_name ? `By <b>${escapeHtml(b.created_by_name)}</b>` : '—';
    let actions = '';
    if (b.status === 'submitted' || b.status === 'reviewed') {
      actions = `
        <button class="ghost" onclick="openReviewSchedule(${b.branch_id})">Review</button>
        <button class="open" onclick="reviewAction(${b.schedule_id}, 'approved')">Approve</button>
        <button class="ghost" onclick="reviewAction(${b.schedule_id}, 'returned')" style="color:var(--danger,#E63946)">Return</button>`;
    } else if (b.status === 'approved') {
      // Already approved but the team wants to change something — reopen it
      // (unlocks it and sends it back to the team lead for edits).
      actions = `
        <button class="ghost" onclick="openReviewSchedule(${b.branch_id})">View</button>
        <button class="ghost" onclick="reviewAction(${b.schedule_id}, 'returned')">↩ Reopen</button>`;
    } else if (b.status === 'not_submitted') {
      actions = `<button class="ghost" onclick="openReviewSchedule(${b.branch_id})">Open</button>`;
    } else {
      actions = `<button class="ghost" onclick="openReviewSchedule(${b.branch_id})">View</button>`;
    }
    return `
      <div class="lrow">
        <div style="flex:2;min-width:150px">
          <div style="font-weight:700">${escapeHtml(b.branch_name)}</div>
          <div style="font-size:11.5px;color:var(--muted)">${b.staff_count || 0} staff${submitted ? ` · ${b.shift_count || 0} shifts` : ''}</div>
        </div>
        <div style="flex:1.5;min-width:120px;font-size:12px;color:var(--muted)">${who}${when ? `<br>${when}` : ''}</div>
        <div style="flex:none">${meta.html}</div>
        <div style="display:flex;gap:6px;white-space:nowrap;flex:none">${actions}</div>
      </div>`;
  }).join('');
}

// Open the schedule in the normal Schedule page for this branch/month
async function openReviewSchedule(branchId) {
  window._pendingScheduleBranch = branchId;
  scheduleYear  = reviewYear;
  scheduleMonth = reviewMonth;
  await showPage('schedule');
}

async function reviewAction(scheduleId, status) {
  if (!scheduleId) { toast('No schedule to act on', 'err'); return; }
  let note = null;
  if (status === 'returned') {
    note = prompt('Add a note for the team lead (optional):') || '';
  }
  showLoader(status === 'approved' ? 'Approving…' : status === 'reviewed' ? 'Marking reviewed…' : 'Returning…');
  try {
    await API.put(`/schedules/${scheduleId}/status`, { status, note });
    await loadReviewData();
    toast(status === 'approved' ? 'Schedule approved' : status === 'reviewed' ? 'Marked as reviewed' : 'Returned for edits');
  } catch (e) { toast(e.message, 'err'); }
  finally { hideLoader(); }
}

function updateReviewBadge() {
  const badge = document.getElementById('review-badge');
  if (!badge) return;
  const n = (reviewData.summary && reviewData.summary.pending) || 0;
  if (n > 0) { badge.textContent = n; badge.style.display = 'inline-block'; }
  else badge.style.display = 'none';
}

// Lightweight badge loader used at login (doesn't render the whole page)
async function loadReviewBadgeCount() {
  try {
    const y = new Date().getFullYear(), m = new Date().getMonth() + 1;
    const data = await API.get(`/schedules/review-overview?year=${y}&month=${m}`);
    const badge = document.getElementById('review-badge');
    if (!badge) return;
    const n = (data.summary && data.summary.pending) || 0;
    if (n > 0) { badge.textContent = n; badge.style.display = 'inline-block'; }
    else badge.style.display = 'none';
  } catch (e) { /* silent */ }
}
