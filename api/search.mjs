// /api/search?q=kata[&p=yt|sc|bili][&c=TOKEN]  → { ok, items:[{id,url?,title,channel,dur,views,thumb}], next }
// /api/search?s=1&q=ket                         → saran kata kunci
// yt  : endpoint InnerTube YouTube (tidak resmi, tanpa API key)
// sc/bili : diteruskan ke /api/xsearch (Python, yt-dlp) dengan x-internal-key = SIGN_SECRET
// Rate limit memakai ../lib/store (Redis/KV bersama bila ada) — sama dengan /api/get.
// Env opsional: SEARCH_RATE (default 40/menit/IP), XSEARCH_RATE (default 15/menit/IP).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let store = null;
try { store = require('../lib/store'); } catch { /* lib/store tidak ada → pakai memori */ }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CTX = { client: { clientName: 'WEB', clientVersion: '2.20250925.01.00', hl: 'id', gl: 'ID' } };
const RATE = Number(process.env.SEARCH_RATE) || 40;
const RATE_X = Number(process.env.XSEARCH_RATE) || 15;
const MEM = new Map();

async function limited(key, max) {
  if (store && typeof store.rateLimit === 'function') {
    try { const r = await store.rateLimit(key, max, 60); return r.ok ? 0 : Math.max(1, r.retryAfter || 30); } catch { /* fallback */ }
  }
  const now = Date.now(), e = MEM.get(key);
  if (!e || now > e.t) {
    if (MEM.size > 5000) for (const [k, v] of MEM) if (now > v.t) MEM.delete(k);
    MEM.set(key, { t: now + 60000, n: 1 }); return 0;
  }
  return ++e.n > max ? Math.ceil((e.t - now) / 1000) : 0;
}
const clientIp = req => (store && store.clientIp)
  ? store.clientIp(req)
  : String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '?').split(',')[0].trim();
const txt = o => o ? (o.simpleText || (o.runs || []).map(r => r.text).join('') || '') : '';

function pick(d) {
  const items = []; let next = '';
  const scan = arr => { for (const c of arr || []) {
    if (c.itemSectionRenderer) scan(c.itemSectionRenderer.contents);
    else if (c.videoRenderer && c.videoRenderer.videoId) {
      const v = c.videoRenderer;
      items.push({ id: v.videoId, title: txt(v.title), channel: txt(v.ownerText || v.longBylineText),
        dur: txt(v.lengthText), views: txt(v.shortViewCountText || v.viewCountText),
        thumb: 'https://i.ytimg.com/vi/' + v.videoId + '/mqdefault.jpg' });
    } else if (c.continuationItemRenderer) {
      next = c.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || next;
    }
  } };
  scan(d?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents);
  for (const a of d?.onResponseReceivedCommands || []) scan(a.appendContinuationItemsAction?.continuationItems);
  return { items, next };
}

export default async function handler(req, res) {
  const Q = req.query || {};
  const q = String(Q.q || '').trim().slice(0, 120);
  const c = String(Q.c || '').slice(0, 4000);
  const p = ['sc', 'bili'].includes(Q.p) ? Q.p : 'yt';
  const sug = !!Q.s;
  const send = (code, obj, cache) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (cache) res.setHeader('cache-control', cache);
    res.statusCode = code; res.end(JSON.stringify(obj));
  };
  const sf = req.headers['sec-fetch-site'];
  if (sf && sf !== 'same-origin' && sf !== 'none') return send(403, { ok: false, error: 'Forbidden' });
  if (!q && !c) return send(400, { ok: false, error: 'Parameter q kosong' });

  const ip = clientIp(req);
  const wait = await limited((sug ? 'sg:' : p === 'yt' ? 'ys:' : 'xs:') + ip, sug ? RATE * 3 : p === 'yt' ? RATE : RATE_X);
  if (wait) { res.setHeader('retry-after', String(wait)); return send(429, { ok: false, error: 'Terlalu banyak permintaan' }); }

  if (sug) {
    try {
      const r = await fetch('https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=id&q=' + encodeURIComponent(q), { headers: { 'user-agent': UA } });
      const d = await r.json();
      return send(200, { ok: true, items: (d[1] || []).slice(0, 8).map(String) }, 'public, s-maxage=3600');
    } catch { return send(200, { ok: true, items: [] }); }
  }

  try {
    if (p !== 'yt') {
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const page = c ? Math.min(3, Math.max(2, parseInt(c.replace(/^p:/, ''), 10) || 2)) : 1;
      const headers = { accept: 'application/json' };
      if (process.env.SIGN_SECRET) headers['x-internal-key'] = process.env.SIGN_SECRET;
      const r = await fetch(`https://${host}/api/xsearch?q=${encodeURIComponent(q)}&p=${p}&page=${page}`, { headers, signal: AbortSignal.timeout(28000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'xsearch HTTP ' + r.status);
      const items = j.items || [];
      return send(200, { ok: true, q, items, next: items.length && page < 3 ? 'p:' + (page + 1) : '' }, 'public, s-maxage=600, stale-while-revalidate=60');
    }
    const body = c ? { context: CTX, continuation: c } : { context: CTX, query: q, params: 'EgIQAQ==' };
    const r = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA, 'accept-language': 'id-ID,id;q=0.9,en;q=0.8' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('YouTube HTTP ' + r.status);
    const { items, next } = pick(await r.json());
    return send(200, { ok: true, q, items, next }, 'public, s-maxage=600, stale-while-revalidate=60');
  } catch (e) {
    return send(502, { ok: false, error: String((e && e.message) || e) });
  }
}
