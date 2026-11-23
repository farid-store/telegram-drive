// editor-core.mjs — inti editor video VaultDL: model timeline, gambar teks/overlay, render/ekspor offline,
// gelombang suara, split-screen streamer, dan penyiapan audio untuk transkripsi.
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
const makeCanvas = (w, h) => typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });

/* ---------------- model ---------------- */
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

/* ---------------- bingkai video: muat / isi / latar blur / split stream ---------------- */
export function placeFrame(sw, sh, W, H, fit, zoom = 1, ox = 0, oy = 0) {
  let k = fit === 'fill' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  k *= zoom || 1;
  const w = sw * k, h = sh * k;
  return { x: (W - w) / 2 + (ox || 0) * W, y: (H - h) / 2 + (oy || 0) * H, w, h };
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
function drawSplitFrame(ctx, src, sw, sh, W, H, clip) {
  const ratio = Math.min(0.65, Math.max(0.2, clip?.spRatio ?? 0.38));
  const topH = Math.round(H * ratio);
  const botH = H - topH;

  // 1. Layar Atas: Facecam Streamer (fokus ke koordinat camX, camY 0..1)
  const camZoom = clip?.camZoom ?? 2.6;
  const fx = clip?.camX ?? 0.85;
  const fy = clip?.camY ?? 0.80;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, W, topH); ctx.clip();
  const kTop = Math.max(W / sw, topH / sh) * camZoom;
  const tw = sw * kTop, th = sh * kTop;
  const tx = Math.min(0, Math.max(W - tw, W / 2 - fx * tw));
  const ty = Math.min(0, Math.max(topH - th, topH / 2 - fy * th));
  ctx.drawImage(src, tx, ty, tw, th);
  ctx.restore();

  // 2. Layar Bawah: Gameplay (menggunakan zoom, ox, oy utama klip)
  ctx.save();
  ctx.beginPath(); ctx.rect(0, topH, W, botH); ctx.clip();
  const pb = placeFrame(sw, sh, W, botH, 'fill', clip?.zoom || 1, clip?.ox || 0, clip?.oy || 0);
  ctx.drawImage(src, pb.x, topH + pb.y, pb.w, pb.h);
  ctx.restore();

  // Garis pemisah tipis
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(0, topH - 1, W, 2);
  ctx.restore();
}
export function drawVideoFrame(ctx, src, sw, sh, W, H, clip, fit) {
  if (!sw || !sh) return;
  if (fit === 'split') return drawSplitFrame(ctx, src, sw, sh, W, H, clip);
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

/* ---------------- mixing audio (dipakai ekspor & transkripsi) ---------------- */
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

/* ---------------- gelombang suara ---------------- */
export async function computePeaks(blob, bucket = 0.02) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const at = await input.getPrimaryAudioTrack(); if (!at) return null;
    const dur = (await input.computeDuration()) || 0;
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
  const paint = async (i, wc, clip) => {
    abort();
    const t = i / fps;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (wc && wc.canvas) drawVideoFrame(ctx, wc.canvas, wc.canvas.width, wc.canvas.height, W, H, clip, fit);
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
    if (!sink) { for (const k of idx) await paint(k, null, L.clip); continue; }
    let n = 0;
    for await (const wc of sink.canvasesAtTimestamps(ts)) { await paint(idx[n++], wc, L.clip); }
    while (n < idx.length) await paint(idx[n++], null, L.clip);
  }
  while (i < totalFrames) { await paint(i, null, null); i++; }
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
