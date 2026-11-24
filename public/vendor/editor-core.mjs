// editor-core.mjs — inti editor video VaultDL: model timeline, gambar teks/overlay, render/ekspor offline,
// auto-reframe (Split-Screen Livestream & Podcast Tracking), ekstraksi audio streaming 30–60 menit untuk AI Auto-Clip,
// gelombang suara, dan penyiapan audio transkripsi. Berjalan di browser (WebCodecs via Mediabunny, MPL-2.0).
import {
  Input, Output, BlobSource, ALL_FORMATS, Mp4OutputFormat, WebMOutputFormat, BufferTarget,
  CanvasSink, AudioBufferSink, CanvasSource, AudioBufferSource,
  getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
  QUALITY_LOW, QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH,
} from './mediabunny.min.mjs';

export const FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, Menlo, Consolas, monospace',
  impact: 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif',
};
export const QUALITY = { low: QUALITY_LOW, medium: QUALITY_MEDIUM, high: QUALITY_HIGH, veryhigh: QUALITY_VERY_HIGH };
const SR = 48000;
const makeCanvas = (w, h) => typeof OffscreenCanvas !== 'undefined'
  ? new OffscreenCanvas(w, h)
  : Object.assign(document.createElement('canvas'), { width: w, height: h });

/* ---------------- preset layout split-screen livestream ---------------- */
// Semua koordinat crop menggunakan rasio normalisasi 0..1 terhadap bingkai video asli (16:9).
export const SPLIT_PRESETS = {
  'bottom-right': {
    label: 'Kamera Kanan Bawah',
    topRatio: 0.38,
    swap: false,
    cam: { x: 0.72, y: 0.62, w: 0.27, h: 0.35 },
    game: { x: 0.14, y: 0.0, w: 0.72, h: 1.0 },
  },
  'bottom-left': {
    label: 'Kamera Kiri Bawah',
    topRatio: 0.38,
    swap: false,
    cam: { x: 0.01, y: 0.62, w: 0.27, h: 0.35 },
    game: { x: 0.14, y: 0.0, w: 0.72, h: 1.0 },
  },
  'top-right': {
    label: 'Kamera Kanan Atas',
    topRatio: 0.38,
    swap: false,
    cam: { x: 0.72, y: 0.03, w: 0.27, h: 0.35 },
    game: { x: 0.14, y: 0.0, w: 0.72, h: 1.0 },
  },
  'top-left': {
    label: 'Kamera Kiri Atas',
    topRatio: 0.38,
    swap: false,
    cam: { x: 0.01, y: 0.03, w: 0.27, h: 0.35 },
    game: { x: 0.14, y: 0.0, w: 0.72, h: 1.0 },
  },
  'left-mid': {
    label: 'Kamera Kiri Tengah',
    topRatio: 0.38,
    swap: false,
    cam: { x: 0.01, y: 0.30, w: 0.27, h: 0.38 },
    game: { x: 0.20, y: 0.0, w: 0.74, h: 1.0 },
  },
  'right-mid': {
    label: 'Kamera Kanan Tengah',
    topRatio: 0.38,
    swap: false,
    cam: { x: 0.72, y: 0.30, w: 0.27, h: 0.38 },
    game: { x: 0.06, y: 0.0, w: 0.74, h: 1.0 },
  },
};

/* ---------------- model ---------------- */
// project = { w,h,fps,aspect,res,fit,
//   v:[{id,mid,in,out,vol,mute,speed,zoom,ox,oy,
//       layout:'normal'|'podcast'|'split',
//       split:{topRatio,swap,divider,cam:{x,y,w,h},game:{x,y,w,h}},
//       track:[{t,ox,oy,zoom}], trackSmooth:false}],
//   a:[{id,mid,start,in,out,vol,speed}],
//   t:[{id,text,start,end,x,y,size,color,bg,bgColor,bold,font,sub}],
//   o:[{id,mid,start,end,x,y,w,op}] }
export const srcLen = c => Math.max(0, c.out - c.in);
export const clipLen = c => srcLen(c) / (c.speed || 1);
export function videoLayout(p) {
  let t = 0;
  return p.v.map(clip => { const s = t; t += clipLen(clip); return { clip, start: s, end: t }; });
}
export function audioEnd(p) { return p.a.reduce((m, c) => Math.max(m, c.start + clipLen(c)), 0); }
export function projectDuration(p) {
  const v = p.v.reduce((s, c) => s + clipLen(c), 0);
  return v > 0 ? v : audioEnd(p);
}

/* ---------------- bingkai video: normal / split-screen / podcast tracking ---------------- */
const clampVal = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function placeFrame(sw, sh, W, H, fit, zoom = 1, ox = 0, oy = 0) {
  let k = fit === 'fill' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  k *= zoom || 1;
  const w = sw * k, h = sh * k;
  return { x: (W - w) / 2 + (ox || 0) * W, y: (H - h) / 2 + (oy || 0) * H, w, h };
}

// Crop area sumber (crop: {x,y,w,h} rasio 0..1) dan isi penuh kotak tujuan tanpa distorsi (anti-gepeng)
export function drawCropCover(ctx, src, imgW, imgH, crop, dx, dy, dw, dh) {
  if (!crop || dw <= 0 || dh <= 0) return;
  const cx = clampVal(crop.x ?? 0, 0, 0.98);
  const cy = clampVal(crop.y ?? 0, 0, 0.98);
  const cw = clampVal(crop.w ?? 1, 0.02, 1 - cx);
  const ch = clampVal(crop.h ?? 1, 0.02, 1 - cy);

  const sx = cx * imgW, sy = cy * imgH;
  const sw = Math.max(2, cw * imgW), sh = Math.max(2, ch * imgH);

  const srcAsp = sw / sh, dstAsp = dw / dh;
  let csx = sx, csy = sy, csw = sw, csh = sh;
  if (srcAsp > dstAsp) {
    csw = sh * dstAsp;
    csx = sx + (sw - csw) / 2;
  } else {
    csh = sw / dstAsp;
    csy = sy + (sh - csh) / 2;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, csx, csy, csw, csh, dx, dy, dw, dh);
  ctx.restore();
}

