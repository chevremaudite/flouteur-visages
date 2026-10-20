// Fast video path: the browser's own (usually hardware) decoder and encoder through
// WebCodecs, via Mediabunny. Needs a secure context (HTTPS) and a supported codec;
// returns null when it can't handle the file so the caller can fall back to ffmpeg.wasm.
import {
  Input, Output, BlobSource, BufferTarget, Mp4OutputFormat, ALL_FORMATS, Conversion,
  VideoSampleSink, VideoSampleSource, VideoSample, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
  QUALITY_VERY_HIGH, QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_LOW,
} from './vendor/mediabunny/mediabunny.min.mjs';
import { FrameAnalyzer } from './analyzer.js';

const QUALITY = { veryhigh: QUALITY_VERY_HIGH, high: QUALITY_HIGH, medium: QUALITY_MEDIUM, low: QUALITY_LOW };

// Returns { track, W, H, codec, input } or null when this path can't be used.
async function probe(file) {
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') return null;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let track;
  try {
    track = await input.getPrimaryVideoTrack();
  } catch {
    return null; // unsupported container
  }
  if (!track || !(await track.canDecode())) return null;
  // H.264 & co need even dimensions: drop the last row/column if needed.
  const W = (await track.getDisplayWidth()) & ~1, H = (await track.getDisplayHeight()) & ~1;
  // No AV1: Firefox on Linux may report it as encodable through the system's librav1e,
  // which then aborts and takes the whole tab down (no error ever reaches us).
  // ffmpeg.wasm (H.264) handles browsers that can't encode any of these.
  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9'], { width: W, height: H });
  if (!codec) return null;
  return { input, track, W, H, codec };
}

// report: { status(text), progress(done, total), preview(rgba, W, H) }
export async function blurVideoWebCodecs(file, opt, pool, report) {
  report.status('Analyse du fichier…');
  const p = await probe(file);
  if (!p) return null;
  const { input, track, W, H, codec } = p;
  const total = (await track.computePacketStats()).packetCount || null;
  const hadAudio = !!(await input.getPrimaryAudioTrack().catch(() => null));

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new VideoSampleSource({ codec, quality: QUALITY[opt.quality] ?? QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source);

  // Audio is copied when players handle it well in MP4, transcoded otherwise
  // (e.g. PCM from phones/cameras: valid in MP4 but unplayable in many players).
  let audio = null;
  if (opt.keepAudio && hadAudio) {
    audio = await Conversion.init({
      input, output, composable: true, tracks: 'primary', showWarnings: false,
      video: { discard: true },
      audio: async (track) => ['aac', 'mp3', 'opus'].includes(track.codec)
        ? {}
        : { codec: await getFirstEncodableAudioCodec(['aac', 'opus']) ?? undefined, forceTranscode: true },
    });
  }
  const audioKept = !!audio && audio.utilizedTracks.length > 0;

  await output.start();
  const audioDone = audio ? audio.execute() : Promise.resolve();

  const analyzer = new FrameAnalyzer(pool, W, H, opt);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const dispW = await track.getDisplayWidth(), dispH = await track.getDisplayHeight();

  report.status('Floutage en cours…');
  // Frames are analysed in parallel but must reach the encoder in order.
  const queue = [];
  let done = 0;
  const flushOne = async () => {
    const job = queue.shift();
    await job.analyzed;
    report.preview(job.px, W, H);
    const sample = new VideoSample(job.px, {
      format: 'RGBA', codedWidth: W, codedHeight: H, timestamp: job.timestamp, duration: job.duration,
    });
    await source.add(sample);
    sample.close();
    report.progress(++done, total);
  };

  try {
    for await (const sample of new VideoSampleSink(track).samples()) {
      const end = sample.timestamp + sample.duration;
      if (end <= 0) { sample.close(); continue; }
      sample.draw(ctx, 0, 0, dispW, dispH); // applies rotation metadata, like ffmpeg/deface
      const timestamp = Math.max(0, sample.timestamp), duration = end - timestamp;
      sample.close();
      const px = ctx.getImageData(0, 0, W, H).data;
      // In fast mode the oldest frame may wait for the one after it: keep at least 2 queued.
      while (queue.length >= Math.max(pool.size, 2)) await flushOne();
      queue.push({ px, timestamp, duration, analyzed: analyzer.analyze(px) });
    }
    analyzer.finish();
    while (queue.length) await flushOne();
    if (done === 0) throw new Error("Aucune image n'a pu être décodée.");
    source.close();
    report.status('Assemblage de la vidéo finale…');
    await audioDone;
    await output.finalize();
  } catch (err) {
    await audio?.cancel().catch(() => {});
    await output.cancel().catch(() => {});
    throw err;
  }

  return {
    blob: new Blob([output.target.buffer], { type: 'video/mp4' }),
    frames: done, faces: analyzer.faces, framesWithFaces: analyzer.framesWithFaces,
    hadAudio, audioKept, engine: `WebCodecs (${codec})`,
  };
}
