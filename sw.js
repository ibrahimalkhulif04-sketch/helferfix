const CACHE_NAME = 'helferfix-shell-v1';
const SHELL = ['/', '/styles.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && (url.pathname === '/' || SHELL.includes(url.pathname))) {
      const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (url.pathname === '/' ? caches.match('/') : undefined)));
});
