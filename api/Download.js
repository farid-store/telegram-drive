// /api/download.js — Vercel Serverless Function
// Generate download link dengan kualitas & format pilihan

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    url,
    quality = 'max',      // max, 2160, 1080, 720, 480, 360, 240, 144
    format = 'mp4',        // mp4, webm
    audioOnly = false,
    audioFormat = 'mp3',   // mp3, ogg, wav, opus, flac, best
    audioBitrate = '320',  // 320, 256, 192, 128, 96, 64, 8
    subtitles = false,
    codec = 'h264',        // h264, av1, vp9
  } = req.body || {};

  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'URL tidak valid' });
  }

  try {
    const payload = {
      url,
      videoQuality: quality === 'best' ? 'max' : quality,
      audioFormat: audioOnly ? audioFormat : 'mp3',
      audioBitrate,
      downloadMode: audioOnly ? 'audio' : 'auto',
      youtubeVideoCodec: codec,
      filenameStyle: 'pretty',
      disableMetadata: false,
      twitterGif: false,
      tiktokFullAudio: !audioOnly,
      allowH265: codec !== 'h264',
    };

    const cobaltResponse = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!cobaltResponse.ok) {
      throw new Error(`Cobalt API error: ${cobaltResponse.status}`);
    }

    const data = await cobaltResponse.json();

    if (data.status === 'error') {
      return res.status(400).json({
        error: data.error?.code || 'Gagal memproses',
        message: data.error?.code
          ? `Error: ${data.error.code}`
          : 'Video tidak dapat diunduh saat ini',
      });
    }

    // === RESPONSE TYPES ===

    // 1. stream — Cobalt perlu proxy stream (URL sementara dari cobalt)
    if (data.status === 'stream' || data.status === 'tunnel') {
      return res.status(200).json({
        type: 'stream',
        downloadUrl: data.url,
        filename: data.filename,
      });
    }

    // 2. redirect — langsung ke CDN platform (direct link)
    if (data.status === 'redirect') {
      return res.status(200).json({
        type: 'redirect',
        downloadUrl: data.url,
        filename: data.filename,
      });
    }

    // 3. picker — multiple media (e.g. Instagram carousel, Twitter multi-image)
    if (data.status === 'picker') {
      return res.status(200).json({
        type: 'picker',
        items: data.picker,
        audioUrl: data.audio,
      });
    }

    // Fallback
    return res.status(200).json({
      type: 'unknown',
      raw: data,
    });

  } catch (err) {
    console.error('Download error:', err);
    return res.status(500).json({
      error: 'Gagal membuat link download',
      message: err.message,
    });
  }
}
