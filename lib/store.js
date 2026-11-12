// lib/store.js — penyimpanan bersama untuk /api/get, /api/admin, /api/config
//
// Memakai Redis lewat REST (Upstash Redis / Vercel KV) bila env tersedia:
//   KV_REST_API_URL + KV_REST_API_TOKEN            (Vercel KV / Upstash via Marketplace — prefix "KV")
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
// Tanpa Redis semuanya tetap jalan memakai memori per-instance (rate limit & cache tetap
// berfungsi sebagian; pengaturan admin TIDAK permanen dan tidak dibagi antar instance).

const crypto = require('crypto');

// Cari kredensial Redis. Urutan: KV_* → UPSTASH_REDIS_* → prefix apa pun yang berakhiran
// "<PREFIX>_REST_API_URL" + "<PREFIX>_REST_API_TOKEN" (mis. bila prefix saat connect storage diubah).
function findRedisEnv() {
  const e = process.env;
  if (e.KV_REST_API_URL && e.KV_REST_API_TOKEN) return [e.KV_REST_API_URL, e.KV_REST_API_TOKEN];
  if (e.UPSTASH_REDIS_REST_URL && e.UPSTASH_REDIS_REST_TOKEN) return [e.UPSTASH_REDIS_REST_URL, e.UPSTASH_REDIS_REST_TOKEN];
  for (const k of Object.keys(e)) {
    const m = k.match(/^(.*?)(_?)REST_API_URL$/);
    if (m && e[m[1] + m[2] + 'REST_API_TOKEN']) return [e[k], e[m[1] + m[2] + 'REST_API_TOKEN']];
  }
  return ['', ''];
}
const [RAW_URL, REDIS_TOKEN] = findRedisEnv();
const REDIS_URL = RAW_URL.replace(/\/$/, '');
const HAS_REDIS = !!(REDIS_URL && REDIS_TOKEN);

// ---------- memori (fallback) ----------
const mem = { kv: new Map(), hash: new Map(), list: new Map(), rl: new Map() };
const now = () => Date.now();

function memGet(k) {
  const e = mem.kv.get(k);
  if (!e) return null;
  if (e.exp && e.exp < now()) { mem.kv.delete(k); return null; }
  return e.v;
}

// ---------- Redis REST ----------
async function redis(commands) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(2500),
  });
  if (!r.ok) throw new Error('redis HTTP ' + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error('redis: ' + x.error); return x.result; });
}

async function run(commands, fallback) {
  if (!HAS_REDIS) return fallback();
  try { return await redis(commands); } catch (e) { console.error('[store] redis error:', e.message); return fallback(); }
}

// ---------- API ----------
async function getJSON(key) {
  const [v] = await run([['GET', key]], () => [memGet(key)]);
  if (v == null) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
}

async function setJSON(key, value, ttlSec) {
  const s = JSON.stringify(value);
  await run(ttlSec ? [['SET', key, s, 'EX', ttlSec]] : [['SET', key, s]], () => {
    mem.kv.set(key, { v: s, exp: ttlSec ? now() + ttlSec * 1000 : 0 });
    return [];
  });
}

// Rate limit jendela tetap. Mengembalikan {ok, count, retryAfter}
async function rateLimit(key, limit, windowSec) {
  const k = 'rl:' + key;
  let count, ttl;
  if (HAS_REDIS) {
    try {
      [count, ttl] = await redis([['INCR', k], ['TTL', k]]);
      if (ttl < 0) { await redis([['EXPIRE', k, windowSec]]); ttl = windowSec; }
    } catch (e) {
      console.error('[store] rateLimit redis error:', e.message);
      return { ok: true, count: 0, retryAfter: 0 }; // fail-open: jangan blokir pengguna jika Redis bermasalah
    }
  } else {
    let e = mem.rl.get(k);
    if (!e || e.reset < now()) { e = { count: 0, reset: now() + windowSec * 1000 }; mem.rl.set(k, e); }
    e.count++;
    count = e.count;
    ttl = Math.max(1, Math.ceil((e.reset - now()) / 1000));
    if (mem.rl.size > 5000) for (const [kk, v] of mem.rl) if (v.reset < now()) mem.rl.delete(kk);
  }
  const allowed = count <= limit;
  return { ok: allowed, count, retryAfter: allowed ? 0 : Math.max(1, ttl) };
}

async function clearKey(key) {
  await run([['DEL', 'rl:' + key]], () => { mem.rl.delete('rl:' + key); return []; });
}

// Penghitung (hash). field bertambah 1.
async function hincr(key, field, ttlSec) {
  await run(
    ttlSec ? [['HINCRBY', key, field, 1], ['EXPIRE', key, ttlSec]] : [['HINCRBY', key, field, 1]],
    () => {
      const h = mem.hash.get(key) || {};
      h[field] = (h[field] || 0) + 1;
      mem.hash.set(key, h);
      return [];
    },
  );
}

async function hgetall(key) {
  const [r] = await run([['HGETALL', key]], () => [Object.entries(mem.hash.get(key) || {}).flat()]);
  const out = {};
  if (Array.isArray(r)) for (let i = 0; i < r.length; i += 2) out[r[i]] = Number(r[i + 1]) || 0;
  else if (r && typeof r === 'object') for (const k of Object.keys(r)) out[k] = Number(r[k]) || 0;
  return out;
}

