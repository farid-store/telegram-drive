// api/browse.js — Proxy web untuk Browser VaultDL (membuka situs apa pun di dalam aplikasi).
//
//   GET/POST /api/browse?u=<url>[&dns=system|cloudflare|google|quad9|custom][&doh=<url DoH JSON>]
//   GET      /api/browse?ping=1                      → cek proxy aktif
//   GET      /api/browse?dnstest=<host>&dns=...      → uji DNS yang dipilih (IP + waktu)
//
// Cara kerja: server mengambil halaman, membuang header pemblokir iframe (X-Frame-Options/CSP),
// menulis ulang semua link/sumber agar lewat proxy ini, dan menyisipkan skrip kecil yang membuat
// fetch/XHR/klik/form tetap lewat proxy. Halaman berjalan di iframe ber-sandbox TANPA allow-same-origin,
// jadi skrip situs lain tidak bisa menyentuh localStorage/akun aplikasi Anda.
//
// KETERBATASAN: tanpa cookie/login (stateless), situs berat-JS (YouTube, Instagram, TikTok, Google login)
// bisa rusak, video/audio besar diblokir (hemat bandwidth) — gunakan tombol Grab untuk itu.
//
// AKSES: bila SIGN_SECRET/BROWSE_SECRET di-set, setiap permintaan butuh token &k= (dibuat oleh /api/browse?mint=1
//   dari halaman aplikasi sendiri, berlaku ±6 jam) agar proxy tidak dipakai situs lain.
// KEAMANAN: SSRF diblokir (IP privat/loopback/metadata ditolak SESUDAH resolusi DNS, di titik koneksi),
// ukuran dibatasi, rate limit memakai ../lib/store bila ada. Matikan total dengan env BROWSE_ENABLED=0.
// ENV: BROWSE_ENABLED (default aktif), BROWSE_RATE (default 400 permintaan/menit/IP),
//      BROWSE_ALLOW_PRIVATE=1 (HANYA untuk pengujian lokal — jangan diisi di produksi).

const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const dns = require('dns');
let store = null;
try { store = require('../lib/store'); } catch { /* tanpa store → pakai memori */ }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_HTML = 4 * 1024 * 1024;
const MAX_BODY = 10 * 1024 * 1024;
const MAX_POST = 1024 * 1024;
const MAX_REDIR = 5;
const TIMEOUT = 15000;
const RATE = Number(process.env.BROWSE_RATE) || 400;
const SECRET = process.env.BROWSE_SECRET || process.env.SIGN_SECRET || '';
const TTL = 6 * 3600 * 1000;
const sign = exp => crypto.createHmac('sha256', SECRET).update('browse:' + exp).digest('hex').slice(0, 24);
const mint = () => { const exp = Math.ceil((Date.now() + TTL) / 3600000) * 3600000; return exp + '.' + sign(exp); };
const tokenOk = k => { if (!SECRET) return true; const [e, m] = String(k || '').split('.'); return Number(e) > Date.now() && m && m === sign(e); };
const ALLOW_PRIVATE = process.env.BROWSE_ALLOW_PRIVATE === '1';
const DOH = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/resolve',
  quad9: 'https://dns.quad9.net:5053/dns-query',
};

/* ---------------- keamanan jaringan ---------------- */
function isPrivate(ip) {
  if (ALLOW_PRIVATE) return false;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    if (l.startsWith('::ffff:')) { const v4 = l.slice(7); return net.isIPv4(v4) ? isPrivate(v4) : true; }
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

async function doh(server, host) {
  const u = new URL(server);
  u.searchParams.set('name', host); u.searchParams.set('type', 'A');
  const r = await fetch(u, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) });
  const j = await r.json();
  return (j.Answer || []).filter(a => a.type === 1).map(a => a.data);
}