export function samplePodcastTrack(track, srcTime, smooth = false) {
  if (!Array.isArray(track) || !track.length) return { ox: 0, oy: 0, zoom: 1 };
  if (track.length === 1 || srcTime <= track[0].t) return track[0];
  const last = track[track.length - 1];
  if (srcTime >= last.t) return last;

  let idx = 0;
  for (let i = 0; i < track.length - 1; i++) {
    if (srcTime >= track[i].t && srcTime < track[i + 1].t) { idx = i; break; }
  }
  const a = track[idx], b = track[idx + 1];
  if (!smooth) return a; // Hard-cut antar pembicara agar tidak pusing
  const dt = Math.max(1e-4, b.t - a.t);
  // Transisi hanya dalam 0.35 detik terakhir menjelang keyframe berikutnya
  const win = Math.min(0.35, dt);
  const rem = b.t - srcTime;
  if (rem > win) return a;
  const u = clampVal(1 - rem / win, 0, 1);
  const e = u * u * (3 - 2 * u); // smoothstep
  return {
    ox: (a.ox || 0) + ((b.ox || 0) - (a.ox || 0)) * e,
    oy: (a.oy || 0) + ((b.oy || 0) - (a.oy || 0)) * e,
    zoom: (a.zoom || 1) + ((b.zoom || 1) - (a.zoom || 1)) * e,
  };
}

let _bg = null;
function blurBackdrop(ctx, src, sw, sh, W, H) {
  const bw = Math.max(8, Math.round(W / 14)), bh = Math.max(8, Math.round(H / 14));
  if (!_bg || _bg.width !== bw || _bg.height !== bh) _bg = makeCanvas(bw, bh);
  const b = _bg.getContext('2d'), p = placeFrame(sw, sh, bw, bh, 'fill', 1.1);
  b.drawImage(src, p.x, p.y, p.w, p.h);
  ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(_bg, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(0, 0, W, H); ctx.restore();
}

export function drawVideoFrame(ctx, src, sw, sh, W, H, clip, fit, srcTime = 0) {
  if (!sw || !sh) return;

  // Mode 1: Split-Screen Livestream (Atas Facecam, Bawah Gameplay)
  if (clip && clip.layout === 'split' && clip.split) {
    const sp = clip.split;
    const ratio = clampVal(sp.topRatio ?? 0.38, 0.2, 0.7);
    const topH = Math.round(H * ratio);
    const botH = H - topH;
    const topCrop = sp.swap ? sp.game : sp.cam;
    const botCrop = sp.swap ? sp.cam : sp.game;

    drawCropCover(ctx, src, sw, sh, topCrop, 0, 0, W, topH);
    drawCropCover(ctx, src, sw, sh, botCrop, 0, topH, W, botH);

    if (sp.divider !== false) {
      const dh = Math.max(2, Math.round(H * 0.003));
      ctx.fillStyle = typeof sp.divider === 'string' ? sp.divider : '#09090b';
      ctx.fillRect(0, topH - Math.floor(dh / 2), W, dh);
    }
    return;
  }

  // Mode 2: Podcast Auto-Reframe (Fill Portrait + Keyframe Fokus Pembicara)
  if (clip && clip.layout === 'podcast') {
    const kf = samplePodcastTrack(clip.track, srcTime, !!clip.trackSmooth);
    const zoom = Math.max(1, (kf.zoom || 1) * (clip.zoom || 1));
    const baseK = Math.max(W / sw, H / sh) * zoom;
    const dw = sw * baseK, dh = sh * baseK;
    // Batasi pergeseran ox/oy agar tidak memunculkan pinggiran hitam
    const maxOx = Math.max(0, (dw - W) / (2 * W));
    const maxOy = Math.max(0, (dh - H) / (2 * H));
    const ox = clampVal((kf.ox || 0) + (clip.ox || 0), -maxOx, maxOx);
    const oy = clampVal((kf.oy || 0) + (clip.oy || 0), -maxOy, maxOy);
    const p = placeFrame(sw, sh, W, H, 'fill', zoom, ox, oy);
    ctx.drawImage(src, p.x, p.y, p.w, p.h);
    return;
  }

  // Mode 3: Normal (Fit / Fill / Blur)
  if (fit === 'blur') blurBackdrop(ctx, src, sw, sh, W, H);
  const p = placeFrame(sw, sh, W, H, fit === 'fill' ? 'fill' : 'fit', clip && clip.zoom, clip && clip.ox, clip && clip.oy);
  ctx.drawImage(src, p.x, p.y, p.w, p.h);
}

/* ---------------- overlay gambar ---------------- */
export function drawOverlay(ctx, img, iw, ih, ov, W, H) {
  const w = Math.max(2, ov.w * W), h = w * ih / iw;
  ctx.save(); ctx.globalAlpha = ov.op ?? 1;
  ctx.drawImage(img, ov.x * W - w / 2, ov.y * H - h / 2, w, h);
  ctx.restore();
  return { x: ov.x * W - w / 2, y: ov.y * H - h / 2, w, h };
}

/* ---------------- teks ---------------- */
export function textMetrics(ctx, t, W, H) {
  const px = Math.max(8, (t.size / 100) * H);
  ctx.font = `${t.bold ? 700 : 500} ${px}px ${FONTS[t.font] || FONTS.sans}`;
  const lines = String(t.text || '').split('\n');
  const lh = px * 1.25;
  let w = 0; for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
  const pad = px * 0.35, h = lines.length * lh;
  const cx = t.x * W, cy = t.y * H;
  return { px, lines, lh, pad, cx, cy, w, h, box: { x: cx - w / 2 - pad, y: cy - h / 2 - pad / 2, w: w + pad * 2, h: h + pad } };
}
export function drawText(ctx, t, W, H) {
  const m = textMetrics(ctx, t, W, H);
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  if (t.bg) {
    ctx.fillStyle = t.bgColor || 'rgba(0,0,0,.6)';
    const b = m.box, r = m.px * 0.25;
    ctx.beginPath();
    ctx.moveTo(b.x + r, b.y); ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, r); ctx.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, r);
    ctx.arcTo(b.x, b.y + b.h, b.x, b.y, r); ctx.arcTo(b.x, b.y, b.x + b.w, b.y, r); ctx.closePath(); ctx.fill();
  }
  m.lines.forEach((ln, i) => {
    const y = m.cy - m.h / 2 + m.lh * (i + 0.5);
    if (!t.bg) { ctx.lineWidth = m.px / 7; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(ln, m.cx, y); }
    ctx.fillStyle = t.color || '#fff'; ctx.fillText(ln, m.cx, y);
  });
  ctx.restore();
  return m.box;
}

