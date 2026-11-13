// api/hls.js — Proxy HLS untuk TV Live (Vercel Edge Runtime, region sin1)
// (lihat penjelasan lengkap di README bagian TV Live)
// ---------------------------------------------------------------------------
//
//   GET /api/hls?u=<url>[&ref=<referer>][&ua=<user-agent>][&raw=1]
//
// Masalah yang diselesaikan: stream IPTV biasanya TIDAK mengirim header CORS (browser memblokir
// hls.js) dan sering http:// (diblok sebagai mixed content di halaman https). Proxy ini:
//   • mengambil playlist .m3u8, menulis ulang SEMUA URL di dalamnya (varian, segmen, kunci AES,
//     init map, audio/subtitle) agar kembali lewat proxy ini,
//   • meneruskan segmen secara streaming (mendukung Range),
//   • memasang Referer / User-Agent yang dibutuhkan channel tertentu,
//   • ?raw=1 → mengambil file daftar channel M3U (tanpa ditulis ulang).
//
// Perlindungan: blok SSRF (localhost/IP privat/port non-standar/redirect berbahaya), hanya
// menerima respons yang tampak seperti playlist HLS / media (bukan HTML), batas ukuran,
// pembatasan laju lunak per IP, dan pemeriksaan Sec-Fetch-Site (anti-hotlink dari situs lain).
// ---------------------------------------------------------------------------

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PLAYLIST = 4 * 1024 * 1024;   // playlist media/master
const MAX_RAW = 14 * 1024 * 1024;       // daftar channel M3U besar (iptv-org index ±3-5 MB)
const MAX_HOPS = 5;
const DENY_PORTS = new Set(['22', '23', '25', '110', '143', '445', '3306', '3389', '5432', '6379', '11211', '27017']); // server IPTV sering memakai port non-standar (8080, 25461, dst.)

// ---- pembatasan laju lunak (per instance) ----
const hits = new Map();
function overRate(ip, limit) {
  const now = Date.now();
  let e = hits.get(ip);
  if (!e || e.reset < now) { e = { n: 0, reset: now + 60000 }; hits.set(ip, e); }
  e.n++;
  if (hits.size > 4000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  return e.n > limit;
}

function blockedReason(u, blockedHosts) {
  if (!/^https?:$/.test(u.protocol)) return 'Protokol tidak diizinkan';
  if (u.port && DENY_PORTS.has(u.port)) return 'Port tidak diizinkan';
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(h) || !h.includes('.')) return 'Host tidak diizinkan';
  if (h.includes(':') || h.startsWith('[')) return 'IPv6 literal tidak diizinkan';
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return 'IP privat tidak diizinkan';
    if (a === 169 && b === 254) return 'IP privat tidak diizinkan';
    if (a === 172 && b >= 16 && b <= 31) return 'IP privat tidak diizinkan';
    if (a === 192 && b === 168) return 'IP privat tidak diizinkan';
    if (a === 100 && b >= 64 && b <= 127) return 'IP privat tidak diizinkan';
  }
  const bare = h.replace(/^www\./, '');
  if ((blockedHosts || []).some(d => bare === d || bare.endsWith('.' + d))) return 'Situs ini diblokir';
  return null;
}

const cleanHeaderVal = (v, max) => String(v || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);

// Tulis ulang semua URL di playlist HLS agar lewat proxy
function rewritePlaylist(text, base, selfBase, extra) {
  const prox = u => {
    try {
      const abs = new URL(u, base).href;
      if (!/^https?:/i.test(abs)) return u; // data: dsb. dibiarkan
      return `${selfBase}?u=${encodeURIComponent(abs)}${extra}`;
    } catch { return u; }
  };
  return text.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]*)"/g, (m, u) => `URI="${prox(u)}"`);
    return prox(t);
  }).join('\n');
}

