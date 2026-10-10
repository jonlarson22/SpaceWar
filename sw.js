// Space War service worker. Bump CACHE_VERSION on every static-asset change
// or phones will keep serving stale files indefinitely.
const CACHE_VERSION = 'spacewar-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/main.js',
  './js/firebase.js',
  './js/hex.js',
  './js/sprites.js',
  './js/board.js',
  './js/state.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/sprites/federation.png',
  './assets/sprites/klingon.png',
  './assets/sprites/borg.png',
  './assets/sprites/dominion.png',
  './assets/sprites/tholian.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp.ok && new URL(event.request.url).origin === self.location.origin) {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        }
        return resp;
      });
    })
  );
});
