'use strict';

/**
 * Worker orchestration.
 *
 * Both workers are strictly single-flight: if a stage is still busy when the
 * next frame arrives, that frame is dropped rather than queued. Queueing would
 * let the analysis fall behind the operator's rotation, and stale geometry is
 * worse than fewer samples.
 */
export class Pipeline {
  constructor(log) {
    this.log = log || (() => {});
    this.segWorker = null;
    this.visWorker = null;
    this.segBusy = false;
    this.visBusy = false;
    this.segId = 0;
    this.visId = 0;
    this.segDropped = 0;
    this.visDropped = 0;
    this.segTimeMs = 0;
    this.visTimeMs = 0;
    this._segResolvers = new Map();
    this._visResolvers = new Map();
  }

  start() {
    this.segWorker = new Worker('./workers/segment.worker.js');
    this.visWorker = new Worker('./workers/vision.worker.js');
    this.segWorker.onmessage = e => {
      const r = this._segResolvers.get(e.data.id);
      this._segResolvers.delete(e.data.id);
      this.segBusy = false;
      if (r) r(e.data);
    };
    this.visWorker.onmessage = e => {
      const r = this._visResolvers.get(e.data.id);
      this._visResolvers.delete(e.data.id);
      this.visBusy = false;
      if (r) r(e.data);
    };
    this.segWorker.onerror = e => { this.segBusy = false; this.log('error', 'Segmentation worker failed:', e.message); };
    this.visWorker.onerror = e => { this.visBusy = false; this.log('error', 'Registration worker failed:', e.message); };
  }

  stop() {
    if (this.segWorker) this.segWorker.terminate();
    if (this.visWorker) this.visWorker.terminate();
    this.segWorker = this.visWorker = null;
  }

  /** Returns null immediately if the segmentation stage is still busy. */
  segment(imageData) {
    if (!this.segWorker || this.segBusy) { this.segDropped++; return null; }
    this.segBusy = true;
    const id = ++this.segId;
    const t0 = performance.now();
    const buffer = imageData.data.buffer.slice(0);
    return new Promise(res => {
      this._segResolvers.set(id, d => { this.segTimeMs = performance.now() - t0; res(d); });
      this.segWorker.postMessage({ id, width: imageData.width, height: imageData.height, buffer }, [buffer]);
    });
  }

  /** hintX/hintY are the inertially predicted pixel shift. They only narrow the
   *  coarse search; a wrong hint of tens of pixels is recovered from, but an
   *  inverted-sign hint is not, so the caller must not send one until the sign
   *  convention has been resolved from data. */
  register(luma, w, h, hintX, hintY) {
    if (!this.visWorker || this.visBusy) { this.visDropped++; return null; }
    this.visBusy = true;
    const id = ++this.visId;
    const t0 = performance.now();
    const buffer = luma.buffer;
    return new Promise(res => {
      this._visResolvers.set(id, d => { this.visTimeMs = performance.now() - t0; res(d); });
      this.visWorker.postMessage({ id, w, h, buffer, hintX, hintY }, [buffer]);
    });
  }

  resetRegistration() {
    if (this.visWorker) this.visWorker.postMessage({ cmd: 'reset' });
  }

  /** Store the first frame of a pass so the loop can be closed against it. */
  anchor(luma, w, h) {
    if (!this.visWorker) return;
    const buffer = luma.buffer;
    this.visWorker.postMessage({ cmd: 'anchor', w, h, buffer }, [buffer]);
  }

  closeLoop(luma, w, h) {
    if (!this.visWorker) return Promise.resolve(null);
    const id = ++this.visId;
    const buffer = luma.buffer;
    return new Promise(res => {
      this._visResolvers.set(id, d => res(d.result));
      this.visWorker.postMessage({ cmd: 'closeLoop', id, w, h, buffer, hintX: 0, hintY: 0 }, [buffer]);
    });
  }

  stats() {
    return {
      segTimeMs: this.segTimeMs, visTimeMs: this.visTimeMs,
      segDropped: this.segDropped, visDropped: this.visDropped
    };
  }
}
