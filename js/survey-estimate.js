'use strict';

/**
 * How long is this going to take?
 *
 * Asked at the start, not at the end. The 2026-08-25 back-yard survey ran
 * 2m37s of capture followed by 16m20s of building, and the operator found that
 * out by watching it happen. Their note afterwards was the whole specification
 * for this file: "a time estimation would be helpful — it's going to take 15
 * minutes, perfect — let the user know so they can change screen dimming and
 * appropriate settings."
 *
 * Two rules, both inherited from `js/build-progress.js`, which estimates the
 * build while it runs and is right for the same reasons:
 *
 *   MEASURED, NOT ASSUMED. Every figure here that can be measured on this
 *   device is measured on this device and remembered. A table of how long a
 *   phone "should" take is wrong on the first phone that is not the one it was
 *   written on, and a confidently wrong number teaches the operator to ignore
 *   every number the app shows them.
 *
 *   COARSE, AND HONEST ABOUT ITS RANGE. This is a decision aid — do I have time
 *   for this now, do I need to stop the screen dimming — and it is quoted to
 *   the nearest minute with a stated spread. A single precise-looking figure
 *   would be false precision: the capture time depends on how fast a person
 *   turns, and the build time on what else the phone is doing.
 *
 * The seed figures below are the only prior knowledge, they are labelled with
 * where they came from, and every one of them is replaced by a real measurement
 * from this device the first time this device does the work.
 */

/**
 * Seconds of building per photograph, on the 2026-08-25 reference capture:
 * 979.9 s over 115 frames in Pyodide on a Pixel, SIFT at 1500 features with
 * guided matching. This is a seed and nothing more — the first completed build
 * on this device replaces it.
 *
 * It is deliberately the slow measurement of the two available. The 2026-08-21
 * capture built 103 frames in about two minutes, and the difference between
 * those two runs is not understood; quoting the optimistic one and then taking
 * a quarter of an hour is exactly the failure this file exists to prevent.
 */
const SEED_BUILD_SEC_PER_FRAME = 8.5;

/**
 * Seconds of capture per photograph, from the same capture: 156.8 s of survey
 * over 115 photographs. This is dominated by how fast the operator moves, not
 * by the device, so it is the least transferable figure here — which is why the
 * quoted capture range is wide.
 */
const SEED_CAPTURE_SEC_PER_FRAME = 1.36;

/** How far either side of the estimate to quote, as a fraction. Capture varies
 *  with the person; building varies with the phone and what else it is doing. */
const CAPTURE_SPREAD = 0.45;
const BUILD_SPREAD = 0.35;

const STORE_KEY = 'horizon.surveyRates.v1';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Rates measured on this device, remembered between sessions.
 *
 * Held as an exponential average rather than a last-value, so one build that
 * happened to run while the phone was recording video does not become the
 * quoted figure for every survey afterwards.
 */
export class SurveyRates {
  constructor(storage = null) {
    this.storage = storage;
    this.captureSecPerFrame = SEED_CAPTURE_SEC_PER_FRAME;
    this.buildSecPerFrame = SEED_BUILD_SEC_PER_FRAME;
    this.captureSamples = 0;
    this.buildSamples = 0;
    this.load();
  }

