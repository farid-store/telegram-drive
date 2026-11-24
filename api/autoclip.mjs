// api/autoclip.mjs — Backend AI Auto-Clip VaultDL (Vercel Serverless, zero dependencies)
// Route otomatis: /api/autoclip
//
// Env Vercel (opsional — key juga bisa dikirim dari browser lewat header X-Groq-Key / X-Gemini-Key):
//   GROQ_API_KEY        transkripsi (Whisper) + pemilihan klip (LLM)
//   GEMINI_API_KEY      cadangan untuk pemilihan klip
//   GROQ_WHISPER_MODEL  default: whisper-large-v3        (alternatif: whisper-large-v3-turbo)
//   GROQ_LLM_MODELS     default: openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b  (dicoba berurutan)
//   GEMINI_MODEL        default: gemini-3.8-flash
//
// Dirancang mengikuti batas gratis Groq (cek console.groq.com/settings/limits — angka bisa berubah):
//   Whisper : 20 req/menit · 2.000 req/hari · 7.200 detik audio/jam · 28.800 detik audio/hari
//   LLM     : 30 req/menit · 1.000 req/hari · 8.000 token/menit · 200.000 token/hari
// Strategi:
//   • Transkripsi: chunk ≤ ~5 menit, retry otomatis saat 429 (membaca Retry-After), error terstruktur
//     agar browser bisa menunggu / melanjutkan, segmen halusinasi (senyap) dibuang.
//   • Analisis: TIDAK mengirim seluruh transkrip. Server memilih ±3× kandidat klip secara lokal
//     (tanpa token), LLM hanya menilai/memberi judul (≈2–4 rb token per analisis, jauh di bawah 8 rb TPM),
//     batas waktu klip tidak pernah diubah LLM (anti-ngaco), dan jatuh ke model berikutnya / ranking lokal
//     bila kena limit.

export const config = {
  maxDuration: 60,
  api: { bodyParser: false },
};

const MAX_BODY_BYTES = 4.6 * 1024 * 1024;
const LIMITS = {
  whisper: { rpm: 20, rpd: 2000, secPerHour: 7200, secPerDay: 28800 },
  llm: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
};
const WHISPER_MODELS = ['whisper-large-v3', 'whisper-large-v3-turbo'];
const DEFAULT_LLMS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
const PROMPT_TOKEN_BUDGET = 4600; // input; + max_completion_tokens tetap < 8.000 TPM

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Ukuran request terlalu besar (maks 4.5 MB)'), { status: 413 }));
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
    const a = candidate.indexOf('{'), b = candidate.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(candidate.slice(a, b + 1));
    const c = candidate.indexOf('['), d = candidate.lastIndexOf(']');
    if (c >= 0 && d > c) return JSON.parse(candidate.slice(c, d + 1));
    throw new Error('Respons AI tidak berupa JSON valid');
  }
}