/* ---------------- sumber media (satu Input per media) ---------------- */
export function createPool(media, W = 1280, H = 720) {
  const inputs = new Map();
  const get = mid => {
    if (!inputs.has(mid)) {
      const m = media.get(mid); if (!m) throw new Error('Media hilang: ' + mid);
      inputs.set(mid, { input: new Input({ source: new BlobSource(m.blob), formats: ALL_FORMATS }), vt: undefined, at: undefined, vsink: null });
    }
    return inputs.get(mid);
  };
  return {
    async videoSink(mid) {
      const e = get(mid);
      if (e.vt === undefined) e.vt = await e.input.getPrimaryVideoTrack();
      if (!e.vt) return null;
      if (!e.vsink) e.vsink = new CanvasSink(e.vt, { width: Math.max(2, Math.min(e.vt.displayWidth, Math.round(Math.max(W, H) * 1.5))) });
      return e.vsink;
    },
    async audioSink(mid) {
      const e = get(mid);
      if (e.at === undefined) e.at = await e.input.getPrimaryAudioTrack();
      return e.at ? new AudioBufferSink(e.at) : null;
    },
    dispose() { for (const e of inputs.values()) { try { e.input.dispose?.(); } catch { /* abaikan */ } } inputs.clear(); },
  };
}

/* ---------------- mixing audio (dipakai ekspor & transkripsi timeline) ---------------- */
export function audioSources(p) {
  const out = [];
  for (const L of videoLayout(p)) {
    const c = L.clip;
    if (!c.mute && (c.vol ?? 1) > 0) out.push({ mid: c.mid, tl: L.start, in: c.in, out: c.out, vol: c.vol ?? 1, sp: c.speed || 1 });
  }
  for (const c of p.a) if ((c.vol ?? 1) > 0) out.push({ mid: c.mid, tl: c.start, in: c.in, out: c.out, vol: c.vol ?? 1, sp: c.speed || 1 });
  return out;
}
export async function mixRange(sources, getSink, c0, c1, sr, ch) {
  const octx = new OfflineAudioContext(ch, Math.max(1, Math.round((c1 - c0) * sr)), sr);
  for (const s of sources) {
    const len = (s.out - s.in) / s.sp, a0 = Math.max(c0, s.tl), a1 = Math.min(c1, s.tl + len);
    if (a1 <= a0) continue;
    const sink = await getSink(s.mid); if (!sink) continue;
    for await (const wb of sink.buffers(s.in + (a0 - s.tl) * s.sp, s.in + (a1 - s.tl) * s.sp)) {
      let when = s.tl + (wb.timestamp - s.in) / s.sp, off = 0, l = wb.buffer.duration;
      if (when < a0) { off = (a0 - when) * s.sp; when = a0; l -= off; }
      if (when + l / s.sp > a1) l = (a1 - when) * s.sp;
      if (l <= 0) continue;
      const node = octx.createBufferSource(), g = octx.createGain();
      node.buffer = wb.buffer; node.playbackRate.value = s.sp; g.gain.value = s.vol;
      node.connect(g); g.connect(octx.destination);
      node.start(when - c0, off, l);
    }
  }
  return octx.startRendering();
}
export async function mixMono16k(sources, pool, c0, c1, onProgress, signal) {
  const SR16 = 16000, total = Math.max(1, Math.round((c1 - c0) * SR16)), out = new Float32Array(total);
  let pos = 0;
  for (let t = c0; t < c1 - 1e-9; t += 30) {
    if (signal && signal.aborted) throw new DOMException('Dibatalkan', 'AbortError');
    const e = Math.min(c1, t + 30);
    const buf = await mixRange(sources, mid => pool.audioSink(mid), t, e, SR16, 1);
    const d = buf.getChannelData(0);
    out.set(d.subarray(0, Math.min(d.length, total - pos)), pos); pos += d.length;
    if (onProgress) onProgress((e - c0) / (c1 - c0));
  }
  return out;
}

