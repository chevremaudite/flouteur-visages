// One CenterFace instance per worker. On the CPU, several of these run in parallel
// (one WASM thread each); with WebGPU, a couple of them keep the GPU busy.
import { CenterFace } from './deface.js';

let centerface;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const gpu = data.backend === 'webgpu';
      const ort = await import(gpu ? './vendor/ort/ort.webgpu.min.mjs' : './vendor/ort/ort.wasm.min.mjs');
      ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';
      centerface = await CenterFace.create(ort, data.model, gpu ? ['webgpu'] : ['wasm']);
      // Warm up (WebGPU compiles its shaders on the first run) and make sure the backend really works.
      await centerface.detect(new Uint8ClampedArray(64 * 64 * 4), 64, 64, 64, 64, 0.5);
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'detect') {
      const dets = await centerface.detect(data.pixels, data.wNew, data.hNew, data.W, data.H, data.threshold);
      self.postMessage({ type: 'dets', id: data.id, dets }, [data.pixels.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message ?? err) });
  }
};
