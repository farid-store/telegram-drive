// mux.mjs — gabung track video (tanpa audio) + audio jadi satu MP4 di browser, TANPA encode ulang.
// Memakai Mediabunny (MPL-2.0, lihat mediabunny.LICENSE.txt). Dipakai oleh tombol "+ Audio" di index.html.
import {
  Input, Output, BlobSource, ALL_FORMATS, Mp4OutputFormat, BufferTarget,
  EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource,
} from './mediabunny.min.mjs';

export async function muxVideoAudio(videoBlob, audioBlob, onProgress) {
  const vin = new Input({ source: new BlobSource(videoBlob), formats: ALL_FORMATS });
  const ain = new Input({ source: new BlobSource(audioBlob), formats: ALL_FORMATS });
  try {
    const vt = await vin.getPrimaryVideoTrack();
    const at = await ain.getPrimaryAudioTrack();
    if (!vt) throw new Error('Track video tidak ditemukan di file video');
    if (!at) throw new Error('Track audio tidak ditemukan di file audio');

    const format = new Mp4OutputFormat({ fastStart: 'in-memory' });
    if (!format.getSupportedVideoCodecs().includes(vt.codec)) throw new Error('Codec video ' + vt.codec + ' tidak didukung untuk MP4');
    if (!format.getSupportedAudioCodecs().includes(at.codec)) throw new Error('Codec audio ' + at.codec + ' tidak didukung untuk MP4');

    const output = new Output({ format, target: new BufferTarget() });
    const vs = new EncodedVideoPacketSource(vt.codec);
    const as = new EncodedAudioPacketSource(at.codec);
    output.addVideoTrack(vs);
    output.addAudioTrack(as);
    await output.start();

    const vcfg = await vt.getDecoderConfig();
    const acfg = await at.getDecoderConfig();
    const total = (await vt.computeDuration()) || 1;
    let done = 0;
    const copy = async (track, src, cfg, report) => {
      let first = true;
      for await (const p of new EncodedPacketSink(track).packets()) {
        await src.add(p, first ? { decoderConfig: cfg } : undefined);
        first = false;
        if (report && onProgress) { done = Math.max(done, p.timestamp); onProgress(Math.min(1, done / total)); }
      }
    };
    await Promise.all([copy(vt, vs, vcfg, true), copy(at, as, acfg, false)]);
    await output.finalize();
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } finally {
    vin.dispose?.(); ain.dispose?.();
  }
}
