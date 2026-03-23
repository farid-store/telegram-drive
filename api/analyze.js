// /api/analyze.js — hanya ambil metadata via noembed (TANPA panggil cobalt)
// Cobalt hanya dipanggil saat user klik download di /api/download

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  let parsedUrl;
  try { parsedUrl = new URL(url); }
  catch { return res.status(400).json({ error: 'URL tidak valid' }); }

  const platform = detectPlatform(parsedUrl.hostname);

  // Ambil metadata via noembed — ringan, tidak perlu cobalt
  let meta = { title: extractTitle(url, parsedUrl), author: null, thumbnail: null };
  try {
    const r = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'VaultDL/1.0' },
    });
    const d = await r.json();
    if (d.title) {
      meta = {
        title: d.title,
        author: d.author_name || null,
        thumbnail: d.thumbnail_url || null,
        provider: d.provider_name || platform,
      };
    }
  } catch {}

  return res.status(200).json({ platform, url, meta });
};

function extractTitle(url, parsedUrl) {
  try {
    const v = parsedUrl.searchParams.get('v');
    if (v) return `YouTube Video`;
    const parts = parsedUrl.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1]?.replace(/[-_]/g, ' ') || 'Video';
  } catch { return 'Video'; }
}

function detectPlatform(hostname) {
  const h = hostname.replace('www.', '');
  const map = {
    'youtube.com': 'YouTube', 'youtu.be': 'YouTube',
    'tiktok.com': 'TikTok', 'instagram.com': 'Instagram',
    'facebook.com': 'Facebook', 'fb.watch': 'Facebook',
    'twitter.com': 'Twitter/X', 'x.com': 'Twitter/X',
    'vimeo.com': 'Vimeo', 'dailymotion.com': 'Dailymotion',
    'reddit.com': 'Reddit', 'twitch.tv': 'Twitch',
    'soundcloud.com': 'SoundCloud', 'bilibili.com': 'Bilibili',
    'pinterest.com': 'Pinterest', 'tumblr.com': 'Tumblr',
  };
  for (const [domain, name] of Object.entries(map)) {
    if (h.includes(domain)) return name;
  }
  return h.split('.')[0] || 'Video';
}
