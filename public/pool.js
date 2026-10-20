// A small pool of detector.js workers, one frame in flight per worker.
export class DetectorPool {
  static async create(url, size, model, backend) {
    const pool = new DetectorPool();
    pool.backend = backend;
    pool.idle = [];
    pool.queue = [];
    pool.waiters = [];
    pool.workers = [];
    try {
      await Promise.all(Array.from({ length: size }, () => new Promise((resolve, reject) => {
        const w = new Worker(url, { type: 'module' });
        pool.workers.push(w);
        w.onmessage = ({ data }) => data.type === 'ready' ? resolve(w) : reject(new Error(data.message));
        w.onerror = (e) => reject(new Error(e.message || 'Impossible de démarrer le détecteur'));
        w.postMessage({ type: 'init', model: model.slice(), backend });
      })));
    } catch (err) {
      pool.terminate();
      throw err;
    }
    pool.idle.push(...pool.workers);
    return pool;
  }

  get size() { return this.workers.length; }
  get busy() { return this.idle.length === 0; }

  // For backpressure: resolves once a worker is free.
  whenIdle() {
    return this.busy ? new Promise(r => this.waiters.push(r)) : Promise.resolve();
  }

  // job: { pixels, wNew, hNew, W, H, threshold }; pixels are transferred to the worker.
  detect(job) {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.#dispatch();
    });
  }

  #dispatch() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const { job, resolve, reject } = this.queue.shift();
      w.onmessage = ({ data }) => {
        this.idle.push(w);
        data.type === 'dets' ? resolve(data.dets) : reject(new Error(data.message));
        this.#dispatch();
        if (!this.busy) this.waiters.shift()?.();
      };
      w.onerror = (e) => reject(new Error(e.message || 'Erreur du détecteur'));
      w.postMessage({ type: 'detect', ...job }, [job.pixels.buffer]);
    }
  }

  terminate() {
    this.workers.forEach(w => w.terminate());
  }
}