  load() {
    try {
      const raw = this.storage?.getItem(STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (Number.isFinite(saved.captureSecPerFrame) && saved.captureSecPerFrame > 0) {
        this.captureSecPerFrame = saved.captureSecPerFrame;
        this.captureSamples = saved.captureSamples || 1;
      }
      if (Number.isFinite(saved.buildSecPerFrame) && saved.buildSecPerFrame > 0) {
        this.buildSecPerFrame = saved.buildSecPerFrame;
        this.buildSamples = saved.buildSamples || 1;
      }
    } catch { /* a corrupt or absent store just means the seeds stand */ }
  }

  save() {
    try {
      this.storage?.setItem(STORE_KEY, JSON.stringify({
        captureSecPerFrame: this.captureSecPerFrame,
        buildSecPerFrame: this.buildSecPerFrame,
        captureSamples: this.captureSamples,
        buildSamples: this.buildSamples
      }));
    } catch { /* private mode, quota — the estimate simply stops learning */ }
  }

  _blend(field, samplesField, value) {
    if (!Number.isFinite(value) || value <= 0) return;
    // The first real measurement replaces the seed outright; after that it is
    // averaged in, weighted so recent runs matter more but one outlier cannot
    // take over.
    const n = this[samplesField];
    this[field] = n === 0 ? value : this[field] * 0.6 + value * 0.4;
    this[samplesField] = n + 1;
    this.save();
  }

  /** Record a finished capture: how many photographs, over how many seconds. */
  recordCapture(frames, seconds) {
    if (!(frames > 4) || !(seconds > 1)) return;
    this._blend('captureSecPerFrame', 'captureSamples', seconds / frames);
  }

  /** Record a finished build, the same way. */
  recordBuild(frames, seconds) {
    if (!(frames > 4) || !(seconds > 1)) return;
    this._blend('buildSecPerFrame', 'buildSamples', seconds / frames);
  }

  /** Has this device measured itself yet, or are these still the seeds? */
  get measured() { return this.buildSamples > 0 || this.captureSamples > 0; }
}

/**
 * How many photographs this survey will want.
 *
 * The horizon lap is arithmetic: a full turn divided by the keyframe step. The
 * columns are not, because how tall the scene is cannot be known before looking
 * at it — so `tallFraction` is what fraction of the ring is expected to stand
 * high enough to need bands above the horizon, and `bandsWhenTall` how many
 * those columns need on average.
 *
 * The defaults describe the site this app is actually used on: a back yard with
 * a house across a good part of the view. On the 2026-08-25 capture 121 of 180
 * columns wanted more than one band, averaging 4.4 bands each.
 */
export function estimateFrameCount({
  hfovDeg = 45, stepAcrossDeg = null, columnStepDeg = 9,
  bands = 4.4, tallFraction = 0.45
} = {}) {
  const step = Number.isFinite(stepAcrossDeg) && stepAcrossDeg > 0
    ? stepAcrossDeg : Math.max(3, hfovDeg * 0.10);
  const perLap = 360 / step;
  /*
   * The bands above the horizon are NOT photographed at the horizontal step.
   * The serpentine climbs one column, steps sideways by `columnStepDeg`, and
   * climbs the next — so the upper rows are sampled every 9° of bearing, not
   * every 5°. Costing them at the dense horizontal step overstated a survey of
   * this back yard by about 40%, which would have turned a 15-minute warning
   * into a 25-minute one and taught the operator to discount it.
   */
  const columns = 360 / Math.max(1, columnStepDeg);
  const extra = columns * clamp(tallFraction, 0, 1) * Math.max(0, bands - 1);
  return Math.round(perLap + extra);
}

/**
 * The whole job, in seconds, as a range.
 *
 * Returns capture and build separately because they are different kinds of
 * waiting: one needs the operator standing there holding a phone, the other
 * needs the phone awake and left alone. The operator makes different decisions
 * about each, which is the entire reason for telling them in advance.
 */
export function estimateSurvey({
  rates, frames = null, hfovDeg = 45, stepAcrossDeg = null, columnStepDeg = 9
} = {}) {
  const r = rates || new SurveyRates();
  const n = Number.isFinite(frames) && frames > 0
    ? frames : estimateFrameCount({ hfovDeg, stepAcrossDeg, columnStepDeg });
  const captureSec = n * r.captureSecPerFrame;
  const buildSec = n * r.buildSecPerFrame;
  return {
    frames: n,
    captureSec,
    buildSec,
    totalSec: captureSec + buildSec,
    captureRangeSec: [captureSec * (1 - CAPTURE_SPREAD), captureSec * (1 + CAPTURE_SPREAD)],
    buildRangeSec: [buildSec * (1 - BUILD_SPREAD), buildSec * (1 + BUILD_SPREAD)],
    measured: r.measured
  };
}

/** Minutes, rounded the way a person would say them. Never "0 minutes". */
export function roughMinutes(seconds) {
  const m = Math.max(0, Number(seconds) || 0) / 60;
  if (m < 1.5) return 'about a minute';
  if (m < 10) return `about ${Math.round(m)} minutes`;
  // Past ten minutes the difference between 16 and 17 is not information.
  return `about ${Math.round(m / 5) * 5} minutes`;
}

/**
 * What to tell the operator before they start.
 *
 * One paragraph, in the order they need it: how long standing up holding a
 * phone, how long afterwards with the phone awake, and the one setting that
 * will spoil it if they do not change it now. The screen-dimming line is the
 * reason this exists — a phone that sleeps mid-build has thrown away the walk.
 */
export function describeSurveyPlan(estimate) {
  const e = estimate;
  const capture = roughMinutes(e.captureSec);
  const build = roughMinutes(e.buildSec);
  const total = roughMinutes(e.totalSec);
  const basis = e.measured
    ? 'Timings are from what this device has actually done before.'
    : 'This is a first estimate from a reference device; it will sharpen after one full run here.';
  return `Plan on ${total} in all: ${capture} of walking the horizon with the phone up, `
    + `then ${build} of building the panorama with the phone awake and left alone. `
    + `Set the screen to stay on before you start — a phone that sleeps during the build loses the walk. `
    + `${basis}`;
}
