// api/analyze.js — Metadata ringan (judul / author / thumbnail) lewat oEmbed.
// Dipakai frontend sebagai pelengkap kalau /api/get tidak mengembalikan thumbnail.
// Tidak mengambil link download. Selalu membalas 200 + JSON (field null kalau gagal).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

async function getJson(endpoint) {
  const r = await fetch(endpoint, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, s-maxage=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.method === 'POST' ? (req.body || {}).url : (req.query || {}).url;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const h = hostOf(url);
  const enc = encodeURIComponent(url);
  const sources = [() => getJson(`https://noembed.com/embed?url=${enc}`)];
  if (h.endsWith('tiktok.com')) sources.unshift(() => getJson(`https://www.tiktok.com/oembed?url=${enc}`));
  if (h.endsWith('vimeo.com')) sources.unshift(() => getJson(`https://vimeo.com/api/oembed.json?url=${enc}`));

  const errors = [];
  for (const src of sources) {
    try {
      const d = await src();
      if (d && (d.title || d.thumbnail_url)) {
        return res.status(200).json({
          title: d.title || null,
          author: d.author_name || null,
          thumb: d.thumbnail_url || null,
        });
      }
    } catch (e) { errors.push(e.message); }
  }
  return res.status(200).json({ title: null, author: null, thumb: null, error: errors.join('; ') || 'no metadata' });
};
