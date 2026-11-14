// api/get.js — Serverless (Node, region sin1) — ORKESTRATOR ekstraksi
// Browser HANYA memanggil endpoint ini (same-origin). Urutan provider (semuanya gratis):
//   1. Spesifik : Terabox (worker), Doodstream (scrape langsung),
//                 TikTok (tikwm → no-watermark HD), Twitter/X (fxtwitter, open source FixTweet)
//   2. yt-dlp   : /api/extract (Python, open source, 1000+ situs)  ← mesin utama
//   3. Cobalt   : opsional, aktif bila COBALT_API_URL di-set (open source, bisa self-host)
// Setiap media dikembalikan dengan field `dl` = link proxy /api/dl (streaming, bypass CORS/Referer).
//
// ENV (semua opsional):
//   SIGN_SECRET        string acak panjang — mengunci /api/dl & /api/extract
//   YTDLP_COOKIES_B64  cookies.txt (Netscape) base64 — dibaca extract.py (YouTube/IG yang minta login)
//   YTDLP_PROXY        proxy untuk yt-dlp (mis. residential) — dibaca extract.py
//   COBALT_API_URL     mis. https://cobalt.domainmu.com   (instance Cobalt)
//   COBALT_API_KEY     API key Cobalt bila instance-nya butuh
//   TERABOX_API        override endpoint worker Terabox
//   RATE_LIMIT_PER_MIN        batas semua request /api/get per IP per menit (default 40)
//   RATE_LIMIT_MISS_PER_MIN   batas request yang benar-benar menjalankan ekstraksi (default 15)
//   CACHE_TTL                 lama cache hasil ekstraksi dalam detik (default 480 = 8 menit)
//   BLOCKED_HOSTS             domain yang diblokir (pisahkan koma), mis. situs-pelanggar.com,contoh.net — untuk permintaan takedown/DMCA
//   (opsional) KV_REST_API_URL + KV_REST_API_TOKEN  → Redis bersama untuk rate limit, cache, statistik

const crypto = require('crypto');
const store = require('../lib/store');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SIGN_SECRET = process.env.SIGN_SECRET || '';
const TERABOX_API = process.env.TERABOX_API || 'https://terabox-worker.robinkumarshakya103.workers.dev/api';
const COBALT_API_URL = (process.env.COBALT_API_URL || '').replace(/\/$/, '');
const COBALT_API_KEY = process.env.COBALT_API_KEY || '';

const TERABOX = ['terabox.com', 'terabox.app', '1024terabox.com', 'freeterabox.com', 'terabox.tech', 'teraboxapp.com', 'dubox.com', '4funbox.com', 'mirrobox.com', 'nephobox.com'];
const DOOD = ['doodstream.com', 'dood.watch', 'dood.to', 'dood.so', 'dood.la', 'dood.ws', 'dood.sh', 'dood.pm', 'dood.wf', 'dood.cx', 'dood.li', 'dooood.com', 'doods.pro', 'ds2play.com', 'ds2video.com', 'd0o0d.com', 'do7go.com', 'd000d.com', 'd0000d.com'];
const TIKTOK = ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'];
const TWITTER = ['twitter.com', 'x.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com'];

const VIDEO_EXT = ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'flv', 'avi', 'ts', '3gp'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'opus', 'ogg', 'flac', 'wav', 'weba'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const inList = (h, list) => list.some(d => h === d || h.endsWith('.' + d));