async function lpush(key, value, max) {
  await run([['LPUSH', key, value], ['LTRIM', key, 0, max - 1]], () => {
    const l = mem.list.get(key) || [];
    l.unshift(value);
    mem.list.set(key, l.slice(0, max));
    return [];
  });
}

async function lrange(key, n) {
  const [r] = await run([['LRANGE', key, 0, n - 1]], () => [(mem.list.get(key) || []).slice(0, n)]);
  return Array.isArray(r) ? r : [];
}

// Tunggu penulisan statistik paling lama `ms` agar respons tidak tertahan (serverless bisa dibekukan setelah respons)
function settle(promises, ms = 600) {
  return Promise.race([Promise.allSettled(promises), new Promise(r => setTimeout(r, ms))]);
}

const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');

function clientIp(req) {
  const h = req.headers || {};
  const xf = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return String(h['x-real-ip'] || xf || (req.socket && req.socket.remoteAddress) || 'unknown');
}

// ---------- konfigurasi iklan ----------
const SLOT_DEFAULTS = {
  left: { enabled: true, mode: 'safe', size: '160x600', code: '' },
  right: { enabled: true, mode: 'safe', size: '160x600', code: '' },
  mid: { enabled: true, mode: 'safe', size: '728x90', code: '' },
  inter: { enabled: true, mode: 'safe', size: '300x250', code: '', delay: 3, cooldown: 90, onSearch: true, onDownload: true },
};
// Script global (tag zona Monetag dsb. yang disisipkan ke <head> secara dinamis) & Direct Link (tab baru saat klik)
const HEAD_DEFAULT = { enabled: false, code: '' };
const DIRECT_DEFAULT = { enabled: false, url: '', onSearch: false, onDownload: true, cooldown: 120, maxPerSession: 3 };
const DEFAULT_CONFIG = {
  v: 0,
  ads: { enabled: true, ...JSON.parse(JSON.stringify(SLOT_DEFAULTS)), head: { ...HEAD_DEFAULT }, direct: { ...DIRECT_DEFAULT } },
};

const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function sanitizeSlot(inp, def) {
  inp = inp && typeof inp === 'object' ? inp : {};
  const out = {
    enabled: bool(inp.enabled, def.enabled),
    mode: inp.mode === 'inline' ? 'inline' : 'safe',
    size: /^\d{2,4}x\d{2,4}$/.test(String(inp.size || '')) ? String(inp.size) : def.size,
    code: typeof inp.code === 'string' ? inp.code.slice(0, 8000) : def.code,
  };
  if ('delay' in def) {
    out.delay = clampInt(inp.delay, 0, 15, def.delay);
    out.cooldown = clampInt(inp.cooldown, 10, 3600, def.cooldown);
    out.onSearch = bool(inp.onSearch, def.onSearch);
    out.onDownload = bool(inp.onDownload, def.onDownload);
  }
  return out;
}

function sanitizeHead(inp) {
  inp = inp && typeof inp === 'object' ? inp : {};
  return { enabled: bool(inp.enabled, HEAD_DEFAULT.enabled), code: typeof inp.code === 'string' ? inp.code.slice(0, 8000) : '' };
}

function sanitizeDirect(inp) {
  inp = inp && typeof inp === 'object' ? inp : {};
  const url = /^https?:\/\/[^\s"'<>]+$/i.test(String(inp.url || '').trim()) ? String(inp.url).trim().slice(0, 1000) : '';
  return {
    enabled: bool(inp.enabled, DIRECT_DEFAULT.enabled) && !!url, // tanpa URL valid tidak bisa aktif
    url,
    onSearch: bool(inp.onSearch, DIRECT_DEFAULT.onSearch),
    onDownload: bool(inp.onDownload, DIRECT_DEFAULT.onDownload),
    cooldown: clampInt(inp.cooldown, 10, 3600, DIRECT_DEFAULT.cooldown),
    maxPerSession: clampInt(inp.maxPerSession, 1, 20, DIRECT_DEFAULT.maxPerSession),
  };
}

function sanitizeConfig(input) {
  const a = (input && input.ads) || {};
  const ads = { enabled: bool(a.enabled, true) };
  for (const k of Object.keys(SLOT_DEFAULTS)) ads[k] = sanitizeSlot(a[k], SLOT_DEFAULTS[k]);
  ads.head = sanitizeHead(a.head);
  ads.direct = sanitizeDirect(a.direct);
  return { v: Date.now(), ads };
}

async function getConfig() {
  const c = await getJSON('cfg:v1');
  if (!c) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const cfg = sanitizeConfig(c);
  cfg.v = c.v || 0;
  return cfg;
}

async function saveConfig(input) {
  const cfg = sanitizeConfig(input);
  await setJSON('cfg:v1', cfg);
  return cfg;
}

module.exports = {
  HAS_REDIS, getJSON, setJSON, rateLimit, clearKey, hincr, hgetall, lpush, lrange, settle,
  sha1, clientIp, getConfig, saveConfig, sanitizeConfig, DEFAULT_CONFIG,
};