/* ---------------- AI AUTO-CLIP: EKSTRAKSI AUDIO STREAMING 30–60 MENIT ---------------- */
// Encoder WAV 16-bit PCM mono murni JS (universal, 0 error lintas browser)
export function encodeWavMono16(pcm, sampleRate = 16000) {
  const len = pcm.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, len * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Encoder WebM/Opus super ringan (~24–32 kbps -> 10 menit audio hanya ~2 MB, aman batas payload Vercel 4.5 MB)
async function encodeOpusWebmChunk(pcm, sampleRate, codec) {
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const asrc = new AudioBufferSource({ codec, quality: QUALITY_LOW });
  output.addAudioTrack(asrc);
  await output.start();
  const step = sampleRate * 10;
  for (let off = 0; off < pcm.length; off += step) {
    const slice = pcm.subarray(off, Math.min(pcm.length, off + step));
    const ab = new AudioBuffer({ length: slice.length, numberOfChannels: 1, sampleRate });
    ab.copyToChannel(slice, 0);
    await asrc.add(ab);
  }
  asrc.close();
  await output.finalize();
  return new Blob([output.target.buffer], { type: 'audio/webm' });
}

/**
 * Mengekstrak audio dari video 30–60+ menit secara streaming hemat RAM, memecahnya menjadi chunk kecil
 * (aman untuk batas upload serverless 4.5 MB & batas Groq), sekaligus menghitung energi suara per detik.
 *
 * PERBAIKAN SINKRONISASI: sampel kini ditempatkan berdasarkan TIMESTAMP ASLI tiap buffer audio
 * (bukan sekadar disambung), dan resampling memakai rata-rata kotak per sampel keluaran. Versi lama
 * membuang pecahan sampel di setiap buffer sehingga waktu bergeser ±beberapa detik per jam
 * (kata akurat tapi teks makin telat/cepat di menit-menit akhir). Chunk juga dipotong di titik paling
 * sunyi (bukan di tengah kata) dan chunk senyap ditandai agar tidak dikirim (hemat kuota).
 *
 * opts: { preferOpus, chunkSec, from, to }  (from/to dalam detik; opsional untuk menganalisis sebagian)
 */
export async function extractAudioChunksForAI(blob, opts = {}, onProgress = () => {}, signal) {
  const abort = () => { if (signal && signal.aborted) throw new DOMException('Dibatalkan', 'AbortError'); };
  const SR = 16000;

  let opusCodec = null;
  if (opts.preferOpus !== false) {
    try { opusCodec = await getFirstEncodableAudioCodec(['opus'], { numberOfChannels: 1, sampleRate: SR }); } catch { opusCodec = null; }
  }
  const chunkSec = opts.chunkSec || (opusCodec ? 300 : 100);
  const chunkCap = Math.round(chunkSec * SR);

  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const at = await input.getPrimaryAudioTrack();
    if (!at) throw new Error('File video ini tidak memiliki track audio');
    const duration = (await input.computeDuration()) || 0;
    const from = Math.max(0, +opts.from || 0);
    const to = +opts.to > 0 ? Math.min(+opts.to, duration || +opts.to) : (duration || Infinity);
    if (to - from < 1) throw new Error('Rentang analisis terlalu pendek');

    const binCount = Math.max(1, Math.ceil(to) + 10);
    const secSq = new Float64Array(binCount), secCnt = new Uint32Array(binCount);

    const buf = new Float32Array(chunkCap);
    let pos = 0;                                   // jumlah sampel terisi di buf
    let chunkStartIdx = Math.round(from * SR);     // indeks global (16 kHz) sampel pertama buf
    let gIdx = chunkStartIdx;                      // indeks global sampel berikutnya yang akan ditulis
    const endIdxMax = Number.isFinite(to) ? Math.round(to * SR) : Infinity;
    const chunks = [];
    let chunkNo = 0;

    // titik potong paling sunyi pada ≤12 detik terakhir isi buf
    const quietCut = (n) => {
      const win = Math.round(0.05 * SR), span = Math.min(n - win, Math.round(12 * SR));
      if (span < win * 4) return n;
      let best = n, bestE = Infinity;
      for (let a = n - span; a + win <= n; a += win) {
        let s = 0; for (let i = a; i < a + win; i++) s += Math.abs(buf[i]);
        if (s < bestE) { bestE = s; best = a + (win >> 1); }
      }
      return best;
    };
    const rmsOf = (arr) => { let s = 0, c = 0; for (let i = 0; i < arr.length; i += 8) { s += arr[i] * arr[i]; c++; } return c ? Math.sqrt(s / c) : 0; };

    const flush = async (final) => {
      if (pos <= 0) return;
      let cut = final ? pos : quietCut(pos);
      if (cut < SR * 0.25) cut = pos;
      const slice = buf.slice(0, cut);
      const start = chunkStartIdx / SR, end = (chunkStartIdx + cut) / SR, rms = rmsOf(slice);
      if (slice.length >= SR * 0.25) {
        let outBlob = null, ext = 'wav', mime = 'audio/wav';
        if (opusCodec) {
          try { outBlob = await encodeOpusWebmChunk(slice, SR, opusCodec); ext = 'webm'; mime = 'audio/webm'; }
          catch { opusCodec = null; outBlob = null; }
        }
        if (!outBlob) {
          // fallback WAV: pecah per ≤110 dtk agar < 3.8 MB
          const maxWav = 110 * SR;
          for (let off = 0; off < slice.length; off += maxWav) {
            const sub = slice.subarray(off, Math.min(slice.length, off + maxWav)), wb = encodeWavMono16(sub, SR);
            chunks.push({ index: chunkNo++, start: start + off / SR, end: start + (off + sub.length) / SR, blob: wb, ext: 'wav', mime: 'audio/wav', size: wb.size, rms: rmsOf(sub), silent: rmsOf(sub) < 0.0015 });
          }
        } else {
          chunks.push({ index: chunkNo++, start, end, blob: outBlob, ext, mime, size: outBlob.size, rms, silent: rms < 0.0015 });
        }
      }
      const rem = pos - cut;
      if (rem > 0) buf.copyWithin(0, cut, pos);
      pos = Math.max(0, rem);
      chunkStartIdx += cut;
    };
    const put = async (v, k) => {
      buf[pos++] = v;
      const sb = Math.floor(k / SR);
      if (sb >= 0 && sb < binCount) { secSq[sb] += v * v; secCnt[sb]++; }
      if (pos >= chunkCap) await flush(false);
    };

    let lastEnd = 0, lastProg = 0;
    for await (const wb of new AudioBufferSink(at).buffers()) {
      abort();
      const ab = wb.buffer, srcSR = ab.sampleRate, nCh = ab.numberOfChannels, inLen = ab.length;
      const tBase = typeof wb.timestamp === 'number' && isFinite(wb.timestamp) ? wb.timestamp : lastEnd;
      lastEnd = tBase + ab.duration;
      if (lastEnd <= from) continue;
      if (tBase >= to) break;

      const mono = new Float32Array(inLen);
      for (let c = 0; c < nCh; c++) { const d = ab.getChannelData(c); for (let i = 0; i < inLen; i++) mono[i] += d[i]; }
      if (nCh > 1) for (let i = 0; i < inLen; i++) mono[i] /= nCh;

      let startIdx = Math.round(tBase * SR), endIdx = Math.min(Math.round(lastEnd * SR), endIdxMax);
      if (startIdx < gIdx) startIdx = gIdx;          // tumpang tindih → lewati bagian yang sudah ditulis
      if (endIdx <= startIdx) continue;
      while (gIdx < startIdx) { await put(0, gIdx); gIdx++; }   // celah/awal track audio terlambat → isi senyap (waktu tetap benar)

      const ratio = srcSR / SR;
      for (let k = startIdx; k < endIdx; k++) {
        const p0 = (k / SR - tBase) * srcSR, a = Math.max(0, Math.floor(p0)), b = Math.min(inLen, Math.max(a + 1, Math.ceil(p0 + ratio)));
        let s = 0; for (let j = a; j < b; j++) s += mono[j];
        await put(s / (b - a), k);
      }
      gIdx = endIdx;

      if (Number.isFinite(to)) {
        const p = Math.min(0.96, (lastEnd - from) / Math.max(1, to - from));
        if (p - lastProg >= 0.02) { lastProg = p; onProgress(p, `Ekstrak audio & analisa energi (${Math.round(p * 100)}%)`); }
      }
    }
    await flush(true);
    while (pos > 0) await flush(true);

    const t0 = Math.floor(from), t1 = Math.ceil(Number.isFinite(to) ? to : (chunks.length ? chunks[chunks.length - 1].end : from));
    const rmsArr = new Float32Array(Math.max(1, t1));
    for (let s = t0; s < t1 && s < binCount; s++) rmsArr[s] = secCnt[s] ? Math.sqrt(secSq[s] / secCnt[s]) : 0;
    const sorted = Array.from(rmsArr).filter(v => v > 0.001).sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0.01;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || Math.max(p50 * 2, 0.05);
    const hype = [], topHypeTimes = [];
    for (let s = 0; s < rmsArr.length; s++) {
      const score = Math.round(clampVal((rmsArr[s] - p50 * 0.5) / Math.max(1e-4, p95 - p50 * 0.5), 0, 1) * 100);
      hype.push({ t: s, rms: rmsArr[s], score });
      if (s >= t0 && score >= 78) topHypeTimes.push({ t: s, score });
    }
    onProgress(1, 'Audio siap dianalisa AI');
    return { duration: duration || t1, from, to: Number.isFinite(to) ? to : t1, chunks, hype, topHypeTimes };
  } finally {
    try { input.dispose?.(); } catch { /* abaikan */ }
  }
}

