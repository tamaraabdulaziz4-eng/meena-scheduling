// ── Web Push: browser notifications, including when the app is closed ─────────

let _pushReg = null;          // active ServiceWorkerRegistration
let _pushVapid = null;        // cached server VAPID public key

// ── Auto-apply new deploys ────────────────────────────────────────────────────
// Detect a new deploy by comparing the build id baked into THIS page (meta meena-build)
// against the server's current build (/api/build). This does not rely on the frozen
// hadController flag (which left a first-session tab running old JS against a new backend
// forever) and never yanks the page out from under an operator mid-task: it reloads
// immediately only when the tab is hidden, otherwise it offers a non-destructive
// "reload" banner and reloads on the next time the tab is hidden.
(function autoUpdateSW() {
  if (!('serviceWorker' in navigator)) return;
  const meta = document.querySelector('meta[name="meena-build"]');
  const LOADED = meta ? (meta.getAttribute('content') || '') : '';
  let reloading = false, pending = false;
  function doReload() { if (!reloading) { reloading = true; location.reload(); } }
  function showBanner() {
    if (pending || document.getElementById('sw-update-banner')) return;
    pending = true;
    const d = document.createElement('div');
    d.id = 'sw-update-banner';
    d.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;background:#12103a;color:#fff;padding:9px 12px 9px 15px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.32);font:600 13px -apple-system,system-ui,sans-serif;display:flex;gap:12px;align-items:center;max-width:92vw';
    d.innerHTML = '<span>A new version is available</span>';
    const b = document.createElement('button');
    b.textContent = 'Reload';
    b.style.cssText = 'background:#6B4EFF;color:#fff;border:none;padding:6px 13px;border-radius:9px;font:700 13px inherit;cursor:pointer';
    b.onclick = doReload;
    d.appendChild(b);
    document.body.appendChild(d);
  }
  function applyUpdate() {
    if (reloading) return;
    if (document.hidden) doReload();   // safe: no one is mid-task on a hidden tab
    else showBanner();                 // reloads on click or on the next hide
  }
  async function checkBuild() {
    if (!LOADED || reloading) return;
    try {
      const r = await fetch('/api/build', { cache: 'no-store' });
      const j = await r.json();
      if (j && j.build && j.build !== LOADED) applyUpdate();
    } catch (e) {}
  }
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    try { reg.update(); } catch (e) {}
    checkBuild();
    setInterval(() => { try { reg.update(); } catch (e) {} checkBuild(); }, 60000);
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', checkBuild);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (pending) doReload(); }   // finish a deferred update
    else checkBuild();
  });
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
