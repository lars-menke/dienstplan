// Service Worker: hält die App-Dateien vor, damit sie schnell startet
// und auch ohne Netz öffnet. Termine kommen immer frisch vom Server.
// Bei jeder Änderung an den App-Dateien die Versionsnummer erhöhen.
const CACHE = 'dienstplan-v22';
const FILES = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'table.js',
  'import.js',
  // vendor/xlsx.full.min.js (Excel-Leser, ~950 KB) bewusst NICHT vorab – wird erst beim Import geladen
  'icons.js',
  'config.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'favicon.png',
  'fonts/permanent-marker.woff2',
  'fonts/barlow-condensed-600.woff2',
];

self.addEventListener('install', event => {
  // cache: 'reload' – am Browser-Zwischenspeicher vorbei, sonst landen evtl. noch alte Dateien im neuen Cache
  event.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

// Alte Caches entfernen – auch die der früheren Testversion (dienstplan-beta-*)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('dienstplan') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Erst das Netz fragen (immer aktuell), bei Funkloch aus dem Speicher.
// cache: 'no-cache' – GitHub Pages erlaubt 10 Minuten Zwischenspeichern; so fragt der Browser
// jedes Mal kurz nach (unverändert = kleine 304-Antwort) und neue Versionen sind sofort da.
// Anfragen an die Schnittstelle (andere Domain) laufen unverändert durch.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }))
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
