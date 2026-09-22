'use strict';

/**
 * Where a panorama build spent its time, and what it cost the device.
 *
 * WHY THIS EXISTS. "It takes ten to fifteen times longer on Android" is a real
 * complaint and was, for weeks, an unanswerable one: the archive recorded a
 * single elapsed figure and nothing else, so every explanation was a guess. Two
 * of mine were wrong — the photographs are the same 640x480 on both devices,
 * and a controlled test showed feature counts are comparable and that raising
 * the SIFT contrast threshold moves matched inliers by under 2%.
 *
 * A coarse stage timer added on 2026-09-02 answered it in one run, and the
 * answer was not where anyone had been looking:
 *
 *     Choosing seams                          976.9 s   42%
 *     Panorama painted                        895.4 s   39%
 *     Matching overlapping photos             236.9 s   10%
 *     Discarding bad matches, solving again    66.8 s    3%
 *     Finding features                         62.8 s    3%
 *     Solving every camera angle               54.0 s    2%
 *
 * Eighty-one per cent of a 2307-second build is RENDERING. The weight table in
 * `js/build-progress.js` — the only prior estimate in the codebase — assumes
 * features and matching are 70% of the work and rendering is 6%.
 *
 * So this module exists to make that measurement routine rather than lucky, and
 * to carry it into the debug archive where it can be compared across devices.
 * It records three things:
 *
 *   STAGES, by wall clock, attributed to whatever the Python side last said it
 *   was doing. Coarse and honest about being coarse: the labels come from the
 *   solver's own progress messages, so a label that reads as a completion
 *   notice ("Panorama painted") collects the time AFTER that message until the
 *   next one arrives. Read them as intervals between announcements, not as
 *   named functions.
 *
 *   RESOURCES, sampled while it runs. Peak heap is the number that decides
 *   whether a device is thrashing, and it is the one thing a stage timer alone
 *   cannot tell you: a build that is slow because it is swapping looks exactly
 *   like a build that is slow because the arithmetic is hard.
 *
 *   THE ENVIRONMENT, once. Core count, memory class, and — the one that decides
 *   whether "can we parallelise this" even has a yes available —
 *   `crossOriginIsolated`, without which WebAssembly threads cannot start at
 *   all, whatever the hardware.
 */

/** How often to sample memory while a build runs, in milliseconds. Cheap, but
 *  not free: `performance.memory` is a synchronous read and this runs beside a
 *  worker that wants the main thread. Two seconds is plenty to catch a peak
 *  over a build measured in tens of minutes. */
const SAMPLE_INTERVAL_MS = 2000;

/** Never let a pathological build grow the sample array without bound. At two
 *  seconds apiece this is a little over four hours. */
const MAX_SAMPLES = 7500;

/**
 * What this device is, for the purposes of explaining a build time.
 *
 * Every field is optional somewhere: `deviceMemory` and `performance.memory`
 * are Chromium-only, `crossOriginIsolated` is universal but false unless the
 * page is served with the COOP/COEP header pair. Absent is recorded as null
 * rather than guessed, because a guessed core count is worse than none when the
 * whole point is comparing two devices.
 */
export function describeEnvironment(nav = typeof navigator === 'undefined' ? null : navigator,
  win = typeof window === 'undefined' ? null : window) {
  const perf = win?.performance || (typeof performance === 'undefined' ? null : performance);
  return {
    userAgent: nav?.userAgent || null,
    hardwareConcurrency: Number.isFinite(nav?.hardwareConcurrency)
      ? nav.hardwareConcurrency : null,
    /** GiB, rounded down by the platform to a privacy-preserving bucket. */
    deviceMemoryGb: Number.isFinite(nav?.deviceMemory) ? nav.deviceMemory : null,
    /**
     * Whether WebAssembly threads are even possible on this page.
     *
     * `SharedArrayBuffer` — and therefore every threaded WASM build, OpenCV's
     * included — is gated behind cross-origin isolation, which needs the server
     * to send Cross-Origin-Opener-Policy: same-origin and
     * Cross-Origin-Embedder-Policy: require-corp. A static host that does not
     * send them makes the whole question moot, so the answer belongs in the
     * archive beside the timings rather than in somebody's memory.
     */
    crossOriginIsolated: typeof win?.crossOriginIsolated === 'boolean'
      ? win.crossOriginIsolated
      : (typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : null),
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    wasmThreadsPossible: (typeof SharedArrayBuffer !== 'undefined')
      && ((typeof win?.crossOriginIsolated === 'boolean' ? win.crossOriginIsolated
        : (typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false)) === true),
    jsHeapLimitMb: Number.isFinite(perf?.memory?.jsHeapSizeLimit)
      ? Math.round(perf.memory.jsHeapSizeLimit / 1048576) : null,
    screen: typeof screen === 'undefined' ? null : `${screen.width}x${screen.height}`,
    devicePixelRatio: win?.devicePixelRatio ?? null
  };
}

