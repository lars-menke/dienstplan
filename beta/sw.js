// Service Worker der Testversion (V2, Kapitel 9).
// Eigener Cache, Scope ist dieser Ordner (beta/). Der spezifischere Scope
// gewinnt gegenüber dem Service Worker der Live-App.
// Bei jeder Änderung an den Dateien die Versionsnummer erhöhen.
const CACHE = 'dienstplan-beta-v3';
const FILES = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'icons.js',
  '../config.js',
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
      .then(keys => Promise.all(keys.filter(k => k.startsWith('dienstplan-beta-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Erst das Netz (immer aktuell), bei Funkloch aus dem Speicher.
// Anfragen an die Schnittstelle (andere Domain) laufen unverändert durch.
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