/* ---------------- PENYELARAS WAKTU KATA ↔ AUDIO (beat sync) ----------------
   Waktu kata dari Whisper (cloud maupun lokal) sering meleset 0.1–0.5 dtk dan kadang bergeser konstan.
   refineWordTimes() (1) mencari geseran global terbaik lewat korelasi "ada kata" vs "ada suara",
   (2) merapatkan batas antarkata ke lembah energi, dan (3) menaruh awal/akhir frasa di tepi naik/turun suara.
   words & pcm harus memakai titik nol waktu yang sama (detik relatif terhadap awal pcm). */
export function refineWordTimes(words, pcm, sr = 16000, opts = {}) {
  const out = words.map(w => ({ ...w })), n = out.length;
  if (!n || !pcm || pcm.length < sr) return { words: out, offset: 0, gain: 0 };
  const hop = Math.round(sr * 0.01), nF = Math.floor(pcm.length / hop), env = new Float32Array(nF);
  for (let i = 0; i < nF; i++) { let s = 0; for (let j = i * hop, k = j + hop; j < k; j++) s += pcm[j] * pcm[j]; env[i] = Math.sqrt(s / hop); }
  const es = new Float32Array(nF);
  for (let i = 0; i < nF; i++) { let s = 0, c = 0; for (let k = -1; k <= 1; k++) { const x = i + k; if (x >= 0 && x < nF) { s += env[x]; c++; } } es[i] = s / c; }
  const sorted = Array.from(es).sort((a, b) => a - b);
  const floor = sorted[Math.floor(nF * 0.15)] || 0, top = sorted[Math.floor(nF * 0.95)] || 0;
  const thr = Math.max(0.004, floor * 2.2, top * 0.06);
  const M = new Uint8Array(nF); for (let i = 0; i < nF; i++) M[i] = es[i] >= thr ? 1 : 0;

  // (1) geseran global
  const maxLag = Math.round((opts.maxShift ?? 2.0) * 100);
  const A = new Uint8Array(nF);
  for (const w of out) { const a = Math.max(0, Math.round(w.start * 100)), b = Math.min(nF, Math.round(w.end * 100)); for (let i = a; i < b; i++) A[i] = 1; }
  let sA = 0, sM = 0; for (let i = 0; i < nF; i++) { sA += A[i]; sM += M[i]; }
  const mA = sA / nF, mM = sM / nF;
  const corr = (d) => { let c = 0; for (let i = 0; i < nF; i++) { const j = i - d; if (j < 0 || j >= nF) continue; c += (A[j] - mA) * (M[i] - mM); } return c; };
  const c0 = corr(0); let bestD = 0, bestC = c0;
  for (let d = -maxLag; d <= maxLag; d += 2) { const c = corr(d); if (c > bestC) { bestC = c; bestD = d; } }
  for (let d = bestD - 1; d <= bestD + 1; d++) { const c = corr(d); if (c > bestC) { bestC = c; bestD = d; } }
  const norm = Math.max(1e-9, nF * Math.sqrt(Math.max(1e-9, mA * (1 - mA)) * Math.max(1e-9, mM * (1 - mM))));
  const gain = (bestC - c0) / norm;
  const offset = (bestD !== 0 && gain > (Math.abs(bestD) >= 30 ? 0.1 : 0.03)) ? bestD / 100 : 0;
  if (offset) for (const w of out) { w.start += offset; w.end += offset; }

  // (2) batas antarkata & (3) tepi frasa
  const fr = t => Math.max(0, Math.min(nF - 1, Math.round(t * 100)));
  const minD = 0.06;
  for (let i = 0; i < n - 1; i++) {
    const a = out[i], b = out[i + 1], gap = b.start - a.end;
    if (gap < 0.2) {
      const mid = (a.end + b.start) / 2, lo = fr(mid - 0.1), hi = fr(mid + 0.1);
      let mi = lo, mv = Infinity, ref = 0;
      for (let k = lo; k <= hi; k++) { if (es[k] < mv) { mv = es[k]; mi = k; } if (es[k] > ref) ref = es[k]; }
      const t = (mv < ref * 0.8) ? (mi + 0.5) / 100 : mid;
      const tt = Math.min(Math.max(t, a.start + minD), b.end - minD);
      a.end = tt; b.start = tt;
    } else {
      // akhir frasa a: tepi turun terakhir dalam ±0.25 dtk
      const lo = fr(a.end - 0.25), hi = fr(a.end + 0.25);
      let last = -1; for (let k = lo; k <= hi; k++) if (M[k]) last = k;
      if (last >= 0 && last + 3 < nF && !M[Math.min(nF - 1, last + 3)]) a.end = Math.max(a.start + minD, Math.min((last + 3) / 100, b.start));
      // awal frasa b: tepi naik pertama dalam ±0.25 dtk
      const lo2 = fr(b.start - 0.25), hi2 = fr(b.start + 0.25);
      let first = -1; for (let k = lo2; k <= hi2; k++) if (M[k] && (k < 3 || !M[k - 3])) { first = k; break; }
      if (first >= 0) b.start = Math.min(Math.max((first - 1) / 100, a.end), b.end - minD);
    }
  }
  { // kata pertama & terakhir
    const f = out[0], lo = fr(f.start - 0.25), hi = fr(f.start + 0.25);
    for (let k = lo; k <= hi; k++) if (M[k] && (k < 3 || !M[k - 3])) { f.start = Math.min(Math.max((k - 1) / 100, 0), f.end - minD); break; }
    const l = out[n - 1], lo2 = fr(l.end - 0.25), hi2 = fr(l.end + 0.25); let last = -1;
    for (let k = lo2; k <= hi2; k++) if (M[k]) last = k;
    if (last >= 0 && last + 3 < nF && !M[Math.min(nF - 1, last + 3)]) l.end = Math.max(l.start + minD, (last + 3) / 100);
  }
  for (let i = 0; i < n; i++) {
    const w = out[i];
    if (i > 0 && w.start < out[i - 1].end) { const m = (w.start + out[i - 1].end) / 2; out[i - 1].end = Math.max(out[i - 1].start + 0.03, m); w.start = out[i - 1].end; }
    if (w.end < w.start + 0.04) w.end = w.start + 0.04;
    w.start = +w.start.toFixed(3); w.end = +w.end.toFixed(3);
  }
  return { words: out, offset, gain };
}