// ---------- helpers ----------
function cleanUrl(raw) {
  const u = new URL(raw);
  ['mibextid', 'si', 'fbclid', 'igshid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'feature'].forEach(k => u.searchParams.delete(k));
  return u.href;
}

// Resolve link share Facebook / fb.watch ke URL asli
async function resolveShort(url) {
  const h = hostOf(url);
  const p = new URL(url).pathname;
  if (h === 'fb.watch' || (h.endsWith('facebook.com') && /^\/share\//.test(p))) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
      if (r.url && r.url !== url && !/login/.test(r.url)) return r.url;
    } catch { /* abaikan, pakai URL asli */ }
  }
  return url;
}

function extFromUrl(url) {
  try {
    const u = new URL(url);
    const mime = u.searchParams.get('mime');
    if (mime) {
      const sub = mime.split('/')[1];
      if (sub) return sub === 'mpeg' ? 'mp3' : sub.replace('x-', '');
    }
    const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (m) return m[1].toLowerCase();
  } catch { /* ignore */ }
  return '';
}

function normMedia(m) {
  const url = m && (m.url || m.link || m.download_url || m.src);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  let ext = String(m.extension || m.ext || '').toLowerCase().replace('.', '') || extFromUrl(url);
  let type = String(m.type || '').toLowerCase();
  if (type === 'photo') type = 'image';
  if (type === 'gif') type = 'video';
  if (!['video', 'audio', 'image', 'subtitle'].includes(type)) {
    type = AUDIO_EXT.includes(ext) ? 'audio' : IMAGE_EXT.includes(ext) ? 'image' : 'video';
  }
  if (!ext) ext = type === 'audio' ? 'mp3' : type === 'image' ? 'jpg' : type === 'subtitle' ? 'vtt' : 'mp4';
  return {
    url, type, extension: ext,
    quality: String(m.quality || m.label || m.resolution || '').trim(),
    size: m.size ? String(m.size) : undefined,
    filename: m.filename || m.file_name || undefined,
    ref: m.ref || undefined,
  };
}

const safeName = s => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

function buildName(title, m) {
  if (m.type === 'subtitle') {
    const lang = (String(m.quality || '').split(' ')[0] || 'sub').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'sub';
    return `${safeName(title) || 'VaultDL'}.${lang}.${m.extension}`;
  }
  const base = safeName(m.filename ? m.filename.replace(/\.[a-z0-9]{2,5}$/i, '') : title) || 'VaultDL';
  const q = !m.filename && /\d{3,4}p/.test(m.quality) ? ' ' + m.quality.match(/\d{3,4}p/)[0] : '';
  return `${base}${q}.${m.extension}`;
}

function sign(url, ref) {
  return crypto.createHmac('sha256', SIGN_SECRET).update(url + '|' + (ref || '')).digest('hex').slice(0, 32);
}

function dlLink(m, title) {
  if (['m3u8', 'mpd'].includes(m.extension)) return null; // playlist streaming, tidak bisa diproxy jadi file
  const p = new URLSearchParams({ url: m.url, name: buildName(title, m) });
  if (m.ref) p.set('ref', m.ref);
  if (SIGN_SECRET) p.set('sig', sign(m.url, m.ref));
  return '/api/dl?' + p.toString();
}

// ---------- providers ----------
async function viaYtdlp(url, ctx, opt = {}) {
  const headers = { accept: 'application/json' };
  if (SIGN_SECRET) headers['x-internal-key'] = SIGN_SECRET;
  const q = `url=${encodeURIComponent(url)}${opt.playlist ? '&playlist=1' : ''}`;
  const r = await fetch(`https://${ctx.host}/api/extract?${q}`, { headers, signal: ctx.t(38000) });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch { /* bukan JSON */ }
  if (!r.ok) {
    if (!j.error) throw new Error(`HTTP ${r.status} — /api/extract belum ter-deploy? (butuh requirements.txt + api/extract.py)`);
    const e = new Error(j.error); e.kind = j.kind; throw e;
  }
  if (opt.playlist) {
    if (!j.entries?.length) throw new Error('playlist kosong / tidak terbaca');
    return j;
  }
  if (!j.medias?.length) throw new Error('tidak ada media');
  return j;
}

async function viaTikwm(url, ctx) {
  const r = await fetch('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams({ url, hd: '1' }),
    signal: ctx.t(12000),
  });
  const j = await r.json();
  if (j.code !== 0 || !j.data) throw new Error(j.msg || 'gagal');
  const d = j.data;
  const abs = u => (u && u.startsWith('/') ? 'https://www.tikwm.com' + u : u);
  const medias = [];
  if (Array.isArray(d.images) && d.images.length) {
    d.images.forEach((u, i) => medias.push({ url: u, type: 'image', extension: 'jpg', quality: 'Foto ' + (i + 1) }));
  } else {
    if (d.hdplay) medias.push({ url: abs(d.hdplay), type: 'video', extension: 'mp4', quality: 'hd_no_watermark' });
    if (d.play) medias.push({ url: abs(d.play), type: 'video', extension: 'mp4', quality: 'no_watermark' });
    if (d.wmplay) medias.push({ url: abs(d.wmplay), type: 'video', extension: 'mp4', quality: 'watermark' });
  }
  if (d.music) medias.push({ url: abs(d.music), type: 'audio', extension: 'mp3', quality: 'audio' });
  return { title: d.title, thumbnail: abs(d.cover || d.origin_cover), source: 'TikTok', author: d.author?.nickname, medias };
}

