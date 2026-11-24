// api/autoclip.mjs — Backend AI Auto-Clip VaultDL (Vercel Serverless, zero dependencies)
// Route otomatis: /api/autoclip
// Env Vercel yang didukung (isi salah satu atau keduanya):
//   - GROQ_API_KEY   (sangat disarankan untuk transkripsi 30–60 menit super cepat via whisper-large-v3-turbo)
//   - GEMINI_API_KEY (sangat disarankan untuk analisa inti sari viral full 60 menit via gemini-2.5-flash)

export const config = {
  maxDuration: 60,
  api: {
    bodyParser: false,
  },
};

const MAX_BODY_BYTES = 4.6 * 1024 * 1024; // Guard batas aman serverless Vercel

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Ukuran chunk terlalu besar (maks 4.5 MB)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function extractJson(raw) {
  const s = String(raw || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : s;
  try {
    return JSON.parse(candidate);
  } catch {
    const startObj = candidate.indexOf('{');
    const endObj = candidate.lastIndexOf('}');
    if (startObj >= 0 && endObj > startObj) {
      return JSON.parse(candidate.slice(startObj, endObj + 1));
    }
    const startArr = candidate.indexOf('[');
    const endArr = candidate.lastIndexOf(']');
    if (startArr >= 0 && endArr > startArr) {
      return JSON.parse(candidate.slice(startArr, endArr + 1));
    }
    throw new Error('Respons AI tidak berupa JSON valid');
  }
}

/* ==================== 1. TRANSKRIPSI AUDIO CHUNK ==================== */
async function transcribeWithGroq(buf, { apiKey, ext, mime, lang, offset }) {
  const fd = new FormData();
  const blob = new Blob([buf], { type: mime || 'audio/webm' });
  fd.append('file', blob, `chunk.${ext || 'webm'}`);
  fd.append('model', 'whisper-large-v3-turbo');
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'segment');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('temperature', '0');
  if (lang && lang !== 'auto') fd.append('language', lang);

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data?.error?.message || `Groq Whisper gagal (HTTP ${r.status})`);
  }

  const segments = (data.segments || [])
    .map((s) => ({
      start: +(offset + Number(s.start || 0)).toFixed(2),
      end: +(offset + Number(s.end || 0)).toFixed(2),
      text: String(s.text || '').trim(),
    }))
    .filter((s) => s.text && s.end > s.start);

  const words = (data.words || [])
    .map((w) => ({
      start: +(offset + Number(w.start || 0)).toFixed(2),
      end: +(offset + Number(w.end || 0)).toFixed(2),
      text: String(w.word || w.text || '').trim(),
    }))
    .filter((w) => w.text);

  return { provider: 'groq-whisper', segments, words };
}

async function transcribeWith(buf, { apiKey, mime, lang, offset, chunkDur }) {
  const langHint = lang && lang !== 'auto'
    ? `Bahasa utama audio: ${lang}.`
    : 'Deteksi bahasa secara otomatis (pertahankan bahasa asli ucapan, misal Indonesia/Inggris).';

  const prompt = [
    'Transkripsikan audio ini secara akurat dengan timestamp detik relatif dari awal audio (0.0).',
    langHint,
    'Kembalikan HANYA JSON valid dengan format:',
    '{"segments":[{"start":0.0,"end":4.2,"text":"kalimat utuh di rentang ini"}]}',
    'Aturan: pecah per kalimat singkat (3–8 detik), jangan mengarang teks di bagian senyap, pastikan start dan end berupa angka detik.',
  ].join('\n');

  const model = 'gemini-3.8-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mime || 'audio/webm', data: buf.toString('base64') } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data?.error?.message || `Gemini Transcribe gagal (HTTP ${r.status})`);
  }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const parsed = extractJson(rawText);
  const arr = Array.isArray(parsed) ? parsed : (parsed.segments || []);
  const maxD = chunkDur > 0 ? chunkDur + 2 : 600;

  const segments = arr
    .map((s) => {
      const a = Math.max(0, Math.min(maxD, Number(s.start || 0)));
      const b = Math.max(a + 0.2, Math.min(maxD, Number(s.end || a + 2)));
      return {
        start: +(offset + a).toFixed(2),
        end: +(offset + b).toFixed(2),
        text: String(s.text || '').trim(),
      };
    })
    .filter((s) => s.text);

  return { provider: 'gemini-flash', segments, words: [] };
}

