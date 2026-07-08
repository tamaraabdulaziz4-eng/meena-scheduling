// ── Web Push: browser notifications, including when the app is closed ─────────

let _pushReg = null;          // active ServiceWorkerRegistration
let _pushVapid = null;        // cached server VAPID public key

// ── Auto-apply new deploys ────────────────────────────────────────────────────
// The service worker serves cached assets, so a new deploy used to need TWO reloads
// (first reload updates the worker in the background; the page kept running old JS).
// Register the worker unconditionally on EVERY page (not just when push is enabled),
// proactively check for a new version, and reload ONCE the moment a new worker takes
// control — so a deploy shows up on the next normal reload, no hard-refresh needed.
(function autoUpdateSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;   // returning visitor?
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Reload only on an UPDATE (a worker was already in control) — not on the very
    // first install, where the page is already running the latest assets.
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
  const check = (reg) => { try { reg && reg.update(); } catch (e) {} };
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    check(reg);
    setInterval(() => check(reg), 60000);        // catch a deploy while the tab stays open
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(reg); });
  }).catch(() => {});
})();

function pushSupported() {
  return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
}

function _urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// Register the service worker early so push (and notification taps) work.
async function initPush() {
  if (!pushSupported()) { _renderPushRow('unsupported'); return; }
  try {
    _pushReg = await navigator.serviceWorker.register('/sw.js');
  } catch (e) { _renderPushRow('unsupported'); return; }
  // Let a notification tap navigate the open tab.
  navigator.serviceWorker.addEventListener('message', ev => {
    if (ev.data && ev.data.type === 'notif-nav' && ev.data.link && typeof showPage === 'function') {
      showPage(ev.data.link);
    }
  });
  await refreshPushState();
}

async function refreshPushState() {
  if (!_pushReg) { _renderPushRow('unsupported'); return; }
  try {
    const sub = await _pushReg.pushManager.getSubscription();
    if (Notification.permission === 'denied') _renderPushRow('denied');
    else if (sub) _renderPushRow('on');
    else _renderPushRow('off');
  } catch (e) { _renderPushRow('off'); }
}

function _renderPushRow(state) {
  const row = document.getElementById('notif-push-row');
  const btn = document.getElementById('notif-push-btn');
  const sub = document.getElementById('notif-push-sub');
  if (!row || !btn) return;
  row.style.display = 'flex';
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (state === 'unsupported') {
    if (iOS && !standalone) {
      sub.textContent = 'On iPhone: Share → Add to Home Screen, then open from there.';
      btn.style.display = 'none';
    } else { row.style.display = 'none'; }
    return;
  }
  btn.style.display = '';
  const testBtn = document.getElementById('notif-push-test');
  if (testBtn) testBtn.style.display = (state === 'on') ? '' : 'none';
  if (state === 'on')      { btn.textContent = 'On';      btn.classList.remove('btn-primary'); btn.classList.add('btn-ghost'); sub.textContent = 'You’ll get alerts on this device.'; }
  else if (state === 'denied') { btn.textContent = 'Blocked'; btn.disabled = true; sub.textContent = 'Notifications are blocked in your browser settings.'; }
  else                     { btn.textContent = 'Enable';  btn.classList.add('btn-primary'); btn.classList.remove('btn-ghost'); sub.textContent = 'Get alerts even when the app is closed.'; }
}

async function sendTestPush() {
  try {
    const r = await API.post('/push/test', {});
    if (!r.count) { if (typeof toast === 'function') toast(r.hint || 'No device registered', 'err'); return; }
    const ok = r.ok || 0;
    if (ok > 0) { if (typeof toast === 'function') toast('Test sent — check your notifications'); }
    else {
      const first = (r.results && r.results[0]) || {};
      if (typeof toast === 'function') toast('Push rejected (' + (first.status || '?') + '). ' + (first.detail || ''), 'err');
    }
    if (typeof loadNotifications === 'function') loadNotifications();
  } catch (e) { if (typeof toast === 'function') toast(e.message || 'Test failed', 'err'); }
}

async function togglePush() {
  if (!_pushReg) { if (typeof toast === 'function') toast('Notifications not supported here', 'err'); return; }
  const sub = await _pushReg.pushManager.getSubscription();
  if (sub) return disablePush();
  return enablePush();
}

async function enablePush() {
  const btn = document.getElementById('notif-push-btn');
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { await refreshPushState(); return; }
    if (!_pushVapid) {
      const r = await API.get('/push/vapid');
      _pushVapid = r.public_key;
    }
    const sub = await _pushReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlB64ToUint8(_pushVapid),
    });
    const j = sub.toJSON();
    await API.post('/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
    if (typeof toast === 'function') toast('Device notifications enabled');
  } catch (e) {
    if (typeof toast === 'function') toast(e.message || 'Could not enable notifications', 'err');
  }
  await refreshPushState();
}

async function disablePush() {
  try {
    const sub = await _pushReg.pushManager.getSubscription();
    if (sub) {
      const ep = sub.endpoint;
      await sub.unsubscribe();
      try { await API.post('/push/unsubscribe', { endpoint: ep }); } catch (e) {}
    }
    if (typeof toast === 'function') toast('Device notifications turned off');
  } catch (e) {}
  await refreshPushState();
}
