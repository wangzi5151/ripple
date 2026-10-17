const CACHE = 'ripple-shell-v1';
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/styles/tokens.css',
  '/styles/base.css',
  '/styles/board.css',
  '/styles/mobile.css',
  '/js/app.js',
  '/js/crdt/hlc.js',
  '/js/crdt/fractional.js',
  '/js/crdt/ops.js',
  '/js/crdt/doc.js',
  '/js/crdt/text.js',
  '/js/crdt/board.js',
  '/js/sync/protocol.js',
  '/js/sync/crypto.js',
  '/js/sync/storage.js',
  '/js/sync/engine.js',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put('/', copy));
        return response;
      }).catch(async () => (await caches.match('/')) || Response.error()),
    );
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
