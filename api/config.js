// api/config.js — konfigurasi publik (pengaturan iklan). Dibaca frontend saat halaman dibuka.
// Di-cache CDN singkat (15 dtk) supaya cepat; perubahan dari admin terlihat dalam hitungan detik.

const store = require('../lib/store');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const cfg = await store.getConfig();
    return res.status(200).json({ ads: cfg.ads, v: cfg.v });
  } catch (e) {
    // Gagal baca konfigurasi → iklan dimatikan (aman), halaman tetap berfungsi
    return res.status(200).json({ ads: { enabled: false }, v: 0 });
  }
};
