// api/hls.js — Proxy HLS untuk TV Live (Vercel Edge Runtime, region cgk1 & sin1)
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PLAYLIST = 4 * 1024 * 1024;
const MAX_RAW = 14 * 1024 * 1024;
const MAX_HOPS = 5;
const DENY_PORTS = new Set(['22', '23', '25', '110', '143', '445', '3306', '3389', '5432', '6379', '11211', '27017']);

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

// Tulis ulang semua URL di playlist HLS + wariskan token query induk bila sub-URL tidak punya query
function rewritePlaylist(text, base, selfBase, extra, directSeg = false) {
  const baseObj = new URL(base);
  const prox = u => {
    try {
      const rawUrl = u.trim();
      if (!rawUrl) return u;
      const absObj = new URL(rawUrl, base);
      if (!/^https?:/i.test(absObj.protocol)) return u;
      // Wariskan token/query dari manifest induk jika berada di domain yang sama dan belum punya query
      if (absObj.origin === baseObj.origin && !absObj.search && baseObj.search) {
        absObj.search = baseObj.search;
      }
      // Jika mode directSeg aktif dan ini adalah file segmen (.ts/.m4s/.aac) yang sudah https, ambil langsung dari IP user
      if (directSeg && absObj.protocol === 'https:' && /\.(ts|m4s|mp4|aac|mp3)(\?|$)/i.test(absObj.pathname)) {
        return absObj.href;
      }
      return `${selfBase}?u=${encodeURIComponent(absObj.href)}${extra}`;
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
  const base = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };
  const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), {
    status, headers: { ...base, 'Content-Type': 'application/json', ...extra },
  });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: base });
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'Method not allowed' });

  const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown');
  if (overRate(ip, opts.rate || 1500)) return json(429, { error: 'Terlalu banyak permintaan' }, { 'Retry-After': '15' });

  const self = new URL(req.url);
  const sp = self.searchParams;
  const raw = sp.get('raw') === '1';
  const directSeg = sp.get('seg') === 'direct';
  const spoofIp = sp.get('ip') === 'id';

  let target;
  try { target = new URL(sp.get('u') || ''); } catch { return json(400, { error: 'Parameter u (URL) tidak valid' }); }
  const bad = blockedReason(target, opts.blockedHosts);
  if (bad) return json(403, { error: bad });

  const ref = cleanHeaderVal(sp.get('ref'), 500);
  const ua = cleanHeaderVal(sp.get('ua'), 300);
  const mkHeaders = u => {
    const h = {
      'User-Agent': ua || BROWSER_UA,
      'Accept': '*/*',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    };
    // Hanya pasang header IP Lokal jika mode "🇮🇩 IP Lokal" (&ip=id) diaktifkan dari UI
    if (spoofIp) {
      const ipIndo = (ip && ip !== 'unknown' && !ip.includes(':')) ? ip : '36.80.112.10';
      h['X-Forwarded-For'] = ipIndo;
      h['X-Real-IP'] = ipIndo;
      h['True-Client-IP'] = ipIndo;
    }
    if (/^https?:\/\//i.test(ref)) {
      h.Referer = ref;
      try { h.Origin = new URL(ref).origin; } catch {}
    } else if (!raw) {
      h.Referer = u.origin + '/';
      h.Origin = u.origin;
    }
    const range = req.headers.get('range');
    if (range && !raw) h.Range = range;
    return h;
  };

  let cur = target, resp;
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      resp = await fetch(cur.href, { method: 'GET', headers: mkHeaders(cur), redirect: 'manual' });
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

  if (req.method === 'HEAD') {
    try { resp.body && resp.body.cancel(); } catch {}
    return new Response(null, { status: 200, headers: base });
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

  // ---- playlist HLS: deteksi dari Content-Type, ekstensi .m3u8, atau isi awal #EXTM3U ----
  const isMediaMime = /^(video|audio)\/(?!x-mpegurl|vnd\.apple\.mpegurl)/i.test(ct);
  const looksLikePlaylist = /mpegurl|vnd\.apple\.mpegurl|x-mpegurl/i.test(ct) || /\.m3u8?(\?|$)/i.test(path);
  const maybeTextPlaylist = !looksLikePlaylist && !isMediaMime && !/\.(ts|m4s|mp4|aac|mp3|key)(\?|$)/i.test(path) && (len === 0 || len < 512 * 1024) && /text\/plain|octet-stream|^$/.test(ct);

  if (looksLikePlaylist || maybeTextPlaylist) {
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_PLAYLIST) return json(502, { error: 'Playlist terlalu besar' });
    const sample = new TextDecoder('utf-8').decode(buf.slice(0, 64)).replace(/^\uFEFF/, '').trimStart();
    if (sample.startsWith('#EXTM3U')) {
      const text = new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, '');
      const selfBase = `${self.origin}${self.pathname}`;
      const extra = (ref ? `&ref=${encodeURIComponent(ref)}` : '')
        + (ua ? `&ua=${encodeURIComponent(ua)}` : '')
        + (directSeg ? '&seg=direct' : '')
        + (spoofIp ? '&ip=id' : '');
      return new Response(rewritePlaylist(text, cur.href, selfBase, extra, directSeg), {
        status: 200, headers: { ...base, 'Content-Type': 'application/vnd.apple.mpegurl' },
      });
    }
    if (looksLikePlaylist) {
      return json(502, { error: 'Respons bukan playlist HLS yang valid' });
    }
    return new Response(buf, {
      status: resp.status,
      headers: { ...base, 'Content-Type': ct || 'video/mp2t', 'Content-Length': String(buf.byteLength) },
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

export const config = { runtime: 'edge' };

const list = s => String(s || '').split(',').map(x => x.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean);
const OPTS = {
  cors: true,
  blockedHosts: list(process.env.BLOCKED_HOSTS),
  rate: Number(process.env.HLS_RATE_PER_MIN) || 1500,
};

export default async function handler(req) {
  return handle(req, OPTS);
}
