// api/get.js — Vercel Edge Function
// Edge runtime jalan di lokasi user (bukan datacenter Washington DC)
// sehingga tidak diblokir Ryzumi

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const { searchParams } = new URL(req.url);
  const videoUrl = searchParams.get('url');

  if (!videoUrl) {
    return new Response(JSON.stringify({ error: 'Parameter url diperlukan' }), {
      status: 400, headers: corsHeaders,
    });
  }

  try { new URL(videoUrl); } catch {
    return new Response(JSON.stringify({ error: 'URL tidak valid' }), {
      status: 400, headers: corsHeaders,
    });
  }

  const apiUrl = `https://api.ryzumi.net/api/downloader/all-in-one?url=${encodeURIComponent(videoUrl)}`;

  try {
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, */*',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
        'Referer': 'https://api.ryzumi.net/downloader',
        'Origin': 'https://api.ryzumi.net',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return new Response(JSON.stringify({
        error: `API error: HTTP ${res.status}`,
        detail: text.slice(0, 200),
      }), { status: res.status, headers: corsHeaders });
    }

    const data = await res.json();
    return new Response(JSON.stringify(data), { status: 200, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Fetch gagal',
      detail: err.message,
    }), { status: 500, headers: corsHeaders });
  }
}
