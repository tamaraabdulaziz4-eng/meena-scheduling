// Meena Health service worker.
//  • Web Push notifications (even when the app is closed).
//  • Offline support: runtime-caches the app shell so the installed app opens
//    without a connection after the first online visit.
const CACHE = 'meena-v44';
const CORE = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png',
              '/apple-touch-icon.png', '/meena_logo.png', '/meena_logo_transparent.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CORE).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));  // drop old versions
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // never touch writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // let cross-origin (fonts) hit network
  if (url.pathname.startsWith('/api/')) return;           // data must always be fresh — no caching

  // Navigations: network-first, fall back to the cached app shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(res => {
        // Only cache the real app shell ('/'), and only a good (2xx) response.
        // Previously EVERY navigation was stored under '/', so opening a public
        // page (e.g. /reports-public.html) or hitting an error page overwrote
        // the shell and broke the next offline launch.
        if (url.pathname === '/' && res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('/', copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('/')))
    );
    return;
  }

  // Static assets (js/css/img, including versioned ?v= URLs): cache-first, then
  // network — and cache what we fetch so the next offline load has it.
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => cached))
  );
});

// ── Web Push ──────────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Meena Health';
  const link = data.link || 'home';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    dir: 'auto',
    lang: 'ar',
    tag: data.tag || ('meena-' + Date.now()),
    renotify: true,
    data: { link },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || 'home';
  const url = '/?p=' + encodeURIComponent(link);
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { c.postMessage({ type: 'notif-nav', link }); } catch (e) {} return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
