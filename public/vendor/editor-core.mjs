// editor-core.mjs — inti editor video VaultDL: model timeline, gambar teks, dan render/ekspor offline.
// Semua berjalan di browser (WebCodecs via Mediabunny, MPL-2.0). Tidak ada yang diunggah ke server.
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

/* ---------------- model ---------------- */
// project = { w, h, fps, v:[{id,mid,in,out,vol,mute}], a:[{id,mid,start,in,out,vol}], t:[{id,text,start,end,x,y,size,color,bg,bgColor,bold,font}] }
export const clipLen = c => Math.max(0, c.out - c.in);
export function videoLayout(p) {
  let t = 0;
  return p.v.map(clip => { const s = t; t += clipLen(clip); return { clip, start: s, end: t }; });
}
export function audioEnd(p) { return p.a.reduce((m, c) => Math.max(m, c.start + clipLen(c)), 0); }
export function projectDuration(p) {
  const v = p.v.reduce((s, c) => s + clipLen(c), 0);
  return v > 0 ? v : audioEnd(p);
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
  const W = p.w, H = p.h, fps = p.fps || 30, D = projectDuration(p);
  if (D <= 0) throw new Error('Timeline masih kosong');
  const abort = () => { if (signal && signal.aborted) throw new DOMException('Dibatalkan', 'AbortError'); };
  const sel = await pickFormat(W, H, fps, opts.format);

  const inputs = new Map();
  const getInput = mid => {
    if (!inputs.has(mid)) {
      const m = media.get(mid); if (!m) throw new Error('Media hilang: ' + mid);
      inputs.set(mid, { input: new Input({ source: new BlobSource(m.blob), formats: ALL_FORMATS }), vt: undefined, at: undefined, vsink: null });
    }
    return inputs.get(mid);
  };
  const videoSink = async mid => {
    const e = getInput(mid);
    if (e.vt === undefined) e.vt = await e.input.getPrimaryVideoTrack();
    if (!e.vt) return null;
    if (!e.vsink) e.vsink = new CanvasSink(e.vt, { width: W, height: H, fit: 'contain' });
    return e.vsink;
  };
  const audioSink = async mid => {
    const e = getInput(mid);
    if (e.at === undefined) e.at = await e.input.getPrimaryAudioTrack();
    return e.at ? new AudioBufferSink(e.at) : null;
  };

  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d');
  const output = new Output({ format: sel.fmt, target: new BufferTarget() });
  const vsrc = new CanvasSource(canvas, { codec: sel.v, quality: QUALITY[opts.quality] || QUALITY_HIGH });
  output.addVideoTrack(vsrc, { frameRate: fps });

  // sumber audio: audio klip video (kecuali dibisukan) + klip audio
  const layout = videoLayout(p);
  const asrc = [];
  for (const L of layout) if (!L.clip.mute && (L.clip.vol ?? 1) > 0) asrc.push({ mid: L.clip.mid, tl: L.start, in: L.clip.in, out: L.clip.out, vol: L.clip.vol ?? 1 });
  for (const c of p.a) if ((c.vol ?? 1) > 0) asrc.push({ mid: c.mid, tl: c.start, in: c.in, out: c.out, vol: c.vol ?? 1 });
  let withAudio = false;
  for (const s of asrc) { if (await audioSink(s.mid)) { withAudio = true; break; } }
  let audioOut = null;
  if (withAudio) { audioOut = new AudioBufferSource({ codec: sel.a, quality: QUALITY_HIGH }); output.addAudioTrack(audioOut); }

  await output.start();

  /* ---- video: per klip, frame diambil berurutan lewat canvasesAtTimestamps ---- */
  const totalFrames = Math.ceil(D * fps);
  const dur = 1 / fps;
  const texts = p.t.filter(t => t.end > t.start && String(t.text || '').trim());
  const drawOverlay = t => { for (const tx of texts) if (t >= tx.start && t < tx.end) drawText(ctx, tx, W, H); };
  let frame = 0;
  const paint = async (i, wrapped) => {
    abort();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (wrapped && wrapped.canvas) ctx.drawImage(wrapped.canvas, 0, 0, W, H);
    drawOverlay(i / fps);
    await vsrc.add(i / fps, dur);
    frame++;
    if (frame % 5 === 0) onProgress(Math.min(0.85, (frame / totalFrames) * (withAudio ? 0.85 : 0.98)), 'Render video');
  };
  let i = 0;
  for (const L of layout) {
    const iEnd = Math.min(totalFrames, Math.ceil(L.end * fps - 1e-9));
    const idx = [], ts = [];
    for (; i < iEnd; i++) { idx.push(i); ts.push(L.clip.in + Math.max(0, i / fps - L.start)); }
    if (!idx.length) continue;
    const sink = await videoSink(L.clip.mid);
    if (!sink) { for (const k of idx) await paint(k, null); continue; }
    let n = 0;
    for await (const wc of sink.canvasesAtTimestamps(ts)) { await paint(idx[n++], wc); }
    while (n < idx.length) await paint(idx[n++], null);
  }
  while (i < totalFrames) { await paint(i, null); i++; }   // timeline hanya audio / sisa
  vsrc.close();

  /* ---- audio: dimix per potongan 30 detik lewat OfflineAudioContext ---- */
  if (audioOut) {
    const CH = 30;
    for (let c0 = 0; c0 < D - 1e-9; c0 += CH) {
      abort();
      const c1 = Math.min(D, c0 + CH);
      const octx = new OfflineAudioContext(2, Math.max(1, Math.round((c1 - c0) * SR)), SR);
      for (const s of asrc) {
        const len = s.out - s.in, a0 = Math.max(c0, s.tl), a1 = Math.min(c1, s.tl + len);
        if (a1 <= a0) continue;
        const sink = await audioSink(s.mid); if (!sink) continue;
        for await (const wb of sink.buffers(s.in + (a0 - s.tl), s.in + (a1 - s.tl))) {
          let when = s.tl + (wb.timestamp - s.in), off = 0, l = wb.buffer.duration;
          if (when < a0) { off = a0 - when; when = a0; l -= off; }
          if (when + l > a1) l = a1 - when;
          if (l <= 0) continue;
          const node = octx.createBufferSource(), g = octx.createGain();
          node.buffer = wb.buffer; g.gain.value = s.vol;
          node.connect(g); g.connect(octx.destination);
          node.start(when - c0, off, l);
        }
      }
      const mixed = await octx.startRendering();
      await audioOut.add(mixed);
      onProgress(0.85 + 0.14 * (c1 / D), 'Mixing audio');
    }
    audioOut.close();
  }

  await output.finalize();
  onProgress(1, 'Selesai');
  for (const e of inputs.values()) { try { e.input.dispose?.(); } catch { /* abaikan */ } }
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
