// JavaScript port of deface 1.5.0 (https://github.com/ORB-HD/deface):
// CenterFace post-processing from deface/centerface.py and the anonymization
// filters from deface/deface.py. The ONNX model is deface's own centerface.onnx,
// with dynamic input shapes (CenterFace.dynamicize_shapes), see build.sh.

export class CenterFace {
  constructor(ort, session) {
    this.ort = ort;
    this.session = session;
    this.chw = null;
  }

  // model: URL or ONNX bytes.
  static async create(ort, model, executionProviders = ['wasm']) {
    let bytes = model;
    if (typeof model === 'string') {
      const res = await fetch(model);
      if (!res.ok) throw new Error(`Impossible de charger le modèle (${res.status})`);
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders,
      graphOptimizationLevel: 'all',
    });
    return new CenterFace(ort, session);
  }

  // CenterFace.shape_transform: network input dims must be multiples of 32.
  static shapeTransform(inW, inH) {
    return { wNew: Math.ceil(inW / 32) * 32, hNew: Math.ceil(inH / 32) * 32 };
  }

  // rgba: pixels already resized to wNew x hNew. Returns [[x1, y1, x2, y2, score], ...]
  // in original frame coordinates.
  async detect(rgba, wNew, hNew, origW, origH, threshold) {
    const hw = wNew * hNew;
    if (!this.chw || this.chw.length !== 3 * hw) this.chw = new Float32Array(3 * hw);
    const chw = this.chw;
    for (let i = 0, p = 0; i < hw; i++, p += 4) {
      chw[i] = rgba[p];
      chw[i + hw] = rgba[p + 1];
      chw[i + 2 * hw] = rgba[p + 2];
    }
    const input = new this.ort.Tensor('float32', chw, [1, 3, hNew, wNew]);
    const out = await this.session.run({ 'input.1': input }, ['537', '538', '539']);
    const heatmap = out['537'], scale = out['538'], offset = out['539'];
    const dets = decode(heatmap.data, scale.data, offset.data, heatmap.dims[2], heatmap.dims[3], hNew, wNew, threshold);
    input.dispose?.();
    for (const t of Object.values(out)) t.dispose?.();
    const scaleW = wNew / origW, scaleH = hNew / origH;
    for (const d of dets) {
      d[0] /= scaleW; d[2] /= scaleW;
      d[1] /= scaleH; d[3] /= scaleH;
    }
    return dets;
  }
}

// CenterFace.decode (landmarks are discarded by deface, so they're skipped here).
function decode(heatmap, scale, offset, h, w, sizeH, sizeW, threshold) {
  const plane = h * w;
  const boxes = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const s = heatmap[i];
      if (!(s > threshold)) continue;
      const s0 = Math.exp(scale[i]) * 4, s1 = Math.exp(scale[plane + i]) * 4;
      const o0 = offset[i], o1 = offset[plane + i];
      let x1 = Math.max(0, (x + o1 + 0.5) * 4 - s1 / 2);
      let y1 = Math.max(0, (y + o0 + 0.5) * 4 - s0 / 2);
      x1 = Math.min(x1, sizeW);
      y1 = Math.min(y1, sizeH);
      boxes.push([x1, y1, Math.min(x1 + s1, sizeW), Math.min(y1 + s0, sizeH), s]);
    }
  }
  return nms(boxes, 0.3);
}

function nms(boxes, thresh) {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b][4] - boxes[a][4]);
  const area = boxes.map(b => (b[2] - b[0]) * (b[3] - b[1]));
  const suppressed = new Uint8Array(boxes.length);
  for (let a = 0; a < order.length; a++) {
    const i = order[a];
    if (suppressed[i]) continue;
    const [ix1, iy1, ix2, iy2] = boxes[i];
    for (let b = a + 1; b < order.length; b++) {
      const j = order[b];
      if (suppressed[j]) continue;
      const w = Math.max(0, Math.min(ix2, boxes[j][2]) - Math.max(ix1, boxes[j][0]));
      const h = Math.max(0, Math.min(iy2, boxes[j][3]) - Math.max(iy1, boxes[j][1]));
      const inter = w * h;
      if (inter / (area[i] + area[j] - inter) >= thresh) suppressed[j] = 1;
    }
  }
  return boxes.filter((_, i) => !suppressed[i]);
}