/* ---------------- AI AUTO-REFRAME: SAMPLING FRAME & PELACAKAN WAJAH ---------------- */
/**
 * Mengambil snapshot frame pada daftar timestamp tertentu secara cepat lewat Mediabunny CanvasSink
 * (dipakai untuk mendeteksi posisi kamera streamer atau melacak pembicara podcast).
 */
export async function sampleMediaFrames(blob, timestamps, maxWidth = 480, signal) {
  const abort = () => { if (signal && signal.aborted) throw new DOMException('Dibatalkan', 'AbortError'); };
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error('Video tidak ditemukan');
    const srcW = vt.displayWidth, srcH = vt.displayHeight;
    const w = Math.max(64, Math.min(srcW, maxWidth));
    const sink = new CanvasSink(vt, { width: w });
    const frames = [];
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(timestamps)) {
      abort();
      if (wc && wc.canvas) {
        const c = makeCanvas(wc.canvas.width, wc.canvas.height);
        c.getContext('2d').drawImage(wc.canvas, 0, 0);
        frames.push({ t: timestamps[i], canvas: c, w: c.width, h: c.height });
      }
      i++;
    }
    return { srcW, srcH, frames };
  } finally {
    try { input.dispose?.(); } catch { /* abaikan */ }
  }
}

/**
 * Menghitung kotak crop Facecam (atas) & Gameplay (bawah) secara otomatis dari deteksi wajah
 * pada beberapa sampel frame livestream.
 * @param {Array<{x:number,y:number,w:number,h:number}>} faces - Bounding box wajah normalisasi 0..1
 */
export function buildSplitLayoutFromFaces(faces, opts = {}) {
  const topRatio = clampVal(opts.topRatio ?? 0.38, 0.22, 0.6);
  const fallback = SPLIT_PRESETS[opts.fallback || 'bottom-right'] || SPLIT_PRESETS['bottom-right'];
  if (!Array.isArray(faces) || !faces.length) {
    return {
      topRatio,
      swap: false,
      divider: '#09090b',
      cam: { ...fallback.cam },
      game: { ...fallback.game },
      detected: false,
    };
  }

  // Ambil median posisi wajah (tahan terhadap deteksi karakter game sesaat)
  const med = arr => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const fx = med(faces.map(f => f.x + f.w / 2));
  const fy = med(faces.map(f => f.y + f.h / 2));
  const fw = med(faces.map(f => f.w));
  const fh = med(faces.map(f => f.h));

  // Perluas area crop agar bahu & kepala streamer masuk nyaman (rasio mendekati 4:3 / 16:10)
  const camW = clampVal(Math.max(fw * 2.8, 0.22), 0.18, 0.42);
  const camH = clampVal(Math.max(fh * 2.6, 0.28), 0.22, 0.48);
  const camX = clampVal(fx - camW / 2, 0, 1 - camW);
  const camY = clampVal(fy - camH * 0.44, 0, 1 - camH);

  // Tentukan area gameplay yang paling bersih (menghindari sisi facecam)
  let gameX = 0.14, gameW = 0.72;
  if (fx < 0.32) { gameX = 0.20; gameW = 0.78; }
  else if (fx > 0.68) { gameX = 0.02; gameW = 0.78; }

  return {
    topRatio,
    swap: false,
    divider: '#09090b',
    cam: { x: +camX.toFixed(4), y: +camY.toFixed(4), w: +camW.toFixed(4), h: +camH.toFixed(4) },
    game: { x: gameX, y: 0, w: gameW, h: 1 },
    detected: true,
  };
}

/**
 * Mengubah hasil deteksi wajah per timestamp pada klip podcast menjadi daftar keyframe `clip.track`
 * dengan anti-jitter (menahan kamera minimal `minHoldSec` detik agar tidak goyang).
 * @param {Array<{t:number, faces:Array<{x:number,y:number,w:number,h:number}>}>} samples
 */
