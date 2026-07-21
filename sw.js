// SprachTutor AI Service Worker
// Strategy:
//  - HTML/navigation → network-first (so a new index.html + version always arrives)
//  - versioned static assets (app.js?v=, style.css?v=, icons) → cache-first (URL changes per version)
// Bump CACHE_VERSION on every release so old caches are purged.
const CACHE_VERSION = 'st-cache-30.66';
const CORE_ASSETS = [
    './',
    './index.html',
    './icon.svg',
    './icon-192.png',
    './icon-512.png',
    './apple-touch-icon.png',
    './manifest.json'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS).catch(() => {}))
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
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // Only handle same-origin requests; let Firebase, image APIs, etc. pass through untouched
    if (url.origin !== self.location.origin) return;

    const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

    if (isHTML) {
        // network-first: always try to get the freshest HTML
        event.respondWith(
            fetch(req).then((resp) => {
                const copy = resp.clone();
                caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
                return resp;
            }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
        );
        return;
    }

    // cache-first for static assets (app.js/style.css carry ?v= so URL changes per version)
    event.respondWith(
        caches.match(req).then((cached) => {
            if (cached) return cached;
            return fetch(req).then((resp) => {
                if (resp && resp.status === 200) {
                    const copy = resp.clone();
                    caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
                }
                return resp;
            }).catch(() => cached);
        })
    );
});
