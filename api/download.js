// /api/download.js — Vercel Serverless Function (CommonJS)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    url,
    quality = 'max',
    audioOnly = false,
    audioFormat = 'mp3',
    audioBitrate = '320',
    codec = 'h264',
  } = req.body || {};

  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  try { new URL(url); } catch {
    return res.status(400).json({ error: 'URL tidak valid' });
  }

  try {
    const payload = {
      url,
      videoQuality: quality === 'max' || quality === 'best' ? 'max' : String(quality),
      audioFormat: audioOnly ? audioFormat : 'mp3',
      audioBitrate: String(audioBitrate),
      downloadMode: audioOnly ? 'audio' : 'auto',
      youtubeVideoCodec: codec || 'h264',
      filenameStyle: 'pretty',
      disableMetadata: false,
      twitterGif: false,
      tiktokFullAudio: true,
      allowH265: false,
    };

    const cobaltRes = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!cobaltRes.ok) {
      return res.status(502).json({
        error: 'Cobalt API tidak merespons',
        message: `HTTP ${cobaltRes.status}`,
      });
    }

    const data = await cobaltRes.json();

    if (data.status === 'error') {
      return res.status(400).json({
        error: 'Video tidak dapat diproses',
        message: data.error?.code || 'Coba URL lain atau kualitas berbeda',
        code: data.error?.code,
      });
    }

    // stream atau redirect → ada URL download
    if (data.url) {
      return res.status(200).json({
        type: data.status,
        downloadUrl: data.url,
        filename: data.filename || null,
      });
    }

    // picker → multiple media (carousel)
    if (data.status === 'picker' && data.picker) {
      return res.status(200).json({
        type: 'picker',
        items: data.picker,
        audioUrl: data.audio || null,
      });
    }

    return res.status(200).json({ type: data.status, raw: data });

  } catch (err) {
    console.error('Download error:', err.message);
    return res.status(500).json({
      error: 'Server error',
      message: err.message,
    });
  }
};
