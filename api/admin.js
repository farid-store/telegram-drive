// api/admin.js — panel admin tersembunyi (login password, atur iklan, lihat statistik)
//
// POST /api/admin  { action: 'login' | 'get' | 'save' | 'stats', password, config? }
//
// ENV:
//   ADMIN_PASSWORD  password admin. Bila tidak di-set, dipakai default '011204'.
//                   PIN 6 digit mudah ditebak → sangat disarankan di-set ke kata sandi panjang di Vercel.
//
// Proteksi brute-force: 5 percobaan salah / 15 menit per IP, dan batas global 60 gagal / jam.

const crypto = require('crypto');
const store = require('../lib/store');

const PASSWORD = process.env.ADMIN_PASSWORD || '011204';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

async function loadStats() {
  const today = await store.hgetall('st:' + dayKey());
  const y = new Date(Date.now() - 86400000);
  const yesterday = await store.hgetall('st:' + dayKey(y));
  const okByHost = await store.hgetall('stp:ok');
  const failByHost = await store.hgetall('stp:fail');
  const hosts = [...new Set([...Object.keys(okByHost), ...Object.keys(failByHost)])]
    .map(h => ({ host: h, ok: okByHost[h] || 0, fail: failByHost[h] || 0 }))
    .sort((a, b) => (b.ok + b.fail) - (a.ok + a.fail))
    .slice(0, 25);
  const errors = (await store.lrange('errlog', 25)).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
  return { today, yesterday, hosts, errors };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const ip = store.clientIp(req);

  // Blokir dulu bila sudah melewati batas gagal
  const failed = await store.getJSON('admlock:' + ip);
  if (failed && failed.count >= 5) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan salah. Coba lagi dalam 15 menit.' });
  }
  const globalFail = await store.getJSON('admlock:global');
  if (globalFail && globalFail.count >= 60) {
    return res.status(429).json({ error: 'Login admin dikunci sementara. Coba lagi nanti.' });
  }

  if (!safeEqual(body.password || '', PASSWORD)) {
    const c = (failed && failed.count || 0) + 1;
    await store.setJSON('admlock:' + ip, { count: c }, 900);
    const g = (globalFail && globalFail.count || 0) + 1;
    await store.setJSON('admlock:global', { count: g }, 3600);
    return res.status(401).json({ error: 'Password salah', left: Math.max(0, 5 - c) });
  }
  await store.setJSON('admlock:' + ip, { count: 0 }, 1);

  const action = body.action || 'login';
  try {
    if (action === 'login') {
      return res.status(200).json({ ok: true, persistent: store.HAS_REDIS, defaultPassword: !process.env.ADMIN_PASSWORD });
    }
    if (action === 'get') {
      const cfg = await store.getConfig();
      return res.status(200).json({ ok: true, config: cfg, persistent: store.HAS_REDIS, stats: await loadStats() });
    }
    if (action === 'save') {
      const cfg = await store.saveConfig(body.config || {});
      return res.status(200).json({ ok: true, config: cfg, persistent: store.HAS_REDIS });
    }
    if (action === 'stats') {
      return res.status(200).json({ ok: true, stats: await loadStats(), persistent: store.HAS_REDIS });
    }
    return res.status(400).json({ error: 'Aksi tidak dikenal' });
  } catch (e) {
    console.error('[admin] error', e);
    return res.status(500).json({ error: 'Gagal memproses: ' + e.message });
  }
};
