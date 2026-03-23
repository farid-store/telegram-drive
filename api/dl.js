// api/dl.js — Stream proxy untuk YouTube (googlevideo.com)
// URL googlevideo terikat ke IP server Ryzumi (HK), bukan IP user
// Jadi kita bisa proxy dari Vercel dengan header yang benar

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: cors });
  }

  const { searchParams } = new URL(req.url);
  const fileUrl  = searchParams.get('url');
  const filename = searchParams.get('name') || 'video.mp4';

  if (!fileUrl) {
    return new Response(JSON.stringify({ error: 'url required' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Hanya izinkan domain YouTube CDN
  try {
    const u = new URL(fileUrl);
    if (!u.hostname.includes('googlevideo.com')) {
      return new Response(JSON.stringify({ error: 'Only googlevideo.com allowed' }), {
        status: 403,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  try {
    // Forward range header jika ada (untuk resume download)
    const rangeHeader = req.headers.get('range');

    const upstream = await fetch(fileUrl, {
      headers: {
        // Header yang YouTube CDN butuhkan
        'User-Agent': 'com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        ...(rangeHeader ? { 'Range': rangeHeader } : {}),
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      return new Response(JSON.stringify({ error: `YouTube CDN error: ${upstream.status}` }), {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Build response headers
    const respHeaders = new Headers({
      ...cors,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Type': upstream.headers.get('Content-Type') || 'video/mp4',
      'Accept-Ranges': 'bytes',
    });

    // Forward penting headers dari upstream
    const fwd = ['Content-Length', 'Content-Range', 'Last-Modified', 'ETag'];
    for (const h of fwd) {
      const v = upstream.headers.get(h);
      if (v) respHeaders.set(h, v);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
}