/* ==================== 2. ANALISA MOMEN VIRAL (INTI SARI) ==================== */
function buildAnalysisPrompt(payload) {
  const {
    segments = [],
    topHypeTimes = [],
    duration = 0,
    contentType = 'podcast', // 'podcast' | 'stream'
    clipCount = 5,
    minDur = 40,
    maxDur = 65,
    customFocus = '',
  } = payload;

  // Format ringkas agar 60 menit penuh muat dalam 1 request: [detik_mulai-detik_selesai] teks
  const lines = segments.map((s) => `[${Number(s.start).toFixed(1)}-${Number(s.end).toFixed(1)}] ${String(s.text || '').trim()}`);
  const hypeSummary = topHypeTimes.length
    ? topHypeTimes.slice(0, 60).map((h) => `${h.t}s(skor:${h.score})`).join(', ')
    : 'tidak ada puncak ekstrem';

  const styleGuide = contentType === 'stream'
    ? 'Konten ini adalah LIVESTREAM / GAMING. Prioritaskan momen reaksi heboh, momen lucu/panik, clutch/epic moment, cerita spontan menarik, atau debat kocak. Perhatikan juga daftar timestamp puncak energi audio (hype) di bawah.'
    : 'Konten ini adalah PODCAST / OBROLAN. Prioritaskan inti sari paling bernilai: insight tajam, opini kontroversial, cerita emosional/plot twist, tips konkret, atau jawaban "daging" yang langsung mengait perhatian di 3 detik pertama.';

  return `Kamu adalah editor video short-form (Reels, TikTok, YouTube Shorts) kelas profesional.
Tugasmu: Pilih tepat ${clipCount} klip paling berpotensi VIRAL dari transkrip video berdurasi ${Math.round(duration)} detik di bawah ini.

KONTEKS KONTEN:
${styleGuide}
${customFocus ? `FOKUS TAMBAHAN USER: ${customFocus}` : ''}

ATURAN WAJIB PEMOTONGAN:
1. Setiap klip WAJIB berdurasi antara ${minDur} hingga ${maxDur} detik (ideal ~50–60 detik).
2. Titik "start" HARUS tepat di awal kalimat yang menjadi HOOK kuat (memancing rasa penasaran / emosi dalam 3 detik pertama). Jangan mulai di tengah kalimat atau obrolan basa-basi ("eh jadi gini...").
3. Titik "end" HARUS tepat di akhir kalimat penutup/punchline yang tuntas. Jangan terpotong menggantung.
4. Gunakan angka detik PERSIS yang merujuk pada timestamp di transkrip.
5. Klip-klip tidak boleh saling tumpang tindih waktunya.
6. Urutkan dari viral_score tertinggi ke terendah.

TIMESTAMP PUNCAK ENERGI SUARA (HYPE / TAWA / TERIAKAN):
${hypeSummary}

FORMAT OUTPUT (HANYA JSON VALID, BAHASA INDONESIA):
{
  "clips": [
    {
      "title": "Judul pendek punchy gaya Reels (maks 65 karakter)",
      "start": 124.5,
      "end": 182.0,
      "viral_score": 94,
      "category": "insight|lucu|kontroversial|emosional|hype",
      "hook": "Kutipan singkat 1 kalimat pembuka yang bikin penonton berhenti scroll",
      "reason": "Alasan singkat (1-2 kalimat) kenapa segmen ini berpotensi viral"
    }
  ]
}

TRANSKRIP BER-TIMESTAMP:
${lines.join('\n')}`;
}

async function analyzeWithGemini(prompt, apiKey) {
  const model = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.35,
        responseMimeType: 'application/json',
      },
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data?.error?.message || `Gemini Analyze gagal (HTTP ${r.status})`);
  }
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return { provider: 'gemini-2.5-flash', parsed: extractJson(raw) };
}

async function analyzeWithGroq(prompt, apiKey) {
  // Batasi karakter untuk model Llama 70B agar aman dari batas TPM gratis Groq (~38k char)
  const safePrompt = prompt.length > 38000 ? prompt.slice(0, 38000) + '\n[...transkrip dipangkas agar sesuai batas konteks Groq...]' : prompt;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.35,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Kamu hanya mengembalikan JSON valid tanpa teks tambahan di luar JSON.' },
        { role: 'user', content: safePrompt },
      ],
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data?.error?.message || `Groq Analyze gagal (HTTP ${r.status})`);
  }
  const raw = data?.choices?.[0]?.message?.content || '{}';
  return { provider: 'groq-llama-3.3-70b', parsed: extractJson(raw) };
}

