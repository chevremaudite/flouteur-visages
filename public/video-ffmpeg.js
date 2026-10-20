// Fallback video path (no WebCodecs, or a codec/container the browser can't handle):
// ffmpeg.wasm decodes the video in chunks, re-encodes it with x264 and muxes the audio back.
import { FFmpeg } from './vendor/ffmpeg/index.js';
import { FrameAnalyzer } from './analyzer.js';

const here = (p) => new URL(p, import.meta.url).href;

// Raw RGBA bytes held in ffmpeg's memory per chunk.
const CHUNK_BYTES = 192 * 1024 * 1024;

const KNOWN_RATES = { '23.98': '24000/1001', '29.97': '30000/1001', '47.95': '48000/1001', '59.94': '60000/1001', '119.88': '120000/1001' };

function parseProbe(text) {
  const info = { duration: null, fps: null, fpsArg: null, hasVideo: false, hasAudio: false };
  const d = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (d) info.duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
  const video = text.split('\n').find(l => /Stream #.*Video:/.test(l));
  if (video) {
    info.hasVideo = true;
    const m = video.match(/(\d+(?:\.\d+)?) fps/) || video.match(/(\d+(?:\.\d+)?) tbr/);
    if (m) {
      info.fps = parseFloat(m[1]);
      info.fpsArg = KNOWN_RATES[m[1]] ?? m[1];
    }
  }
  info.hasAudio = /Stream #.*Audio:/.test(text);
  if (!info.fps || info.fps > 240) { info.fps = 30; info.fpsArg = '30'; }
  return info;
}

export async function loadFFmpeg() {
  const ffmpeg = new FFmpeg();
  let log = [];
  ffmpeg.on('log', ({ message }) => { log.push(message); if (log.length > 400) log.shift(); });
  await ffmpeg.load({
    coreURL: here('./vendor/ffmpeg-core/ffmpeg-core.js'),
    wasmURL: here('./vendor/ffmpeg-core/ffmpeg-core.wasm'),
  });
  ffmpeg.run = async (args, what) => {
    log = [];
    const rc = await ffmpeg.exec(['-hide_banner', '-nostdin', ...args]);
    if (rc !== 0 && what) throw new Error(`${what} (ffmpeg) :\n${log.slice(-8).join('\n')}`);
    return rc;
  };
  ffmpeg.lastLog = () => log.join('\n');
  return ffmpeg;
}

const CRF = { veryhigh: 16, high: 18, medium: 23, low: 28 };

// report: { status(text), progress(done, total), preview(rgba, W, H) }
export async function blurVideoFfmpeg(file, opt, pool, report) {
  report.status('Chargement de ffmpeg…');
  const ffmpeg = await loadFFmpeg();
  try {
    return await run(ffmpeg, file, opt, pool, report);
  } finally {
    ffmpeg.terminate();
  }
}

async function run(ffmpeg, file, opt, pool, report) {
  const exec = ffmpeg.run;

  // The file is mounted, not copied: ffmpeg reads it straight from the local disk.
  const ext = (file.name.match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? '').toLowerCase();
  const inPath = `/in/input${ext}`;
  await ffmpeg.createDir('/in');
  await ffmpeg.mount('WORKERFS', { blobs: [{ name: `input${ext}`, data: file }] }, '/in');

  report.status('Analyse du fichier…');
  await exec(['-i', inPath]);
  const info = parseProbe(ffmpeg.lastLog());
  if (!info.hasVideo) throw new Error("Aucune piste vidéo n'a été trouvée dans ce fichier.");

  await exec(['-loglevel', 'error', '-i', inPath, '-map', '0:v:0', '-frames:v', '1', '-c:v', 'png', '-f', 'image2', '/probe.png'],
    'Impossible de décoder la vidéo');
  const png = await ffmpeg.readFile('/probe.png');
  await ffmpeg.deleteFile('/probe.png');
  const dv = new DataView(png.buffer, png.byteOffset);
  const W = dv.getUint32(16), H = dv.getUint32(20);

  const fps = info.fps;
  const total = info.duration ? Math.max(1, Math.round(info.duration * fps)) : null;
  const frameBytes = W * H * 4;
  const chunk = Math.max(4, Math.min(120, Math.floor(CHUNK_BYTES / frameBytes)));
  const analyzer = new FrameAnalyzer(pool, W, H, opt);

  const pad = (W % 2 || H % 2) ? ['-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2'] : [];
  const segments = [];
  let done = 0;

  // Encode a processed chunk as its own MPEG-TS segment, then move it out of ffmpeg's memory.
  const encode = async (raw, n) => {
    await ffmpeg.writeFile('/seg.raw', raw.length === n * frameBytes ? raw : raw.slice(0, n * frameBytes));
    await exec(['-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', info.fpsArg,
      '-i', '/seg.raw', ...pad, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(CRF[opt.quality] ?? 18),
      '-pix_fmt', 'yuv420p', '-f', 'mpegts', '/seg.ts'], "Erreur d'encodage");
    segments.push(new Blob([await ffmpeg.readFile('/seg.ts')]));
    await ffmpeg.deleteFile('/seg.ts');
    await ffmpeg.deleteFile('/seg.raw');
  };

  report.status('Floutage en cours…');
  let pending = null; // previous chunk, encoded while the current one is being analysed
  let decoded = 0;
  for (;;) {
    const seek = decoded > 0 ? ['-ss', ((decoded - 0.25) / fps).toFixed(6)] : [];
    await exec(['-loglevel', 'error', ...seek, '-i', inPath, '-map', '0:v:0', '-an', '-sn', '-dn',
      '-frames:v', String(chunk), '-r', info.fpsArg, '-fps_mode', 'cfr',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '/chunk.raw'], 'Erreur de décodage');
    let raw = null;
    try { raw = await ffmpeg.readFile('/chunk.raw'); await ffmpeg.deleteFile('/chunk.raw'); } catch { /* no output */ }
    const n = raw ? Math.floor(raw.length / frameBytes) : 0;
    decoded += n;

    const encoding = pending ? encode(pending.raw, pending.n) : null;
    const jobs = [];
    for (let i = 0; i < n; i++) {
      const px = new Uint8ClampedArray(raw.buffer, raw.byteOffset + i * frameBytes, frameBytes);
      if (pool.busy) await pool.whenIdle();
      jobs.push(analyzer.analyze(px).then(() => report.progress(++done, total)));
    }
    analyzer.finish();
    await Promise.all(jobs);
    if (encoding) await encoding;
    pending = null;
    if (n === 0) break;

    report.preview(new Uint8ClampedArray(raw.buffer, raw.byteOffset + (n - 1) * frameBytes, frameBytes), W, H);

    pending = { raw, n };
    if (n < chunk) {
      await encode(raw, n);
      break;
    }
  }
  if (done === 0) throw new Error("Aucune image n'a pu être décodée.");

  report.status('Assemblage de la vidéo finale…');
  const names = segments.map((_, i) => `seg${String(i).padStart(5, '0')}.ts`);
  await ffmpeg.createDir('/segs');
  await ffmpeg.mount('WORKERFS', { blobs: segments.map((data, i) => ({ name: names[i], data })) }, '/segs');
  await ffmpeg.writeFile('/list.txt', names.map(n => `file '/segs/${n}'`).join('\n'));

  const base = ['-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', '/list.txt'];
  const tail = ['-movflags', '+faststart', '-y', '/out.mp4'];
  let audioKept = false;
  if (opt.keepAudio && info.hasAudio) {
    const withAudio = [...base, '-i', inPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy'];
    if (await exec([...withAudio, '-c:a', 'copy', ...tail]) === 0) audioKept = true;
    else if (await exec([...withAudio, '-c:a', 'aac', '-b:a', '192k', ...tail]) === 0) audioKept = true;
  }
  if (!audioKept) await exec([...base, '-map', '0:v:0', '-c:v', 'copy', ...tail], "Erreur lors de l'assemblage");

  const out = await ffmpeg.readFile('/out.mp4');
  return {
    blob: new Blob([out], { type: 'video/mp4' }),
    frames: done, faces: analyzer.faces, framesWithFaces: analyzer.framesWithFaces,
    hadAudio: info.hasAudio, audioKept, engine: 'ffmpeg.wasm',
  };
}
