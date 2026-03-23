// /api/download.js — Serverless Function
// Coba beberapa cobalt instance publik, fallback ke direct cobalt.tools redirect

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, quality = 'max', audioOnly = false, audioFormat = 'mp3', audioBitrate = '320', codec = 'h264' } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  // Daftar instance publik cobalt — dicoba berurutan
  const INSTANCES = [
    'https://cobalt.seelen.app',
    'https://cobalt.ult.dev',
    'https://cobalt.api.bots.gg',
    'https://cobalt-api.devol.it',
    'https://co.wuk.sh',
  ];

  const payload = {
    url,
    videoQuality: quality === 'max' || quality === 'best' ? 'max' : String(quality),
    audioFormat: audioOnly ? audioFormat : 'mp3',
    audioBitrate: String(audioBitrate),
    downloadMode: audioOnly ? 'audio' : 'auto',
    youtubeVideoCodec: codec || 'h264',
    filenameStyle: 'pretty',
    tiktokFullAudio: true,
    allowH265: false,
  };

  let lastError = null;

  for (const instance of INSTANCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const cobaltRes = await fetch(`${instance}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'VaultDL/1.0 (+https://telegram-drive-one.vercel.app)',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!cobaltRes.ok) {
        lastError = `${instance}: HTTP ${cobaltRes.status}`;
        continue;
      }

      const data = await cobaltRes.json();

      if (data.status === 'error') {
        lastError = data.error?.code || 'error';
        continue;
      }

      if (data.url) {
        return res.status(200).json({
          type: data.status,
          downloadUrl: data.url,
          filename: data.filename || null,
          instance,
        });
      }

      if (data.status === 'picker' && data.picker) {
        return res.status(200).json({
          type: 'picker',
          items: data.picker,
          audioUrl: data.audio || null,
          instance,
        });
      }

    } catch (err) {
      lastError = `${instance}: ${err.message}`;
      continue;
    }
  }

  // Semua instance gagal — kembalikan cobalt.tools URL untuk dibuka manual
  return res.status(200).json({
    type: 'fallback',
    cobaltUrl: `https://cobalt.tools/#${encodeURIComponent(url)}`,
    message: 'Semua instance tidak merespons. Gunakan link fallback.',
    lastError,
  });
};
