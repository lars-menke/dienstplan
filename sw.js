// Service Worker: hält die App-Dateien vor, damit sie schnell startet
// und auch ohne Netz öffnet. Termine kommen immer frisch vom Server.
// Bei jeder Änderung an den App-Dateien die Versionsnummer erhöhen.
const CACHE = 'dienstplan-v1';
const FILES = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'favicon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Erst das Netz fragen (immer aktuell), bei Funkloch aus dem Speicher
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'))
      )
  );
});
