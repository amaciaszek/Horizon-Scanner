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

/*
 * WHAT EACH STAGE IS WORTH, MEASURED RATHER THAN GUESSED.
 *
 * These were hand-written on a 200-frame set with the note "matching dominates,
 * the solve is second, rendering is cheap", and every part of that was wrong.
 * The first build to time its own stages — 380 photographs, 2307 seconds —
 * spent 42% choosing seams and 39% painting. Rendering is four fifths of a
 * build, and the old table gave all of it the span 0.90 to 0.98.
 *
 * So the bar reached 90% and then did not move for twenty-five minutes, which
 * is indistinguishable from a hang. That is the whole reason an operator asks
 * whether the app is stuck.
 *
 * `share` is the fraction of the build this stage occupies. `key` ties a stage
 * to the fine-grained progress the Python now emits, so the bar advances WITHIN
 * a stage rather than only when one ends.
 */
const PHASES = [
  { re: /^Loading /, label: 'Reading the capture', share: 0.02, key: null },
  { re: /^Detecting features/, label: 'Finding features', share: 0.03, key: 'features' },
  { re: /^Matching/, label: 'Matching overlapping photos', share: 0.11, key: 'matching' },
  { re: /^\s+verified: /, label: 'Overlaps verified', share: 0.01, key: null },
  { re: /^Solving rotations/, label: 'Solving every camera angle', share: 0.03, key: null },
  { re: /^Pruning and re-solving/, label: 'Discarding bad matches, solving again', share: 0.03, key: null },
  { re: /^\s+perspective correction/, label: 'Fitting the residual correction', share: 0.01, key: null },
  { re: /^Rendering/, label: 'Preparing to paint', share: 0.01, key: null },
  { re: /^\s+finding seams/, label: 'Choosing seams', share: 0.36, key: 'seams' },
  { re: /^\s+painted /, label: 'Painting the panorama', share: 0.39, key: 'painting' }
];

/** Where each stage starts on the overall bar, from the shares above. */
const PHASE_START = (() => {
  let at = 0;
  return PHASES.map(p => { const start = at; at += p.share; return start; });
})();

/** Lines the Python emits for sub-stage progress: `@@PROGRESS|stage|done|total`. */
const PROGRESS_RE = /^@@PROGRESS\|([a-z]+)\|(\d+)\|(\d+)$/;

/**
 * A remaining-time estimate for one stage, from the rate it is actually
 * achieving.
 *
 * Measured, never tabulated: the same rule `js/build-progress.js` was written
 * with and for the same reason. A phone and a tablet differ by four times on
 * this work, so any constant would be wrong on one of them.
 *
 * Smoothed, because an estimate that jitters between four and eleven minutes
 * reads as broken even when its average is right.
 */
class StageEta {
  constructor() { this.reset(); }

  reset() {
    this.startedAt = null;
    this.smoothedSec = null;
    this.lastDone = 0;
  }

  /** Returns seconds remaining in this stage, or null while it is too early. */
  update(done, total, nowMs) {
    if (this.startedAt === null || done < this.lastDone) {
      this.startedAt = nowMs;
      this.smoothedSec = null;
    }
    this.lastDone = done;
    const elapsed = (nowMs - this.startedAt) / 1000;
    // Four units and a second of wall clock before quoting a rate: anything
    // less is measuring the first iteration's warm-up.
    if (done < 4 || elapsed < 1 || total <= 0) return this.smoothedSec;
    const remaining = elapsed / done * Math.max(0, total - done);
    this.smoothedSec = this.smoothedSec === null
      ? remaining : this.smoothedSec * 0.7 + remaining * 0.3;
    return this.smoothedSec;
  }
}

export class PyodideStitcher {
  constructor({ onStatus = null, onLog = null } = {}) {
    this.onStatus = onStatus;
    this.onLog = onLog;
    this.worker = null;
    this.pending = null;
    this.ready = false;
    this.runtimeVersion = null;
    this.logLines = [];
    this.phase = -1;
    this.eta = new StageEta();
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
      const step = PROGRESS_RE.exec(data.line);
      if (step) { this._step(step[1], Number(step[2]), Number(step[3])); return; }
      this.logLines.push(data.line);
      this.onLog?.(data.line, !!data.stderr);
      const index = PHASES.findIndex(p => p.re.test(data.line));
      if (index >= 0) this._enterPhase(index, data.line.trim());
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

  /** A named stage began. */
  _enterPhase(index, detail) {
    if (index === this.phase) return;
    this.phase = index;
    this.eta.reset();
    this._emit(0, detail);
  }

  /** One unit of work inside the current stage finished. */
  _step(key, done, total) {
    const index = PHASES.findIndex(p => p.key === key);
    if (index < 0) return;
    if (index !== this.phase) { this.phase = index; this.eta.reset(); }
    const within = total > 0 ? Math.min(1, done / total) : 0;
    this._emit(within, `${done} of ${total}`, done, total);
  }

  /**
   * Publish where the build is.
   *
   * The fraction is the stage's own progress placed inside the stage's measured
   * share of the whole, so the bar moves continuously rather than in ten jumps.
   * It is deliberately NOT clamped to monotonic: a stage that reruns — the
   * solve does, after pruning — should be honest about going back rather than
   * freezing at a high-water mark.
   */
  _emit(within, detail, done = null, total = null) {
    const p = PHASES[this.phase];
    if (!p) return;
    const fraction = PHASE_START[this.phase] + p.share * within;
    const stageRemainingSec = done !== null
      ? this.eta.update(done, total, performance.now()) : null;
    /*
     * The whole build's estimate, from the rate THIS stage is achieving.
     *
     * The stage covers `share` of the bar and has `1 - within` of its own span
     * left, so its observed seconds buy a known number of bar-units. Everything
     * not yet started is costed at that same rate, scaled by the measured
     * shares — which is the only honest projection across work that has not
     * begun: this device's own throughput, in proportions measured over real
     * builds rather than assumed.
     */
    let remainingSec = null;
    if (Number.isFinite(stageRemainingSec) && within < 1) {
      const barUnitsLeftInStage = p.share * (1 - within);
      if (barUnitsLeftInStage > 1e-9) {
        const secPerBarUnit = stageRemainingSec / barUnitsLeftInStage;
        remainingSec = secPerBarUnit * Math.max(0, 1 - fraction);
      }
    }
    this.onStatus?.({
      text: p.label,
      fraction,
      detail,
      stage: p.key || p.label,
      stageFraction: within,
      stageRemainingSec,
      remainingSec,
      done,
      total
    });
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
