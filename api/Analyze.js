// /api/analyze.js — Vercel Serverless Function
// Mengambil info video dari cobalt.tools API (gratis, open source)

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'URL diperlukan' });
  }

  // Validasi URL
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'URL tidak valid' });
  }

  // Deteksi platform
  const platform = detectPlatform(parsedUrl.hostname);

  try {
    // Cobalt API v7 — gratis, open source, no auth needed
    // Docs: https://github.com/imputnet/cobalt
    const cobaltResponse = await fetch('https://api.cobalt.tools/', {
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

    if (!cobaltResponse.ok) {
      throw new Error(`Cobalt API error: ${cobaltResponse.status}`);
    }

    const data = await cobaltResponse.json();

    // Cobalt response types: stream, redirect, picker, error
    if (data.status === 'error') {
      return res.status(400).json({
        error: data.error?.code || 'Video tidak dapat diproses',
        message: getErrorMessage(data.error?.code),
      });
    }

    // Build response
    const result = {
      platform: platform,
      url: url,
      status: data.status,
      // Jika cobalt langsung kasih download URL
      downloadUrl: data.url || null,
      // Jika ada pilihan media (picker mode — e.g. Instagram carousel)
      picker: data.picker || null,
      // Audio only URL
      audioUrl: data.audio || null,
      // Simulate video metadata (cobalt tidak return metadata title)
      // Untuk metadata lengkap perlu noembed / oEmbed API
      meta: await getVideoMeta(url, parsedUrl.hostname),
    };

    return res.status(200).json(result);

  } catch (err) {
    console.error('Analyze error:', err);

    // Fallback: coba ambil metadata saja via noembed
    try {
      const meta = await getVideoMeta(url, parsedUrl.hostname);
      return res.status(200).json({
        platform,
        url,
        status: 'meta_only',
        meta,
        error: 'Download otomatis tidak tersedia, coba manual',
      });
    } catch {
      return res.status(500).json({
        error: 'Gagal menganalisa video',
        message: err.message,
      });
    }
  }
}

// ========================
// Get video metadata via noembed.com (YouTube, Vimeo, TikTok, dll)
// ========================
async function getVideoMeta(url, hostname) {
  try {
    const noembedUrl = `https://noembed.com/embed?url=${encodeURIComponent(url)}`;
    const r = await fetch(noembedUrl, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();

    return {
      title: d.title || extractTitleFromUrl(url),
      author: d.author_name || 'Unknown',
      thumbnail: d.thumbnail_url || null,
      width: d.width || null,
      height: d.height || null,
    };
  } catch {
    return {
      title: extractTitleFromUrl(url),
      author: 'Unknown',
      thumbnail: null,
    };
  }
}

function extractTitleFromUrl(url) {
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if (v) return `YouTube Video (${v})`;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'Video';
  } catch {
    return 'Video';
  }
}

function detectPlatform(hostname) {
  const h = hostname.replace('www.', '');
  const map = {
    'youtube.com': 'YouTube',
    'youtu.be': 'YouTube',
    'tiktok.com': 'TikTok',
    'instagram.com': 'Instagram',
    'facebook.com': 'Facebook',
    'fb.watch': 'Facebook',
    'twitter.com': 'Twitter/X',
    'x.com': 'Twitter/X',
    'vimeo.com': 'Vimeo',
    'dailymotion.com': 'Dailymotion',
    'reddit.com': 'Reddit',
    'twitch.tv': 'Twitch',
    'soundcloud.com': 'SoundCloud',
    'bilibili.com': 'Bilibili',
    'pinterest.com': 'Pinterest',
    'tumblr.com': 'Tumblr',
    'ok.ru': 'OK.ru',
    'rutube.ru': 'Rutube',
  };
  for (const [domain, name] of Object.entries(map)) {
    if (h.includes(domain)) return name;
  }
  return h;
}

function getErrorMessage(code) {
  const messages = {
    'error.api.unreachable': 'Server tidak dapat dijangkau saat ini',
    'error.api.link.invalid': 'URL tidak valid atau tidak didukung',
    'error.api.link.unsupported': 'Platform ini belum didukung',
    'error.api.fetch.fail': 'Gagal mengambil data dari platform',
    'error.api.content.too_long': 'Video terlalu panjang untuk diproses',
    'error.api.content.video.unavailable': 'Video tidak tersedia atau privat',
    'error.api.youtube.login': 'Video YouTube membutuhkan login',
    'error.api.youtube.age': 'Video YouTube memiliki batasan usia',
    'error.api.youtube.region': 'Video tidak tersedia di region ini',
    'error.api.rate_exceeded': 'Terlalu banyak request, coba beberapa saat lagi',
  };
  return messages[code] || 'Terjadi kesalahan saat memproses video';
}
