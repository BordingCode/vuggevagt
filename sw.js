// Vuggevagt has moved into Lull. This worker exists only to remove the old one:
// it deletes the old cache, unregisters itself and reloads open pages, so a
// phone that installed the old app lands on the "moved" page instead.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('vuggevagt')) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
  })());
});
