self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = typeof data.title === 'string' && data.title ? data.title : 'HelferFix';
  const eventTag = data.notificationId ? `notice-${data.notificationId}` : (data.kind && data.rideId ? `${data.kind}-${data.rideId}` : 'helferfix-notice');
  const options = {
    body: typeof data.body === 'string' ? data.body : 'Du hast eine neue Benachrichtigung.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: typeof data.url === 'string' ? data.url : '/' },
    tag: eventTag,
    renotify: false
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const rawUrl = event.notification.data && event.notification.data.url || '/';
  const target = new URL(rawUrl, self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
    for (const client of list) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        await client.focus();
        if ('navigate' in client && client.url !== target.href) await client.navigate(target.href);
        return;
      }
    }
    if (clients.openWindow) return clients.openWindow(target.href);
  }));
});

self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
