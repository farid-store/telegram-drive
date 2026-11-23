/* Service worker: menyimpan perpustakaan transkripsi (transformers.js + onnxruntime wasm dari jsDelivr)
   dan halaman editor, supaya setelah dipakai sekali editor + auto caption bisa jalan tanpa internet.
   Model Whisper disimpan sendiri oleh transformers.js di Cache Storage browser.
   Letakkan file ini di ROOT situs: /editor-offline-sw.js */
const CACHE='editor-offline-v1';
self.addEventListener('install',e=>{self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);
  const lib=u.hostname==='cdn.jsdelivr.net';
  const page=u.origin===location.origin&&(u.pathname.includes('editor')||u.pathname.startsWith('/vendor/'));
  if(!lib&&!page)return;
  e.respondWith((async()=>{
    const c=await caches.open(CACHE);
    if(lib){ // cache-first
      const hit=await c.match(r);if(hit)return hit;
      const res=await fetch(r);if(res&&(res.ok||res.type==='opaque'))c.put(r,res.clone());return res;
    }
    try{ // network-first, fallback ke cache saat offline
      const res=await fetch(r);if(res&&res.ok)c.put(r,res.clone());return res;
    }catch(err){const hit=await c.match(r);if(hit)return hit;throw err}
  })());
});