async function viaFxTwitter(url, ctx) {
  const id = new URL(url).pathname.match(/\/status(?:es)?\/(\d+)/)?.[1];
  if (!id) throw new Error('ID tweet tidak ditemukan');
  const r = await fetch('https://api.fxtwitter.com/i/status/' + id, { headers: { 'user-agent': UA }, signal: ctx.t(12000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const t = j.tweet;
  if (!t) throw new Error('tweet tidak ditemukan');
  const medias = [];
  (t.media?.videos || []).forEach(v => {
    const variants = (v.variants || []).filter(x => /mp4/.test(x.content_type || '') && x.url);
    if (variants.length) {
      variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      variants.forEach(x => medias.push({ url: x.url, type: 'video', extension: 'mp4', quality: x.bitrate ? Math.round(x.bitrate / 1000) + ' kbps' : 'mp4' }));
    } else if (v.url) {
      medias.push({ url: v.url, type: 'video', extension: 'mp4', quality: v.height ? v.height + 'p' : 'best' });
    }
  });
  (t.media?.photos || []).forEach((p, i) => medias.push({ url: p.url, type: 'image', extension: 'jpg', quality: 'Foto ' + (i + 1) }));
  if (!medias.length) throw new Error('tweet tidak berisi media');
  return {
    title: t.text ? t.text.slice(0, 120) : 'Tweet',
    thumbnail: t.media?.videos?.[0]?.thumbnail_url || t.media?.photos?.[0]?.url,
    source: 'Twitter/X', author: t.author?.name, medias,
  };
}

async function viaCobalt(url, ctx) {
  if (!COBALT_API_URL) throw new Error('belum dikonfigurasi (COBALT_API_URL)');
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (COBALT_API_KEY) headers.authorization = 'Api-Key ' + COBALT_API_KEY;
  const r = await fetch(COBALT_API_URL + '/', {
    method: 'POST', headers, signal: ctx.t(20000),
    body: JSON.stringify({ url, videoQuality: '1080', filenameStyle: 'basic' }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.status === 'error') throw new Error(j.error?.code || 'error');
  let medias = [];
  if (j.status === 'tunnel' || j.status === 'redirect') {
    const audio = /\.(mp3|m4a|opus|ogg)$/i.test(j.filename || '');
    medias = [{ url: j.url, filename: j.filename, quality: 'best', type: audio ? 'audio' : 'video' }];
  } else if (j.status === 'picker') {
    medias = (j.picker || []).map((p, i) => ({ url: p.url, type: p.type === 'photo' ? 'image' : 'video', quality: (p.type === 'photo' ? 'Foto ' : 'Video ') + (i + 1) }));
    if (j.audio) medias.push({ url: j.audio, type: 'audio', extension: 'mp3', quality: 'audio' });
  }
  if (!medias.length) throw new Error('respons tidak dikenali: ' + (j.status || r.status));
  return { title: j.filename ? j.filename.replace(/\.[a-z0-9]+$/i, '') : undefined, medias };
}

async function viaTerabox(url, ctx) {
  const r = await fetch(TERABOX_API + '?url=' + encodeURIComponent(url), { headers: { accept: 'application/json' }, signal: ctx.t(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (!j.success || !j.files?.length) throw new Error(j.error || 'tidak ada file');
  const medias = j.files.map(f => ({
    url: f.download_url || f.original_download_url,
    filename: f.file_name, quality: f.size || 'file',
    extension: (f.file_name || '').match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase(),
  })).filter(m => m.url);
  return { title: j.files.length === 1 ? j.files[0].file_name : `${j.files.length} file Terabox`, source: 'Terabox', medias };
}

async function viaDood(url, ctx) {
  const u = new URL(url);
  const code = u.pathname.match(/\/[def]\/([a-z0-9]+)/i)?.[1];
  if (!code) throw new Error('ID video tidak ditemukan di URL');
  const r = await fetch(`https://${u.hostname}/e/${code}`, {
    headers: { 'user-agent': UA, referer: `https://${u.hostname}/` }, redirect: 'follow', signal: ctx.t(12000),
  });
  const html = await r.text();
  const host = new URL(r.url).hostname; // Dood sering redirect ke mirror lain
  const pm = html.match(/\/pass_md5\/[^'"\s<>]+/);
  if (!pm) throw new Error('pass_md5 tidak ditemukan (kemungkinan diblok Cloudflare)');
  const token = html.match(/[?&]token=([a-z0-9]+)/i)?.[1] || pm[0].split('/').pop();
  const base = (await (await fetch(`https://${host}${pm[0]}`, {
    headers: { 'user-agent': UA, referer: `https://${host}/e/${code}` }, signal: ctx.t(12000),
  })).text()).trim();
  if (!/^https?:\/\//.test(base)) throw new Error('pass_md5 tidak mengembalikan URL');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const rnd = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || 'Doodstream Video').replace(/\s*[-|].*$/, '').trim();
  const thumb = html.match(/og:image[^>]+content=["']([^"']+)/i)?.[1];
  return {
    title, thumbnail: thumb, source: 'Doodstream',
    embed: `https://${host}/e/${code}`,
    medias: [{ url: `${base}${rnd}?token=${token}&expiry=${Date.now()}`, type: 'video', extension: 'mp4', quality: 'Direct', ref: `https://${host}/` }],
  };
}

// ---------- handler ----------
// ---------- statistik & log ----------
const KNOWN_HOSTS = ['youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch', 'twitter.com', 'x.com',
  'reddit.com', 'vimeo.com', 'soundcloud.com', 'twitch.tv', 'bilibili.com', 'dailymotion.com', 'pinterest.com', 'linkedin.com',
  'rumble.com', 'telegram.org', 't.me', 'terabox.com', 'doodstream.com'];
const platformKey = h => KNOWN_HOSTS.find(d => h === d || h.endsWith('.' + d)) || (inList(h, TERABOX) ? 'terabox.com' : inList(h, DOOD) ? 'doodstream.com' : 'lainnya');
const dayKey = () => 'st:' + new Date().toISOString().slice(0, 10);

async function record(kind, host, errMsg) {
  const jobs = [store.hincr(dayKey(), kind, 35 * 86400)];
  if (kind === 'ok') jobs.push(store.hincr('stp:ok', platformKey(host)));
  if (kind === 'fail') {
    jobs.push(store.hincr('stp:fail', platformKey(host)));
    jobs.push(store.lpush('errlog', JSON.stringify({ t: Date.now(), host: String(host).slice(0, 60), msg: String(errMsg || '').slice(0, 300) }), 40));
    console.error(JSON.stringify({ level: 'error', event: 'extract_failed', host, msg: String(errMsg || '').slice(0, 300) }));
  }
  await store.settle(jobs);
}

const RATE_ALL = Number(process.env.RATE_LIMIT_PER_MIN) || 40;
const RATE_MISS = Number(process.env.RATE_LIMIT_MISS_PER_MIN) || 15;
const CACHE_TTL = Number(process.env.CACHE_TTL) || 480;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const input = q.url;
  if (!input) return res.status(400).json({ error: 'Parameter url diperlukan' });
  const wantPlaylist = String(q.playlist || '') === '1';
  const fresh = String(q.fresh || '') === '1';

  let url;
  try {
    url = cleanUrl(input);
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('bad protocol');
  } catch {
    return res.status(400).json({ error: 'URL tidak valid' });
  }

  const tooMany = async (rl) => {
    await record('rl');
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `Terlalu banyak permintaan. Coba lagi dalam ${rl.retryAfter} detik.`, retryAfter: rl.retryAfter });
  };

  // 1) rate limit per IP — semua request
  const ip = store.clientIp(req);
  const rlAll = await store.rateLimit('get:' + ip, RATE_ALL, 60);
  if (!rlAll.ok) return tooMany(rlAll);

  const deadline = Date.now() + 54000;
  url = await resolveShort(url);
  const h = hostOf(url);

  // Daftar blokir (permintaan takedown/DMCA) — diisi lewat env BLOCKED_HOSTS
  const blocked = (process.env.BLOCKED_HOSTS || '').split(',').map(x => x.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean);
  if (blocked.some(d => h === d || h.endsWith('.' + d))) {
    return res.status(451).json({ error: 'Situs ini tidak dapat diproses oleh VaultDL (diblokir atas permintaan pemegang hak).' });
  }

  // 2) cache hasil (kunci = hash URL, bukan URL asli)
  const cacheKey = 'c:v2:' + (wantPlaylist ? 'p:' : '') + store.sha1(url);
  if (!fresh) {
    const hit = await store.getJSON(cacheKey);
    if (hit) {
      await record('cache');
      return res.status(200).json({ ...hit, cached: true });
    }
  }

  // 3) rate limit lebih ketat khusus yang menjalankan ekstraksi sungguhan
  const rlMiss = await store.rateLimit('getmiss:' + ip, RATE_MISS, 60);
  if (!rlMiss.ok) return tooMany(rlMiss);

  const ctx = {
    host: ((req.headers || {})['x-forwarded-host'] || (req.headers || {}).host || '').split(',')[0].trim(),
    t: ms => AbortSignal.timeout(Math.max(1500, Math.min(ms, deadline - Date.now() - 800))),
  };

  // ---- mode playlist: hanya yt-dlp ----
  if (wantPlaylist) {
    try {
      const out = await viaYtdlp(url, ctx, { playlist: true });
      const payload = { playlist: true, title: out.title || 'Playlist', source: out.source || null, count: out.entries.length, entries: out.entries.slice(0, 30) };
      await store.settle([store.setJSON(cacheKey, payload, CACHE_TTL), record('ok', h)]);
      return res.status(200).json(payload);
    } catch (e) {
      await record('fail', h, 'playlist: ' + e.message);
      return res.status(502).json({ error: 'Gagal membaca playlist', hint: 'Tidak semua link bisa dibaca sebagai playlist. Tempel link video satu per satu.', details: [e.message] });
    }
  }

  const chain = [];
  if (inList(h, TERABOX)) chain.push(['terabox', viaTerabox]);
  else if (inList(h, DOOD) || /^dood\.[a-z]{2,6}$/.test(h)) chain.push(['dood', viaDood]);
  else if (inList(h, TIKTOK)) chain.push(['tikwm', viaTikwm]);
  else if (inList(h, TWITTER)) chain.push(['fxtwitter', viaFxTwitter]);
  chain.push(['yt-dlp', viaYtdlp], ['cobalt', viaCobalt]);

  const errors = [];
  const kinds = [];
  for (const [name, fn] of chain) {
    if (deadline - Date.now() < 3000) { errors.push(`${name}: dilewati (waktu habis)`); continue; }
    if (name === 'cobalt' && !COBALT_API_URL) { errors.push('cobalt: tidak dikonfigurasi (opsional)'); continue; }
    try {
      const out = await fn(url, ctx);
      const medias = (out.medias || []).map(normMedia).filter(Boolean);
      if (!medias.length) throw new Error('media kosong');
      const title = out.title || 'Video';
      const payload = {
        title,
        thumbnail: out.thumbnail || null,
        source: out.source || null,
        author: out.author || null,
        embed: out.embed || null,
        provider: name,
        medias: medias.map(m => ({
          type: m.type, extension: m.extension, quality: m.quality,
          size: m.size, filename: m.filename,
          url: m.url,
          hls: ['m3u8', 'mpd'].includes(m.extension),
          dl: dlLink(m, title),
        })),
      };
      await store.settle([store.setJSON(cacheKey, payload, CACHE_TTL), record('ok', h)]);
      return res.status(200).json(payload);
    } catch (e) {
      if (e.kind) kinds.push(e.kind);
      errors.push(`${name}: ${e.message}`);
    }
  }

  await record('fail', h, errors.filter(x => !/tidak dikonfigurasi|dilewati/.test(x)).join(' | '));

  let hint = 'Pastikan video publik (bukan privat / terhapus) lalu coba lagi.';
  if (kinds.includes('bot_check') || kinds.includes('login_required')) {
    hint = 'Platform ini memblokir IP server (YouTube/Instagram sering begini). Solusi: isi YTDLP_COOKIES_B64 (cookies akun), YTDLP_PROXY (proxy residential), atau COBALT_API_URL di Environment Variables Vercel lalu redeploy.';
  } else if (kinds.includes('blocked')) {
    hint = 'Situs menolak IP server (HTTP 412). Untuk Bilibili: isi BILI_COOKIES_B64 (cookies akun login) atau YTDLP_PROXY di Environment Variables Vercel lalu redeploy.';
  } else if (kinds.includes('no_formats')) {
    hint = 'YouTube tidak memberi daftar format (bukan video privat). Pastikan folder bin/qjs ikut ter-deploy dan requirements.txt berisi yt-dlp[default], lalu redeploy tanpa build cache.';
  } else if (kinds.includes('unavailable')) {
    hint = 'Video privat, dihapus, atau dibatasi wilayah.';
  }

  return res.status(502).json({
    error: 'Semua provider gagal mengambil video ini',
    hint,
    details: errors,
  });
};