export function buildPodcastTrack(samples, opts = {}) {
  const srcAsp = opts.srcAsp || (16 / 9);
  const dstAsp = opts.dstAsp || (9 / 16);
  const zoom = opts.zoom || 1.05;
  const minHoldSec = opts.minHoldSec ?? 1.4;
  // Rumus offset X: jika wajah di posisi normalisasi cx (0..1), geser agar berada di tengah kanvas 9:16
  // Lebar gambar setelah fill terhadap lebar kanvas W adalah (srcAsp / dstAsp) * zoom
  const widthRatio = Math.max(1, (srcAsp / dstAsp) * zoom);
  const maxOx = Math.max(0, (widthRatio - 1) / 2);

  const cxToOx = cx => clampVal((0.5 - cx) * widthRatio, -maxOx, maxOx);

  const raw = [];
  let lastCx = 0.5;
  for (const s of samples || []) {
    const fs = s.faces || [];
    let targetCx = lastCx;
    if (fs.length === 1) {
      targetCx = fs[0].x + fs[0].w / 2;
    } else if (fs.length >= 2) {
      // Pilih wajah paling besar/dominan (biasanya close-up pembicara aktif)
      const best = fs.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
      targetCx = best.x + best.w / 2;
    }
    // Kuantisasi zona kiri / tengah / kanan agar kamera terasa seperti switcher studio
    let snappedCx = targetCx;
    if (opts.zoneSnap !== false) {
      if (targetCx < 0.36) snappedCx = Math.max(0.22, targetCx);
      else if (targetCx > 0.64) snappedCx = Math.min(0.78, targetCx);
      else snappedCx = 0.5;
    }
    lastCx = snappedCx;
    raw.push({ t: s.t, ox: +cxToOx(snappedCx).toFixed(4), oy: 0, zoom });
  }

  if (!raw.length) return [{ t: 0, ox: 0, oy: 0, zoom: 1 }];

  // Debounce / kompres keyframe agar hanya berpindah saat perubahan cukup signifikan dan melewati minHoldSec
  const track = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const prev = track[track.length - 1];
    const cur = raw[i];
    if (Math.abs(cur.ox - prev.ox) >= 0.14 && (cur.t - prev.t) >= minHoldSec) {
      track.push(cur);
    }
  }
  return track;
}

/* ---------------- AI AUTO-CLIP: SCORER LOKAL / FALLBACK TANPA API ---------------- */
const HOOK_REGEX = /\b(rahasia|jangan pernah|ternyata|kesalahan|kenapa|fakta|parah|gila|gokil|sebenernya|sebenarnya|masalahnya|jujur|percaya|bongkar|bahaya|untung|rugi|cuan|loss|gagal|sukses|tips|cara|secret|mistake|never|truth|insane|crazy|wait|listen|honestly|reason|why)\b/i;

/**
 * Menilai transkrip ber-timestamp + data hype audio secara lokal (fallback jika API LLM belum diisi,
 * atau sebagai pre-filter kandidat untuk video berdurasi panjang).
 */
export function findLocalViralCandidates(segments, hypeData = [], opts = {}) {
  const minDur = opts.minDur || 35;
  const maxDur = opts.maxDur || 65;
  const maxClips = opts.maxClips || 5;
  if (!Array.isArray(segments) || !segments.length) return [];

  const hypeMap = new Map();
  for (const h of hypeData) hypeMap.set(Math.floor(h.t), h.score || 0);

  const cands = [];
  for (let i = 0; i < segments.length; i++) {
    const start = segments[i].start;
    let text = '';
    let hookText = '';
    for (let j = i; j < segments.length; j++) {
      const seg = segments[j];
      const d = seg.end - start;
      text += (text ? ' ' : '') + String(seg.text || '').trim();
      if (seg.start - start <= 6) hookText += (hookText ? ' ' : '') + String(seg.text || '').trim();
      if (d < minDur) continue;
      if (d > maxDur) break;

      const words = text.split(/\s+/).filter(Boolean);
      const wps = words.length / Math.max(1, d);
      const hasHook = HOOK_REGEX.test(hookText);
      const hasQuestion = /\?/.test(hookText);
      const cleanEnd = /[.!?]$/.test(String(seg.text || '').trim());

      // Hitung rata-rata & puncak energi hype di dalam rentang klip ini
      let hypePeak = 0, hypeSum = 0, hypeN = 0;
      for (let s = Math.floor(start); s <= Math.ceil(seg.end); s++) {
        const hs = hypeMap.get(s) || 0;
        if (hs > hypePeak) hypePeak = hs;
        hypeSum += hs; hypeN++;
      }
      const hypeAvg = hypeN ? hypeSum / hypeN : 0;

      let score = 50;
      if (hasHook) score += 16;
      if (hasQuestion) score += 7;
      if (cleanEnd) score += 6;
      if (wps >= 1.8 && wps <= 3.8) score += 10; // tempo bicara padat & jelas
      score += Math.round(hypePeak * 0.14 + hypeAvg * 0.08);
      score = clampVal(score, 40, 98);

      const titleRaw = hookText.replace(/\s+/g, ' ').trim().slice(0, 64);
      const reasons = [];
      if (hasHook) reasons.push('Hook kuat di 5 detik awal');
      if (hypePeak >= 75) reasons.push('Ada puncak reaksi/energi audio tinggi');
      if (wps >= 2.0) reasons.push('Tempo pembahasan padat tanpa jeda kosong');
      if (!reasons.length) reasons.push('Segmen padat dengan alur kalimat utuh');

      cands.push({
        id: 'loc_' + i + '_' + j,
        title: titleRaw + (titleRaw.length >= 64 ? '…' : ''),
        start: +start.toFixed(2),
        end: +seg.end.toFixed(2),
        duration: +(seg.end - start).toFixed(1),
        viral_score: score,
        hook: hookText.slice(0, 120),
        reason: reasons.join(' · '),
        segments: segments.slice(i, j + 1),
      });
      // Ambil satu jendela optimal per titik awal (berhenti saat penutup kalimat bagus tercapai)
      if (cleanEnd && d >= 45) break;
    }
  }

  // Pilih top kandidat yang tidak saling tumpang tindih
  cands.sort((a, b) => b.viral_score - a.viral_score);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= maxClips) break;
    const overlap = picked.some(p => Math.min(p.end, c.end) - Math.max(p.start, c.start) > 8);
    if (!overlap) picked.push(c);
  }
  return picked.sort((a, b) => a.start - b.start);
}

/* ---------------- gelombang suara ---------------- */
export async function computePeaks(blob, bucket = 0.02) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const at = await input.getPrimaryAudioTrack(); if (!at) return null;
    const dur = (await input.computeDuration()) || 0;
    // Skala otomatis resolusi waveform untuk video 30–60 menit agar ringan di RAM
    if (dur > 900 && bucket < 0.08) bucket = 0.08;
    const peaks = new Float32Array(Math.ceil(dur / bucket) + 4);
    for await (const wb of new AudioBufferSink(at).buffers()) {
      const b = wb.buffer, sr = b.sampleRate, step = Math.max(1, Math.floor(sr * bucket / 6));
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < d.length; i += step) {
          const k = Math.floor((wb.timestamp + i / sr) / bucket), v = Math.abs(d[i]);
          if (k >= 0 && k < peaks.length && v > peaks[k]) peaks[k] = v;
        }
      }
    }
    return { peaks, bucket };
  } finally { try { input.dispose?.(); } catch { /* abaikan */ } }
}

