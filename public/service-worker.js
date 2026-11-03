// HelferFix background push worker. This file is served at /service-worker.js with scope /.
function decodeBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; }
    catch { data = { body: event.data ? event.data.text() : '' }; }

    const title = typeof data.title === 'string' && data.title ? data.title : 'HelferFix';
    const options = {
      body: typeof data.body === 'string' ? data.body : 'Du hast eine neue Benachrichtigung.',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: typeof data.url === 'string' ? data.url : '/' },
      tag: data.notificationId ? 'helferfix-notice-' + data.notificationId : 'helferfix-notice-' + Date.now(),
      renotify: false,
      timestamp: Date.now(),
      vibrate: [120, 60, 120]
    };

    await self.registration.showNotification(title, options);

    // Acknowledge chat delivery only after this device receives the push event.
    if (data.kind === 'message' && Number.isInteger(Number(data.notificationId))) {
      await fetch('/api/push/delivered', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationId: Number(data.notificationId) })
      }).catch(error => {
        console.warn('[push] chat delivery acknowledgement failed:', error && error.message || error);
      });
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const rawUrl = event.notification.data && event.notification.data.url || '/';
  const target = new URL(rawUrl, self.location.origin);
  if (target.origin !== self.location.origin) return;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (!client.url.startsWith(self.location.origin)) continue;
      if ('focus' in client) await client.focus();
      if ('navigate' in client && client.url !== target.href) await client.navigate(target.href);
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(target.href);
  })());
});

// Recover a subscription if the browser rotates its push endpoint.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const configResponse = await fetch('/api/push/public-key', {
      credentials: 'include',
      cache: 'no-store'
    });
    if (!configResponse.ok) return;
    const config = await configResponse.json();
    if (!config.enabled || !config.publicKey) return;

    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(config.publicKey)
    });
    await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON(), language: 'de' })
    });
  })().catch(error => {
    // A logged-out browser has no session; it can subscribe again on next sign-in.
    console.warn('[push] subscription recovery failed:', error && error.message || error);
  }));
});

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
