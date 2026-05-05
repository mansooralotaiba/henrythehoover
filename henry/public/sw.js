// Service Worker — handles Web Push notifications when the browser is closed.
// Registered from index.html via navigator.serviceWorker.register('/sw.js').

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Henry', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Henry The Hoover';
  const opts = {
    body: data.body || '',
    icon: data.icon || '/manifest.json',
    badge: data.badge || '/manifest.json',
    vibrate: [200, 100, 200],
    tag: data.tag || 'henry-alert',
    data: data.data || {},
    actions: [
      { action: 'open', title: 'Open Henry' },
    ],
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes(self.location.origin)) return w.focus();
      }
      return clients.openWindow(url);
    })
  );
});