function sanitizeClips(rawClips, duration, minDur, maxDur) {
  const maxT = duration > 0 ? duration : 86400;
  const out = [];
  for (let i = 0; i < (rawClips || []).length; i++) {
    const c = rawClips[i] || {};
    let start = Math.max(0, Math.min(maxT - 10, Number(c.start)));
    let end = Math.max(start + 12, Math.min(maxT, Number(c.end)));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    // Pastikan tidak melebihi maxDur + toleransi kecil 10 detik
    if (end - start > maxDur + 10) end = Math.min(maxT, start + maxDur);
    if (end - start < Math.min(15, minDur)) end = Math.min(maxT, start + minDur);

    out.push({
      id: `ai_${i}_${Math.round(start)}`,
      title: String(c.title || `Klip Viral #${i + 1}`).trim().slice(0, 80),
      start: +start.toFixed(2),
      end: +end.toFixed(2),
      duration: +(end - start).toFixed(1),
      viral_score: Math.max(1, Math.min(99, Math.round(Number(c.viral_score) || 80))),
      category: String(c.category || 'insight').trim(),
      hook: String(c.hook || '').trim().slice(0, 180),
      reason: String(c.reason || '').trim().slice(0, 260),
    });
  }
  return out.sort((a, b) => b.viral_score - a.viral_score);
}

/* ==================== HANDLER UTAMA ==================== */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Groq-Key, X-Gemini-Key');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('action') || '';
  const groqKey = String(req.headers['x-groq-key'] || process.env.GROQ_API_KEY || '').trim();
  const geminiKey = String(req.headers['x-gemini-key'] || process.env.GEMINI_API_KEY || '').trim();

  // Cek status konfigurasi API dari frontend
  if (req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      providers: {
        groq: !!process.env.GROQ_API_KEY,
        gemini: !!process.env.GEMINI_API_KEY,
      },
    });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Gunakan method POST atau GET' });
  }

  try {
    const buf = await readRawBody(req);

    if (action === 'transcribe') {
      if (!buf.length) return sendJson(res, 400, { error: 'Audio chunk kosong' });
      const offset = Number(url.searchParams.get('offset') || 0) || 0;
      const chunkDur = Number(url.searchParams.get('dur') || 0) || 0;
      const lang = url.searchParams.get('lang') || 'id';
      const ext = url.searchParams.get('ext') || 'webm';
      const mime = req.headers['content-type'] || (ext === 'wav' ? 'audio/wav' : 'audio/webm');

      if (groqKey) {
        const result = await transcribeWithGroq(buf, { apiKey: groqKey, ext, mime, lang, offset });
        return sendJson(res, 200, result);
      }
      if (geminiKey) {
        const result = await transcribeWithGemini(buf, { apiKey: geminiKey, mime, lang, offset, chunkDur });
        return sendJson(res, 200, result);
      }
      return sendJson(res, 400, {
        error: 'API Key belum diatur. Isi GROQ_API_KEY atau GEMINI_API_KEY di Vercel Environment Variables (atau masukkan di pengaturan AI Clip).',
      });
    }

    if (action === 'analyze') {
      const payload = JSON.parse(buf.toString('utf8') || '{}');
      if (!Array.isArray(payload.segments) || !payload.segments.length) {
        return sendJson(res, 400, { error: 'Transkrip kosong — tidak ada teks untuk dianalisa' });
      }
      const prompt = buildAnalysisPrompt(payload);
      let resAI;
      if (geminiKey) {
        resAI = await analyzeWithGemini(prompt, geminiKey);
      } else if (groqKey) {
        resAI = await analyzeWithGroq(prompt, groqKey);
      } else {
        return sendJson(res, 400, {
          error: 'API Key belum diatur. Isi GEMINI_API_KEY atau GROQ_API_KEY di Vercel atau di kolom pengaturan AI Clip.',
        });
      }

      const clips = sanitizeClips(
        resAI.parsed?.clips || [],
        Number(payload.duration || 0),
        Number(payload.minDur || 40),
        Number(payload.maxDur || 65),
      );
      return sendJson(res, 200, { provider: resAI.provider, clips });
    }

    return sendJson(res, 400, { error: 'Parameter action harus "transcribe" atau "analyze"' });
  } catch (err) {
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
}
