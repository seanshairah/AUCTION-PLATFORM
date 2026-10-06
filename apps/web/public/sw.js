/*
 * ABC Auctions service worker: lite mode for weak connections.
 * - Static assets and photos: served from cache, refreshed in the background.
 * - Pages: network first; on failure, the last copy seen, else the offline page.
 * - Never caches the API, the account area or anything that moves money.
 */
const VERSION = 'abc-v1';
const OFFLINE = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll([OFFLINE, '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/account') || url.pathname.startsWith('/sign-in')) return;

  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/media/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || fresh;
      }),
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => { if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone())); return res; })
        .catch(async () => (await caches.match(req)) || (await caches.match(OFFLINE))),
    );
  }
});