/* ---------------- ekspor ---------------- */
async function pickFormat(W, H, fps, want) {
  const vOpt = { width: W, height: H, frameRate: fps }, aOpt = { numberOfChannels: 2, sampleRate: SR };
  if (want !== 'webm') {
    const v = await getFirstEncodableVideoCodec(['avc'], vOpt), a = await getFirstEncodableAudioCodec(['aac'], aOpt);
    if (v && a) return { fmt: new Mp4OutputFormat({ fastStart: 'in-memory' }), v, a, ext: 'mp4', mime: 'video/mp4' };
  }
  if (want !== 'mp4') {
    const v = await getFirstEncodableVideoCodec(['vp9', 'vp8', 'av1'], vOpt), a = await getFirstEncodableAudioCodec(['opus', 'vorbis'], aOpt);
    if (v && a) return { fmt: new WebMOutputFormat(), v, a, ext: 'webm', mime: 'video/webm' };
  }
  throw new Error('Browser ini belum bisa meng-encode video. Gunakan Chrome/Edge terbaru (desktop atau Android).');
}

export async function renderProject(p, media, opts = {}, onProgress = () => {}, signal) {
  const W = p.w, H = p.h, fps = p.fps || 30, D = projectDuration(p), fit = p.fit || 'fit';
  if (D <= 0) throw new Error('Timeline masih kosong');
  const abort = () => { if (signal && signal.aborted) throw new DOMException('Dibatalkan', 'AbortError'); };
  const sel = await pickFormat(W, H, fps, opts.format);
  const pool = createPool(media, W, H);

  const canvas = makeCanvas(W, H), ctx = canvas.getContext('2d');
  const output = new Output({ format: sel.fmt, target: new BufferTarget() });
  const vsrc = new CanvasSource(canvas, { codec: sel.v, quality: QUALITY[opts.quality] || QUALITY_HIGH });
  output.addVideoTrack(vsrc, { frameRate: fps });

  const layout = videoLayout(p), asrc = audioSources(p);
  let withAudio = false;
  for (const s of asrc) { if (await pool.audioSink(s.mid)) { withAudio = true; break; } }
  let audioOut = null;
  if (withAudio) { audioOut = new AudioBufferSource({ codec: sel.a, quality: QUALITY_HIGH }); output.addAudioTrack(audioOut); }
  await output.start();

  const ovs = (p.o || []).filter(o => o.end > o.start), bitmaps = new Map();
  for (const o of ovs) if (!bitmaps.has(o.mid) && media.get(o.mid)) bitmaps.set(o.mid, await createImageBitmap(media.get(o.mid).blob));
  const texts = p.t.filter(t => t.end > t.start && String(t.text || '').trim());

  const totalFrames = Math.ceil(D * fps), dur = 1 / fps;
  let frame = 0;
  const paint = async (i, wc, clip, srcTime = 0) => {
    abort();
    const t = i / fps;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (wc && wc.canvas) drawVideoFrame(ctx, wc.canvas, wc.canvas.width, wc.canvas.height, W, H, clip, fit, srcTime);
    for (const o of ovs) if (t >= o.start && t < o.end) { const bm = bitmaps.get(o.mid); if (bm) drawOverlay(ctx, bm, bm.width, bm.height, o, W, H); }
    for (const tx of texts) if (t >= tx.start && t < tx.end) drawText(ctx, tx, W, H);
    await vsrc.add(t, dur);
    frame++;
    if (frame % 5 === 0) onProgress(Math.min(0.85, (frame / totalFrames) * (withAudio ? 0.85 : 0.98)), 'Render video');
  };
  let i = 0;
  for (const L of layout) {
    const iEnd = Math.min(totalFrames, Math.ceil(L.end * fps - 1e-9)), sp = L.clip.speed || 1;
    const idx = [], ts = [];
    for (; i < iEnd; i++) { idx.push(i); ts.push(Math.min(L.clip.out, L.clip.in + Math.max(0, i / fps - L.start) * sp)); }
    if (!idx.length) continue;
    const sink = await pool.videoSink(L.clip.mid);
    if (!sink) { for (let k = 0; k < idx.length; k++) await paint(idx[k], null, L.clip, ts[k]); continue; }
    let n = 0;
    for await (const wc of sink.canvasesAtTimestamps(ts)) { await paint(idx[n], wc, L.clip, ts[n]); n++; }
    while (n < idx.length) { await paint(idx[n], null, L.clip, ts[n]); n++; }
  }
  while (i < totalFrames) { await paint(i, null, null, 0); i++; }
  vsrc.close();

  if (audioOut) {
    for (let c0 = 0; c0 < D - 1e-9; c0 += 30) {
      abort();
      const c1 = Math.min(D, c0 + 30);
      await audioOut.add(await mixRange(asrc, mid => pool.audioSink(mid), c0, c1, SR, 2));
      onProgress(0.85 + 0.14 * (c1 / D), 'Mixing audio');
    }
    audioOut.close();
  }

  await output.finalize();
  onProgress(1, 'Selesai');
  pool.dispose();
  for (const b of bitmaps.values()) b.close?.();
  return { blob: new Blob([output.target.buffer], { type: sel.mime }), ext: sel.ext, mime: sel.mime, vcodec: sel.v, acodec: audioOut ? sel.a : null, duration: D };
}

/* ---------------- baca info media ---------------- */
export async function probeMedia(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack(), at = await input.getPrimaryAudioTrack();
    let dur = 0; try { dur = await input.computeDuration(); } catch { /* abaikan */ }
    return { hasVideo: !!vt, hasAudio: !!at, w: vt ? vt.displayWidth : 0, h: vt ? vt.displayHeight : 0, dur: dur || 0, vcodec: vt ? vt.codec : null, acodec: at ? at.codec : null };
  } finally { try { input.dispose?.(); } catch { /* abaikan */ } }
}
