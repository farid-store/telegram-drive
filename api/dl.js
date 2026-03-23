// api/dl.js — Stream proxy untuk YouTube & platform yang blokir direct download
// Dipanggil hanya untuk platform yang butuh proxy (YouTube, dll)
// Platform lain (TikTok, Instagram) langsung download tanpa lewat sini

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: cors });
  }

  const { searchParams } = new URL(req.url);
  const fileUrl  = searchParams.get('url');
  const filename = searchParams.get('name') || 'video.mp4';

  if (!fileUrl) {
    return new Response(JSON.stringify({ error: 'url param required' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  try {
    // Fetch file dari sumber (YouTube CDN, dll)
    const upstream = await fetch(fileUrl, {
      headers: {
        // Headers yang YouTube butuhkan
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.youtube.com/',
        'Origin': 'https://www.youtube.com',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Range': req.headers.get('range') || 'bytes=0-',
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      return new Response(JSON.stringify({ error: `Upstream error: ${upstream.status}` }), {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Forward response dengan header download
    const headers = new Headers({
      ...cors,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Type': upstream.headers.get('Content-Type') || 'video/mp4',
      'Accept-Ranges': 'bytes',
    });

    // Forward content-length dan content-range jika ada
    const cl = upstream.headers.get('Content-Length');
    const cr = upstream.headers.get('Content-Range');
    if (cl) headers.set('Content-Length', cl);
    if (cr) headers.set('Content-Range', cr);

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
}
