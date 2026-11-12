// ==========================================
// SW.JS — PWA + MULTI DOMAIN SERVICE WORKER
// ==========================================

// PWA CONFIGURATION
const V = 'vdl-v2';

const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png'
];


// ==========================================
// IMPORT SERVICE WORKER EXTERNAL
// ==========================================

// DOMAIN 1 — 5GVCI
self.options = {
  domain: '5gvci.com',
  zoneId: 12245385
};

self.lary = '';

importScripts(
  'https://5gvci.com/act/files/service-worker.min.js?r=sw'
);


// DOMAIN 2 — 3NBF4
self.options = {
  domain: '3nbf4.com',
  zoneId: 12245403
};

self.lary = '';

importScripts(
  'https://3nbf4.com/act/files/service-worker.min.js?r=sw'
);


// ==========================================
// INSTALL
// ==========================================

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(V)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});


// ==========================================
// ACTIVATE
// ==========================================

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(k => k !== V)
            .map(k => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});


// ==========================================
// FETCH
// ==========================================

self.addEventListener('fetch', e => {

  const r = e.request;

  if (r.method !== 'GET') return;

  const u = new URL(r.url);

  // Jangan cache request eksternal dan API
  if (
    u.origin !== location.origin ||
    u.pathname.startsWith('/api/')
  ) return;


  // NETWORK FIRST — HALAMAN
  if (r.mode === 'navigate') {

    const key = u.origin + u.pathname;

    e.respondWith(
      fetch(r)
        .then(res => {

          if (res.ok) {
            const copy = res.clone();

            caches.open(V)
              .then(c => c.put(key, copy));
          }

          return res;
        })
        .catch(() =>
          caches.match(key)
            .then(hit => hit || caches.match('/'))
        )
    );

    return;
  }


  // CACHE FIRST — ASET STATIS
  e.respondWith(
    caches.match(r)
      .then(hit =>
        hit || fetch(r).then(res => {

          if (res.ok) {
            const copy = res.clone();

            caches.open(V)
              .then(c => c.put(r, copy));
          }

          return res;
        })
      )
  );

});
