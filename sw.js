// Service worker for the whole site.  One worker owns scope "/", so both apps
// have to live here: a second registration on the same scope would silently
// evict this one and break offline mode for whichever app registered first.
const CACHE = 'site-v2';
const SHELL = [
  './index.html',
  './maze.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './rupor.html',
  './manifest-rupor.json',
  './rupor-192.png',
  './rupor-512.png',
  './rupor-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
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
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // The two app documents are always fetched from the network first.  Each of
  // them carries the whole app in one file, so a stale cached copy would pin
  // users to an old build with no way to notice.
  if (url.pathname.endsWith('/') ||
      url.pathname.endsWith('/maze.html') ||
      url.pathname.endsWith('/rupor.html')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || Response.error()))
    );
    return;
  }

  // Icons, manifests, statics: cache first, refreshed in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit || Response.error());
      return hit || net;
    })
  );
});