export class BuildProfile {
  constructor({ now = () => performance.now(), env = null } = {}) {
    this.nowFn = now;
    this.environment = env || describeEnvironment();
    this.reset();
  }

  reset() {
    this.startedAt = this.nowFn();
    this.stage = null;
    this.stageStartedAt = this.startedAt;
    /** stage label -> milliseconds spent with that label showing. */
    this.spent = {};
    /** The order labels first appeared, which is the only record of sequence. */
    this.order = [];
    this.samples = [];
    this.frames = 0;
    this.totalMs = 0;
    this._timer = null;
  }

  /** Begin sampling memory. Safe to call when nothing supports it: the sampler
   *  simply records nulls, and the stage timings stand on their own. */
  start(frames = 0) {
    this.reset();
    this.frames = frames;
    this.sample();
    if (typeof setInterval === 'function') {
      this._timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    }
    return this;
  }

  /** One memory reading, tagged with the stage it happened in. */
  sample() {
    if (this.samples.length >= MAX_SAMPLES) return;
    const mem = (typeof performance !== 'undefined' && performance.memory) || null;
    this.samples.push({
      atSec: Number(((this.nowFn() - this.startedAt) / 1000).toFixed(1)),
      stage: this.stage,
      usedHeapMb: mem && Number.isFinite(mem.usedJSHeapSize)
        ? Math.round(mem.usedJSHeapSize / 1048576) : null,
      totalHeapMb: mem && Number.isFinite(mem.totalJSHeapSize)
        ? Math.round(mem.totalJSHeapSize / 1048576) : null
    });
  }

  /**
   * The solver says what it is doing now.
   *
   * Time is attributed to the label that was showing when it elapsed, so the
   * caller only has to pass every progress message straight through. Repeated
   * identical labels are one stage, not many.
   */
  enter(label) {
    const name = String(label || '').trim();
    if (!name || name === this.stage) return;
    const at = this.nowFn();
    if (this.stage) this.spent[this.stage] = (this.spent[this.stage] || 0) + (at - this.stageStartedAt);
    else if (this.order.length === 0) this.order.push('(startup)');
    if (!this.order.includes(name)) this.order.push(name);
    this.stage = name;
    this.stageStartedAt = at;
  }

  /** Close the last stage and stop sampling. Idempotent. */
  finish() {
    const at = this.nowFn();
    if (this.stage) {
      this.spent[this.stage] = (this.spent[this.stage] || 0) + (at - this.stageStartedAt);
      this.stage = null;
    }
    this.totalMs = at - this.startedAt;
    if (this._timer !== null && typeof clearInterval === 'function') {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.sample();
    return this;
  }

  /** Stages worst-first, which is the order anybody reads them in. */
  stagesBySlowest() {
    return Object.entries(this.spent)
      .map(([stage, ms]) => ({
        stage,
        seconds: Number((ms / 1000).toFixed(1)),
        percent: this.totalMs > 0 ? Number((100 * ms / this.totalMs).toFixed(1)) : null
      }))
      .sort((a, b) => b.seconds - a.seconds);
  }

  /** Everything the archive should carry about this build. */
  snapshot() {
    const heaps = this.samples.map(s => s.usedHeapMb).filter(Number.isFinite);
    const stages = this.stagesBySlowest();
    return {
      totalSec: Number((this.totalMs / 1000).toFixed(1)),
      frames: this.frames,
      secPerFrame: this.frames > 0
        ? Number((this.totalMs / 1000 / this.frames).toFixed(2)) : null,
      /* The headline: which stage dominated, and by how much. A reader should
       * not have to sum a table to find out where the time went. */
      slowestStage: stages[0]?.stage ?? null,
      slowestStagePercent: stages[0]?.percent ?? null,
      stages,
      stageOrder: this.order,
      memory: {
        peakHeapMb: heaps.length ? Math.max(...heaps) : null,
        startHeapMb: heaps.length ? heaps[0] : null,
        endHeapMb: heaps.length ? heaps[heaps.length - 1] : null,
        /** Null on Safari and every non-Chromium browser: `performance.memory`
         *  is not standard. Absence is not zero and is recorded as absence. */
        available: heaps.length > 0,
        samples: this.samples
      },
      environment: this.environment
    };
  }
}
