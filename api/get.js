// api/get.js — Serverless function, region: sin1 (Singapore)
// Ryzumi server juga di Singapore (cf-ray: SIN) → tidak diblokir

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Parameter url diperlukan' });

  try { new URL(url); } catch {
    return res.status(400).json({ error: 'URL tidak valid' });
  }

  const apiUrl = `https://api.ryzumi.net/api/downloader/all-in-one?url=${encodeURIComponent(url)}`;

  try {
    const response = await fetch(apiUrl, {
      // Header persis sama seperti curl documentation Ryzumi
      headers: {
        'accept': 'application/json',
        'User-Agent': 'curl/8.7.1',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return res.status(response.status).json({
        error: `Ryzumi error: HTTP ${response.status}`,
        detail: body.slice(0, 300),
      });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Fetch gagal', detail: err.message });
  }
};