// numpy.round rounds half to even.
function roundHalfEven(v) {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// deface.scale_bb
function scaleBB(x1, y1, x2, y2, maskScale) {
  const s = maskScale - 1.0;
  const h = y2 - y1, w = x2 - x1;
  return [x1 - w * s, y1 - h * s, x2 + w * s, y2 + h * s].map(roundHalfEven);
}

// deface.anonymize_frame, operating in place on an RGBA frame buffer.
// opts: { replacewith: 'blur' | 'mosaic' | 'solid', ellipse, maskScale, mosaicSize }
export function anonymizeFrame(dets, px, W, H, opts) {
  for (const det of dets) {
    let [x1, y1, x2, y2] = scaleBB(Math.trunc(det[0]), Math.trunc(det[1]), Math.trunc(det[2]), Math.trunc(det[3]), opts.maskScale);
    y1 = Math.max(0, y1); y2 = Math.min(H - 1, y2);
    x1 = Math.max(0, x1); x2 = Math.min(W - 1, x2);
    if (x2 <= x1 || y2 <= y1) continue;
    if (opts.replacewith === 'blur') blurBox(px, W, x1, y1, x2, y2, opts.ellipse);
    else if (opts.replacewith === 'mosaic') mosaicBox(px, W, x1, y1, x2, y2, opts.mosaicSize);
    else if (opts.replacewith === 'solid') fillRect(px, W, x1, y1, x2, y2, 0, 0, 0);
  }
}

// cv2.BORDER_REFLECT_101
function reflect101(p, n) {
  if (n === 1) return 0;
  while (p < 0 || p >= n) p = p < 0 ? -p : 2 * n - 2 - p;
  return p;
}

// Normalized box filter over a single axis of the ROI, like cv2.blur.
function boxPass(src, dst, len, count, stride, step, k) {
  const anchor = k >> 1;
  const idx = new Int32Array(len + k);
  for (let j = 0; j < len + k; j++) idx[j] = reflect101(j - anchor, len);
  for (let line = 0; line < count; line++) {
    const base = line * stride;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let j = 0; j < k; j++) sum += src[(base + idx[j] * step) * 3 + c];
      for (let i = 0; i < len; i++) {
        dst[(base + i * step) * 3 + c] = sum;
        sum += src[(base + idx[i + k] * step) * 3 + c] - src[(base + idx[i] * step) * 3 + c];
      }
    }
  }
}

// deface.draw_det with replacewith='blur': box blur with kernel (w/2, h/2), pasted
// through an ellipse mask (skimage.draw.ellipse) unless boxes are requested.
function blurBox(px, W, x1, y1, x2, y2, ellipse) {
  const w = x2 - x1, h = y2 - y1;
  const kx = Math.max(1, w >> 1), ky = Math.max(1, h >> 1);
  const roi = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = ((y1 + y) * W + x1 + x) * 4, q = (y * w + x) * 3;
      roi[q] = px[p]; roi[q + 1] = px[p + 1]; roi[q + 2] = px[p + 2];
    }
  }
  const tmp = new Float32Array(roi.length);
  boxPass(roi, tmp, w, h, w, 1, kx);   // horizontal
  boxPass(tmp, roi, h, w, 1, w, ky);   // vertical
  const norm = 1 / (kx * ky);
  const cy = h >> 1, cx = w >> 1, ry = h >> 1, rx = w >> 1;
  if (ellipse && (rx === 0 || ry === 0)) return;
  for (let y = 0; y < h; y++) {
    const dy = ellipse ? (y - cy) / ry : 0;
    for (let x = 0; x < w; x++) {
      if (ellipse) {
        const dx = (x - cx) / rx;
        if (dx * dx + dy * dy >= 1) continue;
      }
      const p = ((y1 + y) * W + x1 + x) * 4, q = (y * w + x) * 3;
      px[p] = Math.round(roi[q] * norm);
      px[p + 1] = Math.round(roi[q + 1] * norm);
      px[p + 2] = Math.round(roi[q + 2] * norm);
    }
  }
}

// cv2.rectangle(..., thickness=-1): both corners inclusive.
function fillRect(px, W, x1, y1, x2, y2, r, g, b) {
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const p = (y * W + x) * 4;
      px[p] = r; px[p + 1] = g; px[p + 2] = b;
    }
  }
}

// deface.draw_det with replacewith='mosaic'.
function mosaicBox(px, W, x1, y1, x2, y2, size) {
  for (let y = y1; y < y2; y += size) {
    for (let x = x1; x < x2; x += size) {
      const p = (y * W + x) * 4;
      fillRect(px, W, x, y, Math.min(x2, x + size - 1), Math.min(y2, y + size - 1), px[p], px[p + 1], px[p + 2]);
    }
  }
}
