'use strict';
/* Client for the in-app Python stitcher.
 *
 * Owns one Pyodide worker for the life of the page, because the runtime costs
 * ~25 MB and twenty seconds to start and there is no reason to pay that twice.
 * Everything here is plumbing: start the worker, feed it an archive, turn the
 * Python's stdout back into a progress bar, hand back the finished panorama.
 *
 * THE STDOUT IS THE PROGRESS BAR. stitch_lab.py is a command-line program and
 * prints its stages as it passes them. Rather than instrument the Python with a
 * callback that only the browser would ever use — and that would then be the one
 * code path the desktop runs never exercises — the phases are recovered here by
 * reading what it already says. A line that stops matching is a cosmetic fault
 * in a progress bar, not a wrong panorama, which is the right way round.
 */

import { VERSION } from './version.js';

/* Fraction of the wall clock each stage is worth on a typical capture, measured
 * on the 200-frame iPad set: matching dominates, the solve is second, rendering
 * is cheap. These only steer a bar, so being roughly right beats being exact. */
const PHASES = [
  { re: /^Loading /, at: 0.36, label: 'Reading the capture' },
  { re: /^Detecting features/, at: 0.40, label: 'Finding features' },
  { re: /^\s+features: /, at: 0.46, label: 'Features found' },
  { re: /^Matching/, at: 0.48, label: 'Matching overlapping photos' },
  { re: /^\s+pairs: /, at: 0.68, label: 'Overlaps matched' },
  { re: /^\s+verified: /, at: 0.72, label: 'Overlaps verified' },
  { re: /^Solving rotations/, at: 0.75, label: 'Solving every camera angle' },
  { re: /^Pruning and re-solving/, at: 0.84, label: 'Discarding bad matches, solving again' },
  { re: /^\s+perspective correction/, at: 0.88, label: 'Fitting the residual correction' },
  { re: /^Rendering/, at: 0.90, label: 'Painting the panorama' },
  { re: /^\s+finding seams/, at: 0.93, label: 'Choosing seams' },
  { re: /^\s+painted /, at: 0.98, label: 'Panorama painted' }
];

export class PyodideStitcher {
  constructor({ onStatus = null, onLog = null } = {}) {
    this.onStatus = onStatus;
    this.onLog = onLog;
    this.worker = null;
    this.pending = null;
    this.ready = false;
    this.runtimeVersion = null;
    this.logLines = [];
  }

  /** True once the runtime is resident and a rebuild will start immediately. */
  get warm() { return this.ready; }

  _spawn() {
    if (this.worker) return this.worker;
    this.worker = new Worker(`./workers/pyodide-stitch.worker.js?v=${VERSION}`, { type: 'module' });
    this.worker.addEventListener('message', ({ data }) => this._receive(data));
    this.worker.addEventListener('error', e => {
      this._fail(new Error(e.message || 'the stitch worker failed to start'));
    });
    return this.worker;
  }

  _receive(data) {
    if (data.type === 'status') {
      this.onStatus?.({ text: data.text, fraction: data.progress ?? null });
    } else if (data.type === 'log') {
      this.logLines.push(data.line);
      this.onLog?.(data.line, !!data.stderr);
      const hit = PHASES.find(p => p.re.test(data.line));
      if (hit) this.onStatus?.({ text: hit.label, fraction: hit.at, detail: data.line.trim() });
    } else if (data.type === 'ready') {
      this.ready = true;
      this.runtimeVersion = data.version;
      this.pending?.resolveInit?.();
    } else if (data.type === 'result') {
      const p = this.pending; this.pending = null;
      p?.resolve({
        report: data.report,
        panorama: data.panorama ? new Blob([data.panorama], { type: 'image/png' }) : null,
        control: data.control ? new Blob([data.control], { type: 'image/png' }) : null,
        solution: data.solution || null,
        log: this.logLines.slice()
      });
    } else if (data.type === 'error') {
      this._fail(Object.assign(new Error(data.message), { pythonStack: data.stack }));
    }
  }

  _fail(error) {
    const p = this.pending; this.pending = null;
    if (p) p.reject(error);
    else this.onLog?.(`stitcher error: ${error.message}`, true);
  }

  /**
   * Start downloading the runtime without running anything.
   *
   * Worth calling as soon as a survey has frames worth stitching: the download
   * then overlaps with the operator still capturing, and Build feels instant
   * instead of appearing to hang for twenty seconds on its first press.
   */
  preload() {
    this._spawn().postMessage({ type: 'init' });
  }

  /**
   * Rebuild a panorama from a capture-debug archive.
   *
   * `buffer` is the ZIP as an ArrayBuffer and is TRANSFERRED, so the caller must
   * not touch it afterwards. Resolves with the report, both PNGs and the raw
   * solved rotations.
   */
  run(buffer, options = {}) {
    if (this.pending) return Promise.reject(new Error('a rebuild is already running'));
    this.logLines = [];
    const worker = this._spawn();
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      worker.postMessage({ type: 'run', buffer, options }, [buffer]);
    });
  }

  /** Drop the runtime. The next run pays the startup cost again. */
  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.pending = null;
  }
}

/**
 * Is this page able to run the Python stitcher at all?
 *
 * Pyodide needs a real origin for the worker and for its own wasm fetches, so a
 * page opened with file:// cannot run it however good the device is. Saying so
 * up front is better than a stack trace from inside a WebAssembly loader.
 */
export function stitcherAvailability() {
  if (typeof Worker === 'undefined') {
    return { ok: false, reason: 'this browser has no Web Workers' };
  }
  if (location.protocol === 'file:') {
    return {
      ok: false,
      reason: 'the page was opened from a file, not served. Run a local server '
        + '(python -m http.server) or open the deployed site.'
    };
  }
  if (typeof WebAssembly === 'undefined') {
    return { ok: false, reason: 'this browser has no WebAssembly' };
  }
  return { ok: true, reason: null };
}
