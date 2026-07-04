// ── In-app notifications ──────────────────────────────────────────────────────
let _notifications = [];
let _notifPollTimer = null;

async function loadNotifications() {
  try {
    const data = await API.get('/notifications');
    _notifications = data.notifications || [];
    renderNotifBadge(data.unread || 0);
  } catch (e) { /* stay quiet on transient errors */ }
}

function startNotifPolling() {
  loadNotifications();
  if (_notifPollTimer) clearInterval(_notifPollTimer);
  // Refresh every 60s so hand-offs (submit/review/approve, leave, swaps) surface.
  _notifPollTimer = setInterval(loadNotifications, 60000);
}

function renderNotifBadge(unread) {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  if (unread > 0) {
    badge.textContent = unread > 99 ? '99+' : unread;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  if (!panel) return;
  if (panel.classList.contains('open')) { panel.classList.remove('open'); return; }
  renderNotifList();
  panel.classList.add('open');            // CSS animates it in/out
}

function notifTimeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso + 'Z'); // server sends UTC without tz
  const secs = Math.max(0, (Date.now() - then.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs/60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs/3600)}h ago`;
  return `${Math.floor(secs/86400)}d ago`;
}

const NOTIF_ICON = {
  review: '📤', submitted: '📤', approved: '✅', reviewed: '👀',
  returned: '↩️', rejected: '⛔', leave: '🌴', swap: '🔄', info: '🔔',
  reminder: '⏰',
};

function renderNotifList() {
  const list = document.getElementById('notif-list');
  if (!list) return;
  if (!_notifications.length) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px">No notifications yet</div>`;
    return;
  }
  list.innerHTML = _notifications.map(n => `
    <div class="notif-item${n.is_read ? '' : ' unread'}" onclick="openNotification(${n.id}, '${jsAttr(n.link || '')}')">
      <span class="notif-ico">${NOTIF_ICON[n.type] || '🔔'}</span>
      <div style="flex:1;min-width:0">
        <div class="notif-msg">${escapeHtml(n.message)}</div>
        <div class="notif-time">${notifTimeAgo(n.created_at)}</div>
      </div>
      ${n.is_read ? '' : '<span class="notif-dot"></span>'}
    </div>`).join('');
}

async function openNotification(id, link) {
  const n = _notifications.find(x => x.id === id);
  if (n && !n.is_read) {
    n.is_read = true;
    try { await API.put(`/notifications/${id}/read`); } catch (e) {}
    renderNotifBadge(_notifications.filter(x => !x.is_read).length);
  }
  document.getElementById('notif-panel').classList.remove('open');
  if (link && typeof showPage === 'function') showPage(link);
}

async function markAllNotifsRead() {
  try { await API.put('/notifications/read-all'); } catch (e) {}
  _notifications.forEach(n => n.is_read = true);
  renderNotifBadge(0);
  renderNotifList();
}

// Close the panel when clicking outside of it.
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notif-panel');
  const bell  = document.getElementById('notif-bell');
  if (panel && panel.classList.contains('open') &&
      !panel.contains(e.target) && bell && !bell.contains(e.target)) {
    panel.classList.remove('open');
  }
});
