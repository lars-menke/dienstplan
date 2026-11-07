// Die Testversion unter beta/ ist freigegeben und wurde zur normalen App.
// Dieser Service Worker räumt nur noch auf: Er löscht den Beta-Speicher,
// meldet sich selbst ab und leitet noch offene Beta-Fenster zur App um.
// Kann in ein paar Wochen zusammen mit beta/index.html gelöscht werden.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('dienstplan-beta-')).map(k => caches.delete(k)));
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window' });
    windows.forEach(w => w.navigate(new URL('../', self.registration.scope).href).catch(() => {}));
  })());
});
