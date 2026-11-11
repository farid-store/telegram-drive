// api/dl.js — Edge streaming proxy untuk SEMUA platform (bukan cuma googlevideo)
// Dipanggil lewat link `dl` yang dibuat oleh /api/get:
//   /api/dl?url=<media>&name=<nama file>&ref=<referer opsional>&sig=<hmac>
//
// - Streaming (tidak ditampung di memori) → file besar aman, mendukung Range/resume
// - Content-Disposition: attachment → browser langsung download, bukan buka tab preview
// - Referer/User-Agent disesuaikan per CDN (TikTok, Bilibili, Doodstream, dll)
// - Proteksi SSRF (blok localhost / IP privat, validasi tiap redirect)
// - Jika SIGN_SECRET di-set, hanya link bertanda tangan dari /api/get yang diterima

export const config = { runtime: 'edge', regions: ['sin1'] };

const SECRET = process.env.SIGN_SECRET || '';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const YT_UA = 'com.google.android.youtube/19.09.37 (Linux; U; Android 13) gzip';
const MAX_HOPS = 5;

const MIME = {
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', m4v: 'video/mp4',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg', ogg: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav', weba: 'audio/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function blockedReason(u) {
  if (!/^https?:$/.test(u.protocol)) return 'Protokol tidak diizinkan';
  if (u.port && !['80', '443'].includes(u.port)) return 'Port tidak diizinkan';
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
  return null;
}

async function hmac(msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function upstreamHeaders(u, ref, range) {
  const h = u.hostname;
  const headers = { 'User-Agent': BROWSER_UA, Accept: '*/*', 'Accept-Encoding': 'identity' };
  if (h.includes('googlevideo.com')) headers['User-Agent'] = YT_UA;
  else if (ref) headers.Referer = ref;
  else if (/tiktok|byteoversea|muscdn|tikwm/.test(h)) headers.Referer = 'https://www.tiktok.com/';
  else if (/bilibili|hdslb|bilivideo/.test(h)) headers.Referer = 'https://www.bilibili.com/';
  if (range) headers.Range = range;
  return headers;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const sp = new URL(req.url).searchParams;
  const fileUrl = sp.get('url');
  const ref = sp.get('ref') || '';
  const name = (sp.get('name') || 'download').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 120) || 'download';

  if (!fileUrl) return json(400, { error: 'Parameter url diperlukan' });

  let target;
  try { target = new URL(fileUrl); } catch { return json(400, { error: 'URL tidak valid' }); }

  if (SECRET) {
    const expected = await hmac(fileUrl + '|' + ref);
    const got = sp.get('sig') || '';
    let diff = expected.length ^ got.length;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
    if (diff !== 0) return json(403, { error: 'Signature tidak valid — cari ulang videonya' });
  }

  const bad = blockedReason(target);
  if (bad) return json(403, { error: bad });

  const range = req.headers.get('range');
  let cur = target;
  let resp;

  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      resp = await fetch(cur.href, { headers: upstreamHeaders(cur, ref, range), redirect: 'manual' });
      const loc = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && loc) {
        const next = new URL(loc, cur);
        const why = blockedReason(next);
        if (why) return json(403, { error: 'Redirect ditolak: ' + why });
        cur = next;
        continue;
      }
      break;
    }
  } catch (err) {
    return json(502, { error: 'Gagal terhubung ke server file: ' + err.message });
  }

  if (resp.status >= 300 && resp.status < 400) return json(502, { error: 'Terlalu banyak redirect' });
  if (resp.status !== 200 && resp.status !== 206) {
    const hint = resp.status === 403 || resp.status === 410
      ? ' (link kedaluwarsa atau terikat IP/Referer — cari ulang videonya)'
      : '';
    return json(resp.status === 416 ? 416 : 502, { error: `Server file membalas HTTP ${resp.status}${hint}` });
  }

  const upstreamType = (resp.headers.get('content-type') || '').toLowerCase();
  if (/^(text\/html|application\/json|text\/plain)/.test(upstreamType)) {
    return json(502, { error: 'Server file tidak mengirim media (kemungkinan link kedaluwarsa / diblok). Cari ulang videonya.' });
  }

  const ext = (name.match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase();
  let contentType = upstreamType.split(';')[0].trim();
  if (!contentType || contentType === 'application/octet-stream' || contentType === 'binary/octet-stream') {
    contentType = MIME[ext] || 'application/octet-stream';
  }

  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const k of ['Content-Length', 'Content-Range', 'Last-Modified', 'ETag']) {
    const v = resp.headers.get(k);
    if (v) headers.set(k, v);
  }

  return new Response(resp.body, { status: resp.status, headers });
}
