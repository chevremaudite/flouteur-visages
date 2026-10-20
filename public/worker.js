// Runs everything inside the visitor's browser. Detection: deface's CenterFace model
// (onnxruntime-web, WebGPU when available, otherwise one CPU worker per core).
// Videos: WebCodecs when possible, ffmpeg.wasm otherwise. Images: canvas.
import { DetectorPool } from './pool.js';
import { FrameAnalyzer } from './analyzer.js';
import { blurVideoWebCodecs } from './video-webcodecs.js';
import { blurVideoFfmpeg } from './video-ffmpeg.js';

const here = (p) => new URL(p, import.meta.url).href;
const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Photos are analysed at no less than this size (deface uses the full resolution),
// and never above MAX_IMAGE_SIDE to keep memory in check.
const MIN_IMAGE_SIDE = 1920;
const MAX_IMAGE_SIDE = 4096;

let poolPromise = null;

// Frames per second a pool sustains on a typical 640x384 network input.
async function benchmark(pool) {
  const W = 640, H = 384;
  const run = (n) => Promise.all(Array.from({ length: n }, () =>
    pool.detect({ pixels: new Uint8ClampedArray(W * H * 4).fill(128), wNew: W, hNew: H, W, H, threshold: 0.5 })));
  await run(pool.size); // warm-up (WebGPU compiles shaders per input size)
  const t = performance.now();
  await run(pool.size * 2);
  return (pool.size * 2) / ((performance.now() - t) / 1000);
}

async function createPool(opt) {
  const res = await fetch(here('./models/centerface-dynamic.onnx'));
  if (!res.ok) throw new Error(`Impossible de charger le modèle (${res.status})`);
  const model = new Uint8Array(await res.arrayBuffer());
  const cpu = await DetectorPool.create(here('./detector.js'), opt.workers, model, 'wasm');
  if (opt.accel === 'cpu' || !navigator.gpu) return cpu;

  // Use the GPU only if it actually beats the CPU workers: integrated or software
  // (emulated) adapters can be much slower.
  let gpu = null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter || adapter.info?.isFallbackAdapter) return cpu;
    post('status', { text: 'Choix du moteur le plus rapide…' });
    gpu = await DetectorPool.create(here('./detector.js'), 2, model, 'webgpu');
    // Give up on GPUs too slow to even finish the benchmark in a few seconds.
    const gpuRate = await Promise.race([benchmark(gpu), new Promise(r => setTimeout(r, 5000, 0))]);
    const cpuRate = gpuRate ? await benchmark(cpu) : Infinity;
    console.info(`Détection : WebGPU ${gpuRate.toFixed(1)} im/s, CPU ${cpuRate.toFixed(1)} im/s`);
    if (gpuRate > cpuRate) {
      cpu.terminate();
      return gpu;
    }
  } catch (err) {
    console.warn('WebGPU indisponible, détection sur le processeur :', err);
  }
  gpu?.terminate();
  return cpu;
}

function isImage(file) {
  return file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name);
}

function makeReport(id) {
  const t0 = performance.now();
  let lastProgress = 0, lastPreview = 0;
  return {
    t0,
    status: (text) => post('status', { id, text }),
    progress(done, total) {
      const now = performance.now();
      if (now - lastProgress < 200 && done !== total) return;
      lastProgress = now;
      post('progress', { id, done, total, elapsed: (now - t0) / 1000 });
    },
    preview(px, W, H) {
      const now = performance.now();
      if (now - lastPreview < 700) return;
      lastPreview = now;
      createImageBitmap(new ImageData(new Uint8ClampedArray(px), W, H))
        .then(bitmap => post('preview', { id, bitmap }, [bitmap]));
    },
  };
}

async function blurImage(file, opt, pool) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const heic = /\.(heic|heif)$/i.test(file.name);
    throw new Error("Ce navigateur ne sait pas lire ce format d'image" + (heic ? ' (HEIC : utilisez Safari, ou exportez la photo en JPEG).' : '.'));
  }
  const W = bmp.width, H = bmp.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const px = ctx.getImageData(0, 0, W, H).data;
  const maxSide = Math.min(MAX_IMAGE_SIDE, opt.maxSide ? Math.max(opt.maxSide, MIN_IMAGE_SIDE) : Math.max(W, H));
  const analyzer = new FrameAnalyzer(pool, W, H, opt, maxSide);
  const analyzed = analyzer.analyze(px);
  analyzer.finish(); // a photo has no next frame
  await analyzed;
  ctx.putImageData(new ImageData(px, W, H), 0, 0);
  // Re-encoding through a canvas also drops EXIF metadata (GPS position, device…).
  const type = IMAGE_TYPES.includes(file.type) ? file.type : 'image/jpeg';
  const blob = await canvas.convertToBlob({ type, quality: 0.92 });
  return { blob, frames: 1, faces: analyzer.faces, framesWithFaces: analyzer.framesWithFaces, engine: 'image' };
}

async function blurVideo(file, opt, pool, report) {
  if (opt.engine !== 'ffmpeg') {
    try {
      const result = await blurVideoWebCodecs(file, opt, pool, report);
      if (result) return result;
    } catch (err) {
      console.warn('WebCodecs a échoué, nouvel essai avec ffmpeg.wasm :', err);
      report.status('Nouvel essai avec ffmpeg.wasm…');
    }
  }
  return blurVideoFfmpeg(file, opt, pool, report);
}

async function processItem({ id, file }, opt, pool) {
  const report = makeReport(id);
  post('item-start', { id, kind: isImage(file) ? 'image' : 'video' });
  try {
    const result = isImage(file) ? await blurImage(file, opt, pool) : await blurVideo(file, opt, pool, report);
    post('item-done', { id, ...result, elapsed: (performance.now() - report.t0) / 1000 });
  } catch (err) {
    console.error(err);
    post('item-error', { id, message: String(err?.message ?? err) });
  }
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'start') return;
  const opt = data.options;
  let pool;
  try {
    post('status', { text: 'Chargement du modèle de détection…' });
    poolPromise ??= createPool(opt);
    pool = await poolPromise;
    post('backend', { backend: pool.backend, size: pool.size });
  } catch (err) {
    poolPromise = null;
    post('fatal', { message: String(err?.message ?? err) });
    return;
  }

  // Photos are processed several at a time; videos one by one.
  const running = new Set();
  for (const item of data.items) {
    if (isImage(item.file)) {
      if (running.size >= pool.size) await Promise.race(running);
      const p = processItem(item, opt, pool).finally(() => running.delete(p));
      running.add(p);
    } else {
      await Promise.all(running);
      await processItem(item, opt, pool);
    }
  }
  await Promise.all(running);
  post('all-done');
};
