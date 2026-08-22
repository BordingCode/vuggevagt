// Vuggevagt service worker. Cache-first for our own files so the app opens
// instantly and keeps working if the Wi-Fi hiccups; the signalling server is
// never cached.
const CACHE = 'vuggevagt-v8';
const ASSETS = [
  '.', 'index.html', 'manifest.json',
  'css/main.css?v=1',
  'js/main.js?v=8', 'js/store.js', 'js/signal.js', 'js/peer.js', 'js/meter.js', 'js/alarm.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;           // never touch the signalling server
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => hit))
  );
});