async function resolveHost(host, mode, custom) {
  if (net.isIP(host)) {
    if (isPrivate(host)) throw new Error('Alamat privat diblokir');
    return host;
  }
  let ips = [];
  if (mode && mode !== 'system') {
    try {
      let server = DOH[mode];
      if (mode === 'custom') {
        const cu = new URL(custom || '');
        if (cu.protocol !== 'https:' && !ALLOW_PRIVATE) throw new Error('DoH kustom harus https');
        if (net.isIP(cu.hostname) && isPrivate(cu.hostname)) throw new Error('DoH privat');
        server = cu.href;
      }
      if (server) ips = await doh(server, host);
    } catch { /* jatuh ke DNS sistem */ }
  }
  if (!ips.length) {
    let r;
    try { r = await dns.promises.lookup(host, { all: true, family: 4 }); }
    catch { r = await dns.promises.lookup(host, { all: true }); }
    ips = r.map(x => x.address);
  }
  ips = ips.filter(ip => !isPrivate(ip));
  if (!ips.length) throw new Error('Alamat situs tidak ditemukan atau mengarah ke jaringan privat');
  return ips[0];
}

function upstream(urlStr, { method, body, headers, dnsMode, dohUrl }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    // Node TIDAK memanggil `lookup` untuk alamat IP literal → periksa sendiri (cegah SSRF ke 127.0.0.1, 169.254.x, dll.)
    const lit = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(lit) && isPrivate(lit)) return reject(new Error('Alamat privat diblokir'));
    const lib = u.protocol === 'https:' ? https : http;
    const lookup = (h, o, cb) => {
      resolveHost(h, dnsMode, dohUrl).then(
        ip => { const fam = net.isIPv6(ip) ? 6 : 4; (o && o.all) ? cb(null, [{ address: ip, family: fam }]) : cb(null, ip, fam); },
        err => cb(err),
      );
    };
    const req = lib.request(u, { method, headers, lookup, timeout: TIMEOUT }, resolve);
    req.on('timeout', () => req.destroy(new Error('Situs terlalu lama merespons')));
    req.on('error', reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

/* ---------------- penulisan ulang ---------------- */
const SKIP = /^(#|data:|blob:|javascript:|mailto:|tel:|about:|sms:)/i;
function makeProx(base, q) {
  return u => {
    try {
      if (u == null) return u;
      const t = String(u).trim();
      if (!t || SKIP.test(t)) return u;
      return '/api/browse?u=' + encodeURIComponent(new URL(t, base).href) + q;
    } catch { return u; }
  };
}
function rewriteCss(css, prox) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, qt, u) => `url(${qt}${prox(u)}${qt})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, qt, u) => `@import ${qt}${prox(u)}${qt}`);
}

function runtime(cur, q) {
  return `(function(){
var CUR=${JSON.stringify(cur)},Q=${JSON.stringify(q)},HOST=location.href.split('/api/browse')[0],B='/api/browse?u=';
var SK=/^(#|data:|blob:|javascript:|mailto:|tel:|about:)/i;
function px(u){try{var s=String(u);if(SK.test(s))return u;var a=new URL(s,CUR).href;if(a.indexOf(HOST+'/api/browse')===0)return a;return HOST+B+encodeURIComponent(a)+Q}catch(e){return u}}
function real(u){try{var x=new URL(u,location.href);if(x.pathname==='/api/browse'&&x.searchParams.get('u'))return x.searchParams.get('u')}catch(e){}return u}
function say(t,extra){try{var m={vdlBw:1,t:t};for(var k in extra)m[k]=extra[k];parent.postMessage(m,'*')}catch(e){}}
function nav(){say('nav',{url:CUR,title:document.title||''})}
try{localStorage.getItem('x')}catch(e){var M=function(){var d={};return{getItem:function(k){return k in d?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}};try{Object.defineProperty(window,'localStorage',{value:M(),configurable:true});Object.defineProperty(window,'sessionStorage',{value:M(),configurable:true})}catch(e2){}}
try{document.cookie}catch(e){var ck='';try{Object.defineProperty(document,'cookie',{get:function(){return ck},set:function(v){ck=String(v).split(';')[0]},configurable:true})}catch(e3){}}
var _f=window.fetch;if(_f)window.fetch=function(i,o){try{if(typeof i==='string'||i instanceof URL)i=px(i);else if(i&&i.url)i=new Request(px(i.url),i)}catch(e){}return _f.call(this,i,o)};
var _x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=px(u);return _x.apply(this,arguments)};
[[HTMLImageElement,'src'],[HTMLScriptElement,'src'],[HTMLIFrameElement,'src'],[HTMLSourceElement,'src'],[HTMLLinkElement,'href'],[HTMLAnchorElement,'href'],[HTMLFormElement,'action'],[HTMLEmbedElement,'src']].forEach(function(p){try{var d=Object.getOwnPropertyDescriptor(p[0].prototype,p[1]);if(!d||!d.set)return;Object.defineProperty(p[0].prototype,p[1],{get:function(){return real(d.get.call(this))},set:function(v){d.set.call(this,px(v))},configurable:true})}catch(e){}});
var _sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if(/^(src|href|action|poster)$/i.test(n)&&typeof v==='string')v=px(v);return _sa.call(this,n,v)};
window.open=function(u){if(u)say('open',{url:new URL(String(u),CUR).href});return null};
['pushState','replaceState'].forEach(function(k){var o=history[k];history[k]=function(s,t,u){if(u!=null){try{CUR=new URL(String(u),CUR).href;u=px(CUR);nav()}catch(e){}}return o.call(this,s,t,u)}});
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var t=a.getAttribute('target');if(t==='_blank'||e.ctrlKey||e.metaKey||e.shiftKey){e.preventDefault();say('open',{url:real(a.href)})}},true);
document.addEventListener('submit',function(e){var f=e.target;if(!f||String(f.method||'get').toLowerCase()!=='get')return;e.preventDefault();try{var u=new URL(real(f.action)||CUR,CUR);u.search='';new FormData(f).forEach(function(v,k){if(typeof v==='string')u.searchParams.append(k,v)});location.href=px(u.href)}catch(x){}},true);
function watch(){try{var t=document.querySelector('title');if(t)new MutationObserver(nav).observe(t,{childList:true,characterData:true,subtree:true})}catch(e){}}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){watch();nav()});else{watch();nav()}
window.addEventListener('load',nav);
})();`;
}

function rewriteHtml(html, finalUrl, q) {
  let base = finalUrl;
  const bm = html.match(/<base\s[^>]*href\s*=\s*("([^"]*)"|'([^']*)')/i);
  if (bm) { try { base = new URL(bm[2] ?? bm[3], finalUrl).href; } catch { /* abaikan */ } }
  const prox = makeProx(base, q);
  let out = html
    .replace(/<base\s[^>]*>/gi, '')
    .replace(/<meta\s[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
    .replace(/\s(integrity|nonce|crossorigin)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(\s)(href|src|action|poster|data-src|data-original|data-href)\s*=\s*("([^"]*)"|'([^']*)')/gi,
      (m, sp, attr, whole, d, s) => { const v = d ?? s; const q2 = d != null ? '"' : "'"; return `${sp}${attr}=${q2}${prox(v.replace(/&amp;/g, '&')).replace(/&/g, '&amp;')}${q2}`; })
    .replace(/(\s)(srcset|data-srcset)\s*=\s*("([^"]*)"|'([^']*)')/gi,
      (m, sp, attr, whole, d, s) => {
        const v = d ?? s; const q2 = d != null ? '"' : "'";
        const list = v.split(',').map(part => { const t = part.trim(); if (!t) return t; const [u, ...rest] = t.split(/\s+/); return [prox(u).replace(/&/g, '&amp;'), ...rest].join(' '); }).join(', ');
        return `${sp}${attr}=${q2}${list}${q2}`;
      })
    .replace(/(<meta\s[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'])(\s*\d+\s*;\s*url\s*=\s*)([^"']+)/i,
      (m, a, b, u) => a + b + prox(u))
    .replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (m, a, css) => `<style${a}>${rewriteCss(css, prox)}</style>`)
    .replace(/(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi, (m, a, whole, d, s) => {
      const v = d ?? s; const q2 = d != null ? '"' : "'";
      return `${a}${q2}${rewriteCss(v, prox)}${q2}`;
    });
  const inj = `<script>${runtime(finalUrl, q)}</script>`;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, m => m + inj);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, m => m + inj);
  else out = inj + out;
  return out;
}

function decode(buf, ct) {
  let label = (ct.match(/charset=([\w-]+)/i) || [])[1];
  if (!label) label = (buf.slice(0, 2048).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  try { return new TextDecoder(label || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

/* ---------------- utilitas ---------------- */
const MEM = new Map();
async function limited(key, max) {
  if (store && typeof store.rateLimit === 'function') {
    try { const r = await store.rateLimit(key, max, 60); return r.ok ? 0 : Math.max(1, r.retryAfter || 30); } catch { /* fallback */ }
  }
  const now = Date.now(), e = MEM.get(key);
  if (!e || now > e.t) { if (MEM.size > 5000) for (const [k, v] of MEM) if (now > v.t) MEM.delete(k); MEM.set(key, { t: now + 60000, n: 1 }); return 0; }
  return ++e.n > max ? Math.ceil((e.t - now) / 1000) : 0;
}
const clientIp = req => (store && store.clientIp) ? store.clientIp(req)
  : String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '?').split(',')[0].trim();

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function errorPage(res, code, msg, target) {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gagal membuka</title>
<body style="margin:0;background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px">
<div style="max-width:420px"><div style="font-size:40px">⚠️</div><h2 style="margin:8px 0">Halaman tidak bisa dibuka lewat proxy</h2>
<p style="color:#9ca3af;line-height:1.6;font-size:14px">${esc(msg)}</p>${target ? `<p style="color:#6b7280;font-size:12px;word-break:break-all">${esc(target)}</p>` : ''}
<p style="color:#9ca3af;font-size:13px">Coba ganti DNS di pengaturan (🛡) atau buka lewat jendela terpisah (↗).</p></div></body>`;
  res.statusCode = code;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('content-security-policy', 'sandbox allow-scripts');
  res.setHeader('access-control-allow-origin', '*');
  res.end(body);
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('Body terlalu besar')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function collect(stream, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    stream.on('data', c => { n += c.length; if (n > max) { stream.destroy(); reject(new Error('Halaman terlalu besar')); } else chunks.push(c); });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/* ---------------- handler ---------------- */
module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const Q = Object.fromEntries(url.searchParams);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (process.env.BROWSE_ENABLED === '0') { res.statusCode = 503; res.setHeader('content-type', 'application/json'); return res.end('{"ok":false,"error":"Proxy dinonaktifkan"}'); }
  if (Q.ping) { res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); return res.end('{"ok":true}'); }

  const sf = req.headers['sec-fetch-site'];
  if (Q.mint) {   // token hanya untuk halaman aplikasi sendiri (browser menegakkan same-origin; tanpa CORS)
    res.removeHeader('access-control-allow-origin');
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    if (sf && !['same-origin', 'none'].includes(sf)) { res.statusCode = 403; return res.end('{"ok":false}'); }
    return res.end(JSON.stringify({ ok: true, k: SECRET ? mint() : '' }));
  }
  if (!tokenOk(Q.k)) { res.statusCode = 403; res.setHeader('content-type', 'text/plain'); return res.end('Token proxy tidak valid / kedaluwarsa. Muat ulang Browser.'); }
  const wait = await limited('br:' + clientIp(req), RATE);
  if (wait) { res.setHeader('retry-after', String(wait)); return errorPage(res, 429, 'Terlalu banyak permintaan. Tunggu sebentar.'); }

  const dnsMode = ['cloudflare', 'google', 'quad9', 'custom'].includes(Q.dns) ? Q.dns : 'system';
  const dohUrl = Q.doh || '';
  const qs = (SECRET && Q.k ? '&k=' + encodeURIComponent(Q.k) : '') + (dnsMode === 'system' ? '' : '&dns=' + dnsMode + (dnsMode === 'custom' ? '&doh=' + encodeURIComponent(dohUrl) : ''));

  if (Q.dnstest) {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    const t0 = Date.now();
    try { const ip = await resolveHost(String(Q.dnstest).slice(0, 253), dnsMode, dohUrl); return res.end(JSON.stringify({ ok: true, ip, ms: Date.now() - t0, dns: dnsMode })); }
    catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message, ms: Date.now() - t0, dns: dnsMode })); }
  }

  let target;
  try { target = new URL(String(Q.u || '')); if (!/^https?:$/.test(target.protocol)) throw 0; }
  catch { return errorPage(res, 400, 'Alamat tidak valid. Gunakan http:// atau https://', Q.u); }

  let method = req.method === 'POST' ? 'POST' : 'GET';
  let body = null;
  const ctIn = req.headers['content-type'];
  try { if (method === 'POST') body = await readBody(req, MAX_POST); } catch (e) { return errorPage(res, 413, e.message); }

  let cur = target.href, up;
  try {
    for (let hop = 0; ; hop++) {
      const h = { 'user-agent': UA, accept: req.headers.accept || '*/*', 'accept-language': 'id,en;q=0.8', 'accept-encoding': 'identity' };
      if (body && body.length) { h['content-type'] = ctIn || 'application/x-www-form-urlencoded'; h['content-length'] = body.length; }
      up = await upstream(cur, { method, body, headers: h, dnsMode, dohUrl });
      const loc = up.headers.location;
      if ([301, 302, 303, 307, 308].includes(up.statusCode) && loc && hop < MAX_REDIR) {
        up.resume(); cur = new URL(loc, cur).href;
        if (up.statusCode === 303 || ((up.statusCode === 301 || up.statusCode === 302) && method === 'POST')) { method = 'GET'; body = null; }
        continue;
      }
      break;
    }
  } catch (e) { return errorPage(res, 502, e.message || 'Gagal terhubung', target.href); }

  const ct = String(up.headers['content-type'] || '').toLowerCase();
  res.setHeader('x-final-url', cur);
  res.setHeader('cache-control', up.headers['cache-control'] && !/no-store|private/i.test(up.headers['cache-control']) ? up.headers['cache-control'] : 'no-cache');
  try {
    if (/^(video|audio)\//.test(ct) || /mpegurl|dash\+xml/.test(ct)) {
      up.destroy();
      return errorPage(res, 415, 'Video/audio tidak dialirkan lewat proxy (hemat bandwidth). Gunakan tombol ⬇ Grab di Browser untuk mengunduhnya.', cur);
    }
    if (/^text\/html|application\/xhtml/.test(ct)) {
      const buf = await collect(up, MAX_HTML);
      const out = rewriteHtml(decode(buf, ct), cur, qs);
      res.statusCode = up.statusCode || 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-security-policy', 'sandbox allow-scripts allow-forms allow-popups allow-presentation');
      return res.end(out);
    }
    if (/^text\/css/.test(ct)) {
      const buf = await collect(up, MAX_HTML);
      const out = rewriteCss(decode(buf, ct), makeProx(cur, qs));
      res.statusCode = up.statusCode || 200;
      res.setHeader('content-type', 'text/css; charset=utf-8');
      return res.end(out);
    }
    // aset lain (gambar, font, js, json, pdf…): alirkan dengan batas ukuran
    const len = Number(up.headers['content-length'] || 0);
    if (len > MAX_BODY) { up.destroy(); return errorPage(res, 413, 'File terlalu besar untuk dibuka lewat proxy.', cur); }
    res.statusCode = up.statusCode || 200;
    if (ct) res.setHeader('content-type', up.headers['content-type']);
    if (up.headers['content-disposition']) res.setHeader('content-disposition', up.headers['content-disposition']);
    let n = 0;
    up.on('data', c => { n += c.length; if (n > MAX_BODY) { up.destroy(); res.destroy(); } });
    up.pipe(res);
  } catch (e) {
    if (!res.headersSent) return errorPage(res, 502, e.message || 'Gagal membaca halaman', cur);
    res.destroy();
  }
};