async function handle(req, opts = {}) {
  const cors = !!opts.cors;
  const base = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(cors ? {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    } : {}),
  };
  const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), {
    status, headers: { ...base, 'Content-Type': 'application/json', ...extra },
  });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...base, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  // Anti-hotlink: browser dari situs lain tidak boleh memakai proxy ini
  const sfs = req.headers.get('sec-fetch-site');
  if (!cors && sfs && !['same-origin', 'none'].includes(sfs)) return json(403, { error: 'Akses lintas situs tidak diizinkan' });
  if (opts.allowOrigins && opts.allowOrigins.length) {
    let o = req.headers.get('origin') || '';
    if (!o) { try { o = new URL(req.headers.get('referer') || '').origin; } catch { o = ''; } }
    if (o && !opts.allowOrigins.includes(o)) return json(403, { error: 'Origin tidak diizinkan' });
  }

  const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown');
  if (overRate(ip, opts.rate || 600)) return json(429, { error: 'Terlalu banyak permintaan' }, { 'Retry-After': '30' });

  const self = new URL(req.url);
  const sp = self.searchParams;
  const raw = sp.get('raw') === '1';
  let target;
  try { target = new URL(sp.get('u') || ''); } catch { return json(400, { error: 'Parameter u (URL) tidak valid' }); }
  const bad = blockedReason(target, opts.blockedHosts);
  if (bad) return json(403, { error: bad });

  const ref = cleanHeaderVal(sp.get('ref'), 500);
  const ua = cleanHeaderVal(sp.get('ua'), 300);
  const mkHeaders = u => {
    const h = { 'User-Agent': ua || BROWSER_UA, Accept: '*/*', 'Accept-Encoding': 'identity' };
    if (/^https?:\/\//i.test(ref)) { h.Referer = ref; try { h.Origin = new URL(ref).origin; } catch { /* abaikan */ } }
    const range = req.headers.get('range');
    if (range && !raw) h.Range = range;
    return h;
  };

  let cur = target, resp;
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      resp = await fetch(cur.href, { headers: mkHeaders(cur), redirect: 'manual' });
      const loc = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && loc) {
        const next = new URL(loc, cur);
        const why = blockedReason(next, opts.blockedHosts);
        if (why) return json(403, { error: 'Redirect ditolak: ' + why });
        cur = next;
        continue;
      }
      break;
    }
  } catch (e) {
    return json(502, { error: 'Gagal terhubung ke server channel: ' + e.message });
  }
  if (resp.status >= 300 && resp.status < 400) return json(502, { error: 'Terlalu banyak redirect' });
  if (resp.status !== 200 && resp.status !== 206) {
    const hint = resp.status === 403 || resp.status === 451
      ? ' (kemungkinan diblok wilayah/geo atau butuh Referer khusus)'
      : resp.status === 404 || resp.status === 410 ? ' (channel/segmen sudah tidak ada)' : '';
    return json(502, { error: `Server channel membalas HTTP ${resp.status}${hint}`, upstream: resp.status });
  }

  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  const len = Number(resp.headers.get('content-length')) || 0;
  const path = cur.pathname + cur.search;

  // ---- mode raw: daftar channel M3U ----
  if (raw) {
    if (len && len > MAX_RAW) return json(502, { error: 'Playlist terlalu besar' });
    const text = (await resp.text()).replace(/^\uFEFF/, '');
    if (text.length > MAX_RAW) return json(502, { error: 'Playlist terlalu besar' });
    if (!text.trimStart().startsWith('#EXTM3U')) return json(502, { error: 'Bukan file playlist M3U' });
    return new Response(text, { status: 200, headers: { ...base, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
  }

  if (/^text\/html/.test(ct)) return json(502, { error: 'Server channel mengirim halaman web, bukan stream (link mati / diblok)' });

  // ---- playlist HLS: tulis ulang ----
  const isPlaylist = /mpegurl/.test(ct) || /\.m3u8?(\?|$)/i.test(path);
  if (isPlaylist) {
    if (len && len > MAX_PLAYLIST) return json(502, { error: 'Playlist terlalu besar' });
    const text = (await resp.text()).replace(/^\uFEFF/, '');
    if (text.length > MAX_PLAYLIST) return json(502, { error: 'Playlist terlalu besar' });
    if (!text.trimStart().startsWith('#EXTM3U')) return json(502, { error: 'Respons bukan playlist HLS yang valid' });
    const selfBase = `${self.origin}${self.pathname}`;
    const extra = (ref ? `&ref=${encodeURIComponent(ref)}` : '') + (ua ? `&ua=${encodeURIComponent(ua)}` : '');
    return new Response(rewritePlaylist(text, cur.href, selfBase, extra), {
      status: 200, headers: { ...base, 'Content-Type': 'application/vnd.apple.mpegurl' },
    });
  }

  // ---- segmen / kunci / media lain: teruskan sebagai stream ----
  if (len && len > 60 * 1024 * 1024) return json(502, { error: 'Segmen terlalu besar' });
  const headers = new Headers({ ...base, 'Content-Type': ct || 'application/octet-stream', 'Accept-Ranges': 'bytes' });
  for (const k of ['Content-Length', 'Content-Range']) {
    const v = resp.headers.get(k);
    if (v) headers.set(k, v);
  }
  return new Response(resp.body, { status: resp.status, headers });
}

export const config = { runtime: 'edge', regions: ['sin1'] };

const list = s => String(s || '').split(',').map(x => x.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean);
const OPTS = {
  cors: false, // dipanggil dari halaman yang sama (same-origin)
  blockedHosts: list(process.env.BLOCKED_HOSTS),
  rate: Number(process.env.HLS_RATE_PER_MIN) || 600, // per IP per menit (per instance)
};

export default async function handler(req) {
  return handle(req, OPTS);
}