/* ==================== util rate-limit Groq ==================== */
function parseRetryAfter(headers, data) {
  const h = headers && headers.get ? headers.get('retry-after') : null;
  if (h && !isNaN(+h)) return Math.ceil(+h);
  const msg = String(data?.error?.message || '');
  const m = msg.match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i);
  if (m && (m[1] || m[2] || m[3])) return Math.ceil((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0));
  return 30;
}
function limitScope(msg) {
  const s = String(msg || '');
  if (/seconds of audio per hour|\bASH\b/i.test(s)) return 'audio-jam';
  if (/seconds of audio per day|\bASD\b/i.test(s)) return 'audio-hari';
  if (/per day|\bRPD\b|\bTPD\b/i.test(s)) return 'hari';
  if (/tokens per minute|\bTPM\b/i.test(s)) return 'token-menit';
  if (/per minute|\bRPM\b/i.test(s)) return 'menit';
  return 'tidak-diketahui';
}
function rateHeaders(h) {
  const g = (k) => (h && h.get ? h.get(k) : null);
  const out = {};
  for (const k of ['x-ratelimit-remaining-requests', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-tokens', 'x-ratelimit-limit-tokens', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const v = g(k);
    if (v != null) out[k.replace('x-ratelimit-', '')] = v;
  }
  return out;
}
function groqError(status, data, headers) {
  const msg = data?.error?.message || `Groq gagal (HTTP ${status})`;
  const e = new Error(msg);
  e.status = status;
  if (status === 429) {
    e.retryAfter = parseRetryAfter(headers, data);
    e.scope = limitScope(msg);
  }
  if (status === 401) e.message = 'Groq API Key tidak valid / belum diaktifkan. Periksa key di pengaturan AI.';
  return e;
}

/* ==================== 1. TRANSKRIPSI (Groq Whisper) ==================== */
const HALLU = [
  /terima kasih (telah|sudah|atas) (menonton|menyaksikan)/i,
  /thanks? (you )?for (watching|listening)/i,
  /please subscribe|subscribe (to|ke) (my|our|channel)/i,
  /subtitles? (by|oleh)|amara\.org/i,
];

async function transcribeWithGroq(buf, { apiKey, ext, mime, lang, offset, model, prompt }) {
  const doOnce = async () => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), `chunk.${ext || 'webm'}`);
    fd.append('model', model);
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'word');
    fd.append('timestamp_granularities[]', 'segment');
    fd.append('temperature', '0');
    if (lang && lang !== 'auto') fd.append('language', lang);
    if (prompt) fd.append('prompt', String(prompt).slice(0, 600));
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    const data = await r.json().catch(() => ({}));
    return { r, data };
  };

  let { r, data } = await doOnce();
  // 429 singkat (limit per menit) → tunggu & coba sekali lagi di server; yang lama → serahkan ke browser
  if (r.status === 429) {
    const wait = parseRetryAfter(r.headers, data);
    if (wait <= 12) {
      await sleep((wait + 0.5) * 1000);
      ({ r, data } = await doOnce());
    }
  }
  if (!r.ok) throw groqError(r.status, data, r.headers);

  // buang segmen halusinasi (umumnya di bagian senyap / musik)
  const rawSegs = Array.isArray(data.segments) ? data.segments : [];
  const dropped = [];
  const segments = [];
  for (const s of rawSegs) {
    const text = String(s.text || '').trim();
    const st = Number(s.start || 0), en = Number(s.end || 0);
    const bad =
      !text ||
      en <= st ||
      (Number(s.no_speech_prob) > 0.85 && Number(s.avg_logprob) < -0.7) ||
      Number(s.compression_ratio) > 2.6 ||
      Number(s.avg_logprob) < -1.6 ||
      (text.length < 70 && HALLU.some((rx) => rx.test(text)));
    if (bad) { dropped.push([st, en]); continue; }
    segments.push({ start: +(offset + st).toFixed(3), end: +(offset + en).toFixed(3), text });
  }
  const inDropped = (t) => dropped.some(([a, b]) => t >= a && t <= b);
  const words = (Array.isArray(data.words) ? data.words : [])
    .map((w) => ({
      start: Number(w.start || 0),
      end: Number(w.end || 0),
      text: String(w.word || w.text || '').trim(),
    }))
    .filter((w) => w.text && w.end >= w.start && !inDropped((w.start + w.end) / 2))
    .map((w) => ({ start: +(offset + w.start).toFixed(3), end: +(offset + Math.max(w.end, w.start + 0.04)).toFixed(3), text: w.text }));

  return { provider: 'groq-whisper', model, segments, words, dropped: dropped.length, limits: rateHeaders(r.headers) };
}

