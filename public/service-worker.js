self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'HelferFix';
  const options = { body: data.body || 'Du hast eine neue Benachrichtigung.', data: { url: data.url || '/' }, tag: data.kind && data.rideId ? `${data.kind}-${data.rideId}` : 'helferfix-notice', renotify: false };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) { if (client.url.startsWith(self.location.origin) && 'focus' in client) return client.focus(); }
    return clients.openWindow ? clients.openWindow(target) : undefined;
  }));
});
self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
