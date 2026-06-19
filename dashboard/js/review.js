// ── Manager Review page ───────────────────────────────────────────────────────
let reviewYear  = new Date().getFullYear();
let reviewMonth = new Date().getMonth() + 1;
let reviewFilter = 'all';
let reviewData   = { branches: [], summary: {} };

const STATUS_META = {
  submitted:     { label: 'Pending review', cls: 'pending'  },
  reviewed:      { label: 'Pending review', cls: 'pending'  },
  approved:      { label: 'Approved',       cls: 'approved' },
  not_submitted: { label: 'Not submitted',  cls: 'notsub'   },
  draft:         { label: 'Draft',          cls: 'draft'    },
  returned:      { label: 'Returned',       cls: 'returned' },
};

async function renderReviewPage() {
  setTopbar('Review', '', '');
  const c = document.getElementById('content');
  c.innerHTML = `
    ${pageHero('Approve or return schedules across all branches', 'Schedule Review')}
    <div class="review-kpis" id="review-kpis"></div>
    <div class="review-filters">
      <div class="month-nav" style="margin:0">
        <button onclick="changeReviewMonth(-1)">&#8249;</button>
        <span class="month-label" id="review-month-label"></span>
        <button onclick="changeReviewMonth(1)">&#8250;</button>
      </div>
      <div class="seg" id="review-seg">
        <button data-f="all" class="on">All</button>
        <button data-f="pending">Pending</button>
        <button data-f="not_submitted">Not submitted</button>
        <button data-f="approved">Approved</button>
      </div>
    </div>
    <div class="review-list" id="review-list"></div>`;

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
    { v: s.pending || 0,       l: 'Pending review', c: 'o' },
    { v: s.not_submitted || 0, l: 'Not submitted',  c: 'r' },
    { v: s.approved || 0,      l: 'Approved',        c: 'g' },
    { v: s.total || 0,         l: 'Total branches',  c: 'b' },
  ];
  document.getElementById('review-kpis').innerHTML = kpis.map(k => `
    <div class="review-kpi ${k.c}">
      <div class="v">${k.v}</div><div class="l">${k.l}</div>
    </div>`).join('');
}

function renderReviewList() {
  const list = document.getElementById('review-list');
  let items = reviewData.branches || [];
  if (reviewFilter === 'pending')       items = items.filter(b => ['submitted','reviewed'].includes(b.status));
  else if (reviewFilter === 'not_submitted') items = items.filter(b => b.status === 'not_submitted');
  else if (reviewFilter === 'approved') items = items.filter(b => b.status === 'approved');

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
        <button class="btn review" onclick="openReviewSchedule(${b.branch_id})">Review</button>
        <button class="btn approve" onclick="reviewAction(${b.schedule_id}, 'approved')">Approve</button>
        <button class="btn return" onclick="reviewAction(${b.schedule_id}, 'returned')">Return</button>`;
    } else if (b.status === 'approved') {
      // Already approved but the team wants to change something — reopen it
      // (unlocks it and sends it back to the team lead for edits).
      actions = `
        <button class="btn review" onclick="openReviewSchedule(${b.branch_id})">View</button>
        <button class="btn return" onclick="reviewAction(${b.schedule_id}, 'returned')">↩ Reopen</button>`;
    } else if (b.status === 'not_submitted') {
      actions = `<button class="btn review" onclick="openReviewSchedule(${b.branch_id})">Open</button>`;
    } else {
      actions = `<button class="btn review" onclick="openReviewSchedule(${b.branch_id})">View</button>`;
    }
    return `
      <div class="review-row">
        <div>
          <div class="branch">${escapeHtml(b.branch_name)}</div>
          <div class="meta">${b.staff_count || 0} staff${submitted ? ` · ${b.shift_count || 0} shifts` : ''}</div>
        </div>
        <div class="grow"></div>
        <div class="who">${who}${when ? `<br>${when}` : ''}</div>
        <span class="rbadge ${meta.cls}">${meta.label}</span>
        <div class="ractions">${actions}</div>
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

// small helper
function timeAgo(ts) {
  const d = new Date(ts); const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff/60))}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}