/* ==================== 2. KANDIDAT KLIP (lokal, 0 token) ==================== */
const RX = {
  hook: /\b(rahasia(nya)?|ternyata|faktanya|fakta|sebenarnya|kesalahan|bahaya|hati-hati|jangan (pernah|sampai)|stop|wajib|kuncinya|mitos|bohong|tertipu|penipuan|scam|bangkrut|rugi|gagal|sukses|gratis|terbukti|nggak ada yang|gak ada yang|tidak ada yang|semua orang|kebanyakan orang|pernah nggak|pernah gak|bayangin|bayangkan|jujur|gila|parah|mengejutkan|viral|secret|truth|mistake|never|nobody|everyone|crazy|insane|unbelievable|shocking|actually|turns out|the problem|dangerous|wrong|myth|imagine|you won't believe|no way|oh my god|here's the thing|the biggest|the worst|the best)\b/gi,
  insight: /\b(intinya|kuncinya|caranya|tips|trik|pelajaran|rumusnya|alasannya|penyebabnya|solusinya|yang paling penting|pertama|kedua|ketiga|langkah|strateginya|prinsip|the key|the secret|the reason|lesson|rule|step|framework|principle|the point is)\b/gi,
  contrast: /\b(tapi|namun|padahal|justru|malah|sebaliknya|but actually|however|instead|in fact)\b/gi,
  emo: /\b(gila|anjir|anjay|astaga|ya ampun|wah|wow|demi apa|sumpah|serius|hah|busyet|mantap|keren|lucu|ngakak|kocak|seru|kesel|marah|sedih|nangis|takut|bangga|omg|no way|holy|damn|insane|crazy|love|hate|amazing|terrible|awesome|let's go|clutch|ace|haha+|wkwk+)\b/gi,
  num: /(\d+([.,]\d+)?\s?(%|persen|juta|miliar|milyar|triliun|ribu|rb|jt|kali|tahun|bulan|hari|jam|menit|dollar)|\$\s?\d|\brp\.?\s?\d|\b\d{3,}\b)/gi,
  fill: /\b(eh|em+|hmm+|anu|apa ya|you know|i mean|uh+|um+|ya kan)\b/gi,
  edge: /(subscribe|berlangganan|langganan|like (dan|and)|sponsor|endorse|kode promo|promo code|link di (deskripsi|bio)|link in (the )?(bio|description)|terima kasih (sudah|telah|udah)|halo guys|hai guys|selamat (datang|pagi|siang|sore|malam)|welcome (back|to)|don't forget|smash|thanks for watching|see you (next|in)|sampai jumpa)/i,
  cont: /^\W*(dan|terus|lalu|jadi|makanya|karena|soalnya|tapi|and|but|so|because|then|which)\b/i,
};
const cnt = (re, s) => (s.match(re) || []).length;
const bell = (x, c, w) => Math.exp(-Math.pow((x - c) / w, 2));
const words = (s) => String(s || '').split(/\s+/).filter(Boolean);

function buildCandidates(segsIn, topHype, { minDur, maxDur, contentType, max }) {
  const segs = (segsIn || [])
    .map((s) => ({ start: +s.start, end: +s.end, text: String(s.text || '').trim() }))
    .filter((s) => s.text && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const n = segs.length;
  if (!n) return [];
  const T = (minDur + maxDur) / 2;
  const hits = new Set((topHype || []).map((h) => Math.floor(h.t)));
  const horizon = Math.ceil(segs[n - 1].end) + 2;
  const PH = new Float64Array(horizon + 1);
  for (let s = 0; s < horizon; s++) PH[s + 1] = PH[s] + (hits.has(s) ? 1 : 0);

  const sf = segs.map((s) => {
    const t = s.text.toLowerCase();
    return {
      hook: cnt(RX.hook, t), insight: cnt(RX.insight, t), contrast: cnt(RX.contrast, t), emo: cnt(RX.emo, t),
      num: cnt(RX.num, t), fill: cnt(RX.fill, t), ex: cnt(/!/g, s.text), q: cnt(/\?/g, s.text),
      edge: RX.edge.test(t) ? 1 : 0, cont: RX.cont.test(t) ? 1 : 0, wc: words(s.text).length,
      end: /[.!?…]["')\]]*$/.test(s.text) ? 1 : 0,
    };
  });
  const keys = ['hook', 'insight', 'contrast', 'emo', 'num', 'fill', 'ex', 'wc'];
  const P = {};
  for (const k of keys) { const a = new Float64Array(n + 1); for (let i = 0; i < n; i++) a[i + 1] = a[i] + sf[i][k]; P[k] = a; }

  const W = contentType === 'stream'
    ? { hook: 0.12, content: 0.06, emo: 0.16, hype: 0.34, dens: 0.06, comp: 0.14, len: 0.12 }
    : { hook: 0.28, content: 0.2, emo: 0.1, hype: 0.12, dens: 0.08, comp: 0.12, len: 0.1 };

  const out = [];
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const t0 = segs[i].start, t1 = segs[j].end, d = t1 - t0;
      if (d > maxDur) break;
      if (d < minDur) continue;
      const rg = (k) => P[k][j + 1] - P[k][i], wc = Math.max(1, rg('wc'));
      const f0 = sf[i], f1 = i + 1 < n && segs[i + 1].start - segs[i].end < 1.2 ? sf[i + 1] : null;
      let hook = (f0.q ? 0.35 : 0) + Math.min(0.6, f0.hook * 0.3) + (f0.num ? 0.15 : 0) + (f0.ex ? 0.1 : 0) + (f0.emo ? 0.1 : 0);
      if (f1) hook += 0.4 * ((f1.q ? 0.3 : 0) + Math.min(0.5, f1.hook * 0.25) + (f1.num ? 0.1 : 0));
      if (f0.wc >= 3 && f0.wc <= 18) hook += 0.12;
      if (f0.cont) hook -= 0.25;
      hook = clamp(hook, 0, 1);
      const content = clamp((rg('insight') + rg('num') * 0.8 + rg('contrast') * 0.25 + rg('hook') * 0.35) / (d / 15) / 1.5, 0, 1);
      const emo = clamp((rg('emo') + rg('ex') * 0.6) / (d / 15) / 1.5, 0, 1);
      const a = Math.max(0, Math.floor(t0)), b = Math.min(horizon, Math.ceil(t1));
      const peaks = PH[b] - PH[a];
      const hype = clamp(peaks / (d / 12), 0, 1);
      const dens = bell(wc / d, 2.8, 1.5);
      const gapB = j + 1 < n ? segs[j + 1].start - segs[j].end : 1;
      const gapA = i > 0 ? segs[i].start - segs[i - 1].end : 1;
      const comp = clamp((sf[j].end ? 0.35 : 0) + (gapB >= 0.4 ? 0.25 : 0) + (f0.cont ? 0 : 0.25) + (gapA >= 0.4 ? 0.15 : 0), 0, 1);
      const len = bell(d, T, 0.4 * T);
      let pen = clamp((rg('fill') / wc - 0.06) * 2, 0, 0.15);
      if (sf[i].edge || sf[j].edge) pen += 0.3;
      const parts = { hook, content, emo, hype, dens, comp, len };
      let raw = -pen;
      for (const k in W) raw += W[k] * parts[k];
      const reasons = [];
      if (f0.q) reasons.push('dibuka pertanyaan');
      if (hook >= 0.5) reasons.push('hook kuat');
      if (content >= 0.45) reasons.push('insight/angka');
      if (emo >= 0.4) reasons.push('emosional');
      if (peaks >= 2) reasons.push('puncak suara');
      out.push({ i, j, start: t0, end: t1, raw, peaks, reasons });
    }
  }
  out.sort((a, b) => b.raw - a.raw);
  const picked = [];
  for (const c of out) {
    if (picked.length >= max) break;
    if (picked.every((p) => c.end <= p.start - 2 || c.start >= p.end + 2)) picked.push(c);
  }
  return picked.map((c, k) => {
    const ws = words(segs.slice(c.i, c.j + 1).map((s) => s.text).join(' '));
    return {
      id: 'c' + (k + 1),
      start: +c.start.toFixed(2),
      end: +c.end.toFixed(2),
      score: Math.round(clamp((c.raw + 0.05) / 0.65, 0, 1) * 100),
      peaks: c.peaks,
      reasons: c.reasons,
      wc: ws.length,
      head: ws.slice(0, 30).join(' '),
      tail: ws.slice(-18).join(' '),
    };
  });
}

/* ==================== 3. PROMPT KOMPAK ==================== */
function buildCompactPrompt(cands, o, excerpt) {
  const [hw, tw] = excerpt;
  const styleGuide = o.contentType === 'stream'
    ? 'LIVESTREAM / GAMING: prioritaskan reaksi heboh, momen lucu/panik, clutch/epic, cerita spontan, debat kocak.'
    : 'PODCAST / OBROLAN: prioritaskan insight tajam, opini kontroversial, cerita emosional/plot twist, tips konkret, jawaban "daging".';
  const lines = cands.map((c) => {
    const head = words(c.head).slice(0, hw).join(' ');
    const tail = words(c.tail).slice(-tw).join(' ');
    return `${c.id} | ${Math.round(c.start)}-${Math.round(c.end)}s (${Math.round(c.end - c.start)}s) | puncak-suara:${c.peaks} | "${head} … ${tail}"`;
  });
  return `Kamu editor video short-form (Reels/TikTok/Shorts) profesional.
Dari ${cands.length} kandidat klip di bawah (batas waktu sudah rapi di awal/akhir kalimat), pilih ${o.clipCount} yang paling berpotensi VIRAL.
${styleGuide}
${o.customFocus ? 'Fokus tambahan: ' + String(o.customFocus).slice(0, 160) + '\n' : ''}Kriteria: hook kuat di 3 detik pertama, klip bisa dipahami tanpa konteks, ada payoff/punchline di akhir, hindari basa-basi/iklan/intro-outro.
Gunakan id PERSIS seperti di daftar (jangan mengubah waktu). Urutkan dari viral_score tertinggi (1-99).
Balas HANYA JSON: {"clips":[{"id":"c3","viral_score":92,"title":"judul punchy maks 60 karakter","category":"insight|lucu|kontroversial|emosional|hype","hook":"kutipan pembuka maks 120 karakter","reason":"alasan 1 kalimat"}]}

KANDIDAT (id | waktu | info | cuplikan awal … akhir):
${lines.join('\n')}`;
}
const estTokens = (s) => Math.ceil(String(s).length / 2.8);

function fitPrompt(cands, o) {
  const plans = [[30, 18], [22, 12], [16, 8], [10, 6]];
  let list = cands.slice();
  for (const ex of plans) {
    const p = buildCompactPrompt(list, o, ex);
    if (estTokens(p) <= PROMPT_TOKEN_BUDGET) return { prompt: p, list };
  }
  while (list.length > Math.max(o.clipCount + 1, 4)) {
    list = list.slice(0, list.length - 1);
    const p = buildCompactPrompt(list, o, plans[plans.length - 1]);
    if (estTokens(p) <= PROMPT_TOKEN_BUDGET) return { prompt: p, list };
  }
  return { prompt: buildCompactPrompt(list, o, plans[plans.length - 1]), list };
}

/* ==================== 4. LLM (Groq berurutan → Gemini) ==================== */
async function callGroqChat(model, prompt, apiKey, maxTokens) {
  const make = (extra) => ({
    model,
    temperature: 0.3,
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'system', content: 'Kamu hanya mengembalikan JSON valid tanpa teks lain.' },
      { role: 'user', content: prompt },
    ],
    ...extra,
  });
  const send = async (body) => {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { r, data };
  };
  const extras = { response_format: { type: 'json_object' } };
  if (/^openai\/gpt-oss/.test(model)) extras.reasoning_effort = 'low';
  let { r, data } = await send(make(extras));
  if (r.status === 400 && /response_format|reasoning|json/i.test(data?.error?.message || '')) {
    ({ r, data } = await send(make({})));
  }
  if (r.status === 429) {
    const wait = parseRetryAfter(r.headers, data);
    if (wait <= 10) { await sleep((wait + 0.5) * 1000); ({ r, data } = await send(make(extras))); }
  }
  if (!r.ok) throw groqError(r.status, data, r.headers);
  const raw = data?.choices?.[0]?.message?.content || '';
  return { parsed: extractJson(raw), usage: data?.usage || null };
}

