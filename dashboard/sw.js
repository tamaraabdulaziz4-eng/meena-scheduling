// Meena Health service worker — shows browser notifications from Web Push,
// even when the app tab is closed.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Meena Health';
  const link = data.link || 'home';
  const options = {
    body: data.body || '',
    icon: '/meena_logo_transparent.png',
    badge: '/meena_logo_transparent.png',
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
