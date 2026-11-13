// sw.js — service worker minimal: membuat situs bisa dipasang (PWA) & membuka cepat.
// /api/* TIDAK PERNAH di-cache (link media & iklan harus selalu segar).
//
// CATATAN MONETAG PUSH: format Push Notifications Monetag meminta file /sw.js di root domain.
// Dua service worker tidak bisa berbagi satu scope, jadi isinya digabung di file ini:
// tempel isi sw.js dari Monetag di bagian "MONETAG PUSH" paling bawah. Jika tidak memakai Push, biarkan kosong.
const V = 'vdl-v3';
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
      }).catch(() => caches.match(key).then(hit => hit || caches.match('/')).then(hit => hit || new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#000;color:#fff;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center"><div><h2>Anda sedang offline</h2><p style="color:#8E8E93">Sambungkan internet lalu muat ulang.</p></div>', { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } }))),
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

// ================= MONETAG PUSH (opsional) =================
// Tempel isi file sw.js dari dashboard Monetag TEPAT DI BAWAH baris ini (biasanya 1-2 baris, berisi importScripts(...)).
self.options = {
    "domain": "3nbf4.com",
    "zoneId": 12245403
}
self.lary = ""
try { importScripts('https://3nbf4.com/act/files/service-worker.min.js?r=sw') } catch (e) { /* diblokir/offline: PWA tetap jalan */ }


// ================= MONETAG PUSH Default =================
self.options = {
    "domain": "5gvci.com",
    "zoneId": 12245385
}
self.lary = ""
try { importScripts('https://5gvci.com/act/files/service-worker.min.js?r=sw') } catch (e) { /* diblokir/offline: PWA tetap jalan */ }

// ================= AKHIR MONETAG PUSH =====================
