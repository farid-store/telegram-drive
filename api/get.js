// api/get.js — Vercel serverless proxy ke Ryzumi API
// Browser tidak bisa langsung fetch api.ryzumi.net karena CORS
// Vercel server bisa — jadi kita proxy lewat sini

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Parameter url diperlukan' });

  try { new URL(url); } catch {
    return res.status(400).json({ error: 'URL tidak valid' });
  }

  try {
    const apiUrl = `https://api.ryzumi.net/api/downloader/all-in-one?url=${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://api.ryzumi.net/',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Ryzumi API error: HTTP ${response.status}`,
      });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({
      error: 'Gagal menghubungi Ryzumi API',
      detail: err.message,
    });
  }
};
