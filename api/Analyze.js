// /api/analyze.js — Vercel Serverless Function (CommonJS)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'URL tidak valid' });
  }

  const platform = detectPlatform(parsedUrl.hostname);

  try {
    // Cobalt API v7
    const cobaltRes = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        url: url,
        videoQuality: 'max',
        audioFormat: 'mp3',
        audioBitrate: '320',
        downloadMode: 'auto',
        youtubeVideoCodec: 'h264',
        filenameStyle: 'pretty',
        disableMetadata: false,
        twitterGif: false,
        tiktokFullAudio: true,
      }),
    });

    const data = await cobaltRes.json();

    if (data.status === 'error') {
      const meta = await getVideoMeta(url);
      return res.status(200).json({
        platform,
        url,
        status: 'meta_only',
        meta,
        cobaltError: data.error,
      });
    }

    const meta = await getVideoMeta(url);

    return res.status(200).json({
      platform,
      url,
      status: data.status,
      downloadUrl: data.url || null,
      picker: data.picker || null,
      audioUrl: data.audio || null,
      filename: data.filename || null,
      meta,
    });

  } catch (err) {
    console.error('Analyze error:', err.message);
    try {
      const meta = await getVideoMeta(url);
      return res.status(200).json({
        platform, url, status: 'meta_only', meta,
        cobaltError: { message: err.message },
      });
    } catch {
      return res.status(500).json({ error: 'Server error', message: err.message });
    }
  }
};

async function getVideoMeta(url) {
  try {
    const r = await fetch(
      `https://noembed.com/embed?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const d = await r.json();
    return {
      title: d.title || extractTitle(url),
      author: d.author_name || null,
      thumbnail: d.thumbnail_url || null,
    };
  } catch {
    return { title: extractTitle(url), author: null, thumbnail: null };
  }
}

function extractTitle(url) {
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if (v) return `YouTube Video (${v})`;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'Video';
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
  return h;
}
