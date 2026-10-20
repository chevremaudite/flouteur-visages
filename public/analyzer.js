import { CenterFace, anonymizeFrame } from './deface.js';

// Second analysis pass in "thorough" mode: upscaled for small faces, at most this size.
const MAX_UPSCALED_SIDE = 2560;

// Shared by the image and both video paths: turns full-size RGBA frames into the
// network input, runs detection on the pool and applies deface's filter in place.
//
// opt.mode:
// - 'fast'     the network only runs on every other frame; in-between frames get the
//              boxes of both neighbouring frames, merged.
// - 'precise'  deface's behaviour: every frame, one pass.
// - 'thorough' every frame, two passes at different scales (catches small/distant and
//              very large faces), and each frame also gets the boxes found in the frames
//              just before and after it (covers faces missed for a frame: motion blur,
//              head turning…).
export class FrameAnalyzer {
  constructor(pool, W, H, opt, maxSide = opt.maxSide) {
    this.pool = pool;
    this.W = W;
    this.H = H;
    this.opt = opt;
    this.mode = opt.mode ?? 'precise';
    // Network input size: original resolution (deface's default) or downscaled.
    const f = maxSide ? Math.min(1, maxSide / Math.max(W, H)) : 1;
    this.passes = [this.makePass(f)];
    if (this.mode === 'thorough') {
      const up = Math.min(1.5 * f, MAX_UPSCALED_SIDE / Math.max(W, H));
      this.passes.push(this.makePass(up > f * 1.2 ? up : f * 0.5));
    }
    this.faces = 0;
    this.framesWithFaces = 0;
    this.index = -1;
  }

  makePass(f) {
    const { wNew, hNew } = CenterFace.shapeTransform(Math.max(32, Math.round(this.W * f)), Math.max(32, Math.round(this.H * f)));
    const pass = { wNew, hNew };
    if (wNew !== this.W || hNew !== this.H) {
      this.full ??= new OffscreenCanvas(this.W, this.H);
      this.fctx ??= this.full.getContext('2d', { willReadFrequently: true });
      pass.canvas = new OffscreenCanvas(wNew, hNew);
      pass.ctx = pass.canvas.getContext('2d', { willReadFrequently: true });
      pass.ctx.imageSmoothingEnabled = true;
      pass.ctx.imageSmoothingQuality = 'high';
    }
    return pass;
  }

  // Detections for one frame, all passes merged. Resolves to [[x1, y1, x2, y2, score], ...].
  detect(px) {
    const { W, H, opt } = this;
    if (this.full) this.fctx.putImageData(new ImageData(px, W, H), 0, 0);
    const runs = this.passes.map(({ wNew, hNew, ctx }) => {
      let pixels = px.slice();
      if (ctx) {
        ctx.drawImage(this.full, 0, 0, wNew, hNew);
        pixels = ctx.getImageData(0, 0, wNew, hNew).data;
      }
      return this.pool.detect({ pixels, wNew, hNew, W, H, threshold: opt.threshold });
    });
    return Promise.all(runs).then(results => results.reduce(mergeDets));
  }

  apply(px, dets) {
    anonymizeFrame(dets, px, this.W, this.H, this.opt);
    this.faces += dets.length;
    if (dets.length) this.framesWithFaces++;
    return dets.length;
  }

  // Starts work on the next frame (frames must be passed in order); resolves once the
  // frame has been anonymized in place. In 'fast' and 'thorough' modes a frame depends on
  // the frame after it, so its promise only settles once that frame has been passed in,
  // or finish() has been called.
  analyze(px) {
    const i = ++this.index;
    if (this.mode === 'fast' && i % 2 === 1) {
      const previous = this.previous;
      const next = new Promise(resolve => { this.pending = { resolve, px, kind: 'skipped' }; });
      return Promise.all([previous, next]).then(([a, b]) => this.apply(px, mergeDets(a, b)));
    }
    const own = this.detect(px);
    this.pending?.resolve(own);
    this.pending = null;
    const previous = this.previous ?? Promise.resolve([]);
    this.previous = own;
    if (this.mode !== 'thorough') return own.then(d => this.apply(px, d));
    const next = new Promise(resolve => { this.pending = { resolve, px, kind: 'neighbour' }; });
    return Promise.all([previous, own, next]).then(([a, b, c]) => this.apply(px, mergeDets(mergeDets(b, a), c)));
  }

  // No next frame is coming for now (end of video, or end of a decoded chunk).
  finish() {
    if (!this.pending) return;
    // A skipped frame gets its own detection; a frame waiting for its neighbour does without.
    this.pending.resolve(this.pending.kind === 'skipped' ? this.detect(this.pending.px) : []);
    this.pending = null;
  }
}

function iou(a, b) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

// Union of two sets of boxes: the same face found in both becomes the box enclosing
// both; faces found in only one of them are kept as they are.
function mergeDets(a, b) {
  const out = [];
  const used = new Set();
  for (const d of a) {
    let best = -1, bestIou = 0.2;
    b.forEach((e, j) => {
      const v = used.has(j) ? 0 : iou(d, e);
      if (v > bestIou) { bestIou = v; best = j; }
    });
    if (best < 0) { out.push(d); continue; }
    used.add(best);
    const e = b[best];
    out.push([Math.min(d[0], e[0]), Math.min(d[1], e[1]), Math.max(d[2], e[2]), Math.max(d[3], e[3]), Math.max(d[4], e[4])]);
  }
  b.forEach((e, j) => { if (!used.has(j)) out.push(e); });
  return out;
}
