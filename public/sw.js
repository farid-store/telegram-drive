// sw.js — service worker minimal: membuat situs bisa dipasang (PWA) & membuka cepat.
// /api/* TIDAK PERNAH di-cache (link media & iklan harus selalu segar).
const V = 'vdl-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || u.pathname.startsWith('/api/')) return;

  // Halaman: ambil dari jaringan dulu (selalu versi terbaru), cadangan dari cache saat offline
  if (r.mode === 'navigate') {
    const key = u.origin + u.pathname;
    e.respondWith(
      fetch(r).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(V).then(c => c.put(key, copy)); }
        return res;
      }).catch(() => caches.match(key).then(hit => hit || caches.match('/'))),
    );
    return;
  }

  // Aset statis (ikon, manifest): cache dulu
  e.respondWith(
    caches.match(r).then(hit => hit || fetch(r).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(V).then(c => c.put(r, copy)); }
      return res;
    })),
  );
});