async function callGemini(prompt, apiKey) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || `Gemini gagal (HTTP ${r.status})`), { status: r.status });
  return { parsed: extractJson(data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'), model };
}

function mergeClips(parsed, cands, o) {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const used = new Set();
  const out = [];
  for (const x of parsed?.clips || []) {
    const c = byId.get(String(x.id || '').trim());
    if (!c || used.has(c.id)) continue;
    used.add(c.id);
    out.push({
      id: `ai_${out.length}_${Math.round(c.start)}`,
      title: String(x.title || c.head.slice(0, 60) || `Klip Viral #${out.length + 1}`).trim().slice(0, 80),
      start: c.start,
      end: c.end,
      duration: +(c.end - c.start).toFixed(1),
      viral_score: clamp(Math.round(Number(x.viral_score) || c.score), 1, 99),
      category: String(x.category || 'insight').trim().slice(0, 24),
      hook: String(x.hook || c.head).trim().slice(0, 180),
      reason: String(x.reason || '').trim().slice(0, 260),
    });
  }
  return out.sort((a, b) => b.viral_score - a.viral_score).slice(0, o.clipCount);
}
function localClips(cands, o, why) {
  return cands.slice(0, o.clipCount).map((c, k) => ({
    id: `loc_${k}_${Math.round(c.start)}`,
    title: c.head.slice(0, 60),
    start: c.start,
    end: c.end,
    duration: +(c.end - c.start).toFixed(1),
    viral_score: clamp(c.score, 40, 95),
    category: 'insight',
    hook: c.head.slice(0, 160),
    reason: (c.reasons.length ? c.reasons.join(' · ') : 'Segmen padat dengan alur kalimat utuh') + (why ? ` (ranking lokal: ${why})` : ''),
  }));
}

async function analyze(payload, { groqKey, geminiKey }) {
  const o = {
    contentType: payload.contentType === 'stream' ? 'stream' : 'podcast',
    clipCount: clamp(Math.round(Number(payload.clipCount) || 5), 1, 10),
    minDur: clamp(Number(payload.minDur) || 40, 15, 150),
    maxDur: clamp(Number(payload.maxDur) || 65, 20, 180),
    customFocus: payload.customFocus || '',
  };
  if (o.maxDur < o.minDur + 5) o.maxDur = o.minDur + 5;
  const cands = buildCandidates(payload.segments, payload.topHypeTimes, { ...o, max: clamp(o.clipCount * 3, 8, 18) });
  if (!cands.length) {
    throw Object.assign(new Error('Tidak ada kandidat klip pada rentang durasi ini — coba perlebar durasi minimal/maksimal.'), { status: 422 });
  }
  const { prompt, list } = fitPrompt(cands, o);
  const maxTokens = clamp(220 * o.clipCount + 800, 1200, 3200);
  const pref = String(payload.provider || 'auto');
  const notes = [];

  if (groqKey && pref !== 'gemini') {
    const models = String(process.env.GROQ_LLM_MODELS || DEFAULT_LLMS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
    for (const m of models) {
      try {
        const { parsed, usage } = await callGroqChat(m, prompt, groqKey, maxTokens);
        const clips = mergeClips(parsed, list, o);
        if (clips.length) {
          // lengkapi bila LLM memilih lebih sedikit dari yang diminta
          if (clips.length < o.clipCount) {
            const have = new Set(clips.map((c) => c.start));
            for (const l of localClips(list, { ...o, clipCount: 99 }, '')) {
              if (clips.length >= o.clipCount) break;
              if (!have.has(l.start) && clips.every((c) => l.end <= c.start || l.start >= c.end)) clips.push(l);
            }
          }
          return { provider: 'groq:' + m, clips, usage, candidates: list.length, notes };
        }
        notes.push(`${m}: jawaban kosong`);
      } catch (e) {
        if (e.status === 401) throw e;
        notes.push(`${m}: ${e.status === 429 ? `kena limit ${e.scope || ''} (coba lagi ±${e.retryAfter || '?'} dtk)` : (e.message || e).toString().slice(0, 120)}`);
      }
    }
  }
  if (geminiKey && pref !== 'groq') {
    try {
      const { parsed, model } = await callGemini(prompt, geminiKey);
      const clips = mergeClips(parsed, list, o);
      if (clips.length) return { provider: 'gemini:' + model, clips, candidates: list.length, notes };
      notes.push('Gemini: jawaban kosong');
    } catch (e) {
      notes.push('Gemini: ' + String(e.message || e).slice(0, 120));
    }
  }
  if (!groqKey && !geminiKey) {
    throw Object.assign(new Error('API Key belum diatur. Isi GROQ_API_KEY atau GEMINI_API_KEY di Vercel atau di pengaturan AI Clip.'), { status: 400 });
  }
  return {
    provider: 'ranking-lokal',
    clips: localClips(list, o, notes[0] || ''),
    candidates: list.length,
    warning: 'AI tidak tersedia/terkena limit — memakai ranking lokal (tanpa judul AI). ' + notes.join(' | '),
    notes,
  };
}

/* ==================== HANDLER ==================== */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Groq-Key, X-Gemini-Key');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('action') || '';
  const groqKey = String(req.headers['x-groq-key'] || process.env.GROQ_API_KEY || '').trim();
  const geminiKey = String(req.headers['x-gemini-key'] || process.env.GEMINI_API_KEY || '').trim();

  if (req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      providers: { groq: !!process.env.GROQ_API_KEY, gemini: !!process.env.GEMINI_API_KEY },
      whisperModel: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3',
      whisperModels: WHISPER_MODELS,
      llmModels: String(process.env.GROQ_LLM_MODELS || DEFAULT_LLMS.join(',')).split(',').map((s) => s.trim()),
      limits: LIMITS,
    });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Gunakan method POST atau GET' });

  try {
    const buf = await readRawBody(req);

    if (action === 'transcribe') {
      if (!buf.length) return sendJson(res, 400, { error: 'Audio chunk kosong' });
      if (!groqKey) {
        return sendJson(res, 400, { error: 'Groq API Key belum diatur. Isi GROQ_API_KEY di Vercel atau masukkan key di pengaturan AI Clip.' });
      }
      const offset = Number(url.searchParams.get('offset') || 0) || 0;
      const lang = url.searchParams.get('lang') || 'id';
      const ext = url.searchParams.get('ext') || 'webm';
      const mime = req.headers['content-type'] || (ext === 'wav' ? 'audio/wav' : 'audio/webm');
      const reqModel = url.searchParams.get('model') || process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3';
      const model = WHISPER_MODELS.includes(reqModel) ? reqModel : 'whisper-large-v3';
      const prompt = url.searchParams.get('prompt') || '';
      const result = await transcribeWithGroq(buf, { apiKey: groqKey, ext, mime, lang, offset, model, prompt });
      return sendJson(res, 200, result);
    }

    if (action === 'analyze') {
      let payload;
      try { payload = JSON.parse(buf.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'Body JSON tidak valid' }); }
      if (!Array.isArray(payload.segments) || !payload.segments.length) {
        return sendJson(res, 400, { error: 'Transkrip kosong — tidak ada teks untuk dianalisa' });
      }
      const result = await analyze(payload, { groqKey, geminiKey });
      return sendJson(res, 200, result);
    }

    return sendJson(res, 400, { error: 'Parameter action harus "transcribe" atau "analyze"' });
  } catch (err) {
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    const body = { error: err?.message || String(err) };
    if (err?.retryAfter) { body.retryAfter = err.retryAfter; body.scope = err.scope; body.rateLimited = true; }
    if (status === 429) res.setHeader('Retry-After', String(err.retryAfter || 30));
    return sendJson(res, status, body);
  }
}
