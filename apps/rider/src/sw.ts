// App-shell cache only: the API (/v1) and any personal data are never cached by the service worker.
const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = 'ride-rewards-v1';
const SHELL = ['/rider/index.html', '/rider/rider.js', '/rider/rider.css', '/rider/manifest.webmanifest', '/rider/icon.svg'];

sw.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => sw.skipWaiting())); });
sw.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => sw.clients.claim()));
});
sw.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('/rider/')) return;
  // Network first (fresh app), cache fallback (offline at the checkout counter).
  const key = e.request.mode === 'navigate' ? '/rider/index.html' : url.pathname;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); void caches.open(CACHE).then((c) => c.put(key, copy)); }
    return res;
  }).catch(async () => (await caches.match(key)) ?? Response.error()));
});
export {};
