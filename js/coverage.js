'use strict';

import { wrap360, angDiff, clamp } from './math3d.js';

/**
 * What the camera has actually looked at, and how well.
 *
 * This is the physical truth layer of coverage-guided scanning, and it is
 * deliberately ignorant of the user interface. It answers one question — has
 * the region around this bearing received enough usable observation? — and
 * `js/guidance.js` turns that answer into somewhere to point. Keeping the two
 * apart means the scoring below can be retuned, or replaced outright, without
 * touching how the target behaves on screen.
 *
 * WHY THIS IS NOT THE SURVEY'S 720 BINS. `Survey` already keeps a bin per half
 * degree, but those record the measured skyline ALTITUDE and its agreement
 * across passes, they are filled only from accepted keyframes about nine
 * degrees apart, and a bin is only touched when a keyframe was admitted. That
 * is the right model for the product and the wrong one for guidance: what the
 * operator needs to be told is where the camera has dwelt with good data, which
 * includes every processed frame at roughly 10 Hz and must account for the
 * frames that were REFUSED. A sector the segmenter rejected forty times running
 * has plenty of survey observations of nothing, and zero coverage.
 *
 * THE SCORE IS A CONFIDENCE, NOT A COUNTER. Each observation moves a bin a
 * fraction of the way from where it is to fully covered:
 *
 *     score += (1 - score) * gain
 *
 * so repeated good looks raise confidence with diminishing returns, the value
 * can never exceed one, and a bin that is already solid is not made "more
 * solid" by staring at it. A poor observation contributes a small gain or none
 * at all; nothing ever REMOVES coverage. That last point is a deliberate
 * product decision rather than a modelling convenience — the operator will
 * wobble, reverse, overshoot and revisit, and a scanner that took coverage away
 * for it would be unusable.
 */

/**
 * Every knob, in one place, so the feel can be tuned without reading the code.
 * Angles in degrees, times in seconds unless a name says otherwise.
 */
export const COVERAGE_TUNING = {
  /** Angular resolution of the coverage map. 360 must divide by this. */
  binSizeDeg: 2,

  /** Confidence at which a bin counts as covered. */
  coverageThreshold: 0.75,
  /** Independent observations a bin needs regardless of how good they were.
   *  Stops one lucky frame from declaring a sector done. */
  minObservations: 5,

  /** How fast confidence accumulates, per second of ideal-quality viewing at
   *  the centre of frame. 2.0 puts a bin near 0.9 after about 1.5 s. */
  gainPerSecond: 2.0,
  /** Longest gap between frames that may be credited as continuous viewing.
   *  Without this, a stall in the pipeline would deposit a huge lump of
   *  confidence for a moment nobody was actually looking. */
  maxFrameGapSec: 0.25,

  /** Fraction of the horizontal field of view that earns credit. The outer
   *  edges are where lens distortion is worst and where the skyline is least
   *  reliably traced, so they are not treated as "looked at". */
  usableFovFraction: 0.8,
  /** Credit at the edge of the usable field, relative to the centre. */
  edgeWeight: 0.35,

  /* ---- quality ramps. Each is 1.0 across the whole normal operating range
     and falls off only when something is genuinely wrong, so that ordinary
     scanning is never quietly penalised. ---- */

  /** Turn rate that still earns full credit, and the rate at which an
   *  observation is worth nothing. */
  comfortableRateDegPerSec: 25,
  maxRateDegPerSec: 70,

  /** Elevation the camera may sit at before coverage stops counting. The
   *  survey is of the horizon; a frame pointed at the zenith has not observed
   *  the skyline whatever else it did. */
  comfortableElevationDeg: 25,
  maxElevationDeg: 55,

  /** Roll is carried through the projection and is not an error, but a heavily
   *  rolled frame samples a different band of sky and traces a worse skyline. */
  comfortableRollDeg: 12,
  maxRollDeg: 40,

  /** Change in turn rate between frames, as a proxy for erratic motion. */
  comfortableJerkDegPerSec2: 60,
  maxJerkDegPerSec2: 260,

  /** Orientation-stream scatter, in degrees. */
  comfortableJitterDeg: 0.6,
  maxJitterDeg: 2.5,

  /** Mean segmentation confidence along the traced skyline. Below the floor the
   *  boundary is not trustworthy enough to call the sector observed. */
  minSkylineConfidence: 0.30,
  goodSkylineConfidence: 0.55,

  /** Frame-to-frame registration quality, where the pipeline reports it. */
  minVisualQuality: 0.20,
  goodVisualQuality: 0.45,

  /** Blown-highlight fraction. Panning into a low sun collapses the exposure
   *  and the traced skyline with it. */
  maxGlareFraction: 0.04,

  /** Fraction of the circle allowed to remain uncovered at completion. 0.015 is
   *  about five degrees, roughly two bins. */
  completionTolerance: 0.015
};

/** Frame states that mean the camera did not usefully observe anything. */
const DISQUALIFYING_FRAME_STATUS = new Set([
  'tooHigh', 'parallax', 'trackingLost', 'tooDark', 'noSky', 'allSky', 'clippedTop'
]);

/**
 * A falling ramp: 1 at or below `good`, 0 at or above `bad`, smooth between.
 * Smoothstep rather than linear so quality does not visibly step as the
 * operator drifts across a threshold.
 */
function fallingRamp(value, good, bad) {
  if (!Number.isFinite(value)) return 1;          // unmeasured is not evidence of harm
  const v = Math.abs(value);
  if (v <= good) return 1;
  if (v >= bad) return 0;
  const t = (v - good) / (bad - good);
  return 1 - t * t * (3 - 2 * t);
}

/** A rising ramp: 0 at or below `bad`, 1 at or above `good`. */
function risingRamp(value, bad, good) {
  if (!Number.isFinite(value)) return 1;
  if (value <= bad) return 0;
  if (value >= good) return 1;
  const t = (value - bad) / (good - bad);
  return t * t * (3 - 2 * t);
}

export class CoverageMap {
  constructor(tuning = {}) {
    this.tuning = { ...COVERAGE_TUNING, ...tuning };
    this.binCount = Math.max(8, Math.round(360 / this.tuning.binSizeDeg));
    this.binSizeDeg = 360 / this.binCount;
    this.reset();
  }

  reset() {
    this.score = new Float32Array(this.binCount);
    this.observations = new Uint16Array(this.binCount);
    // Every bin the camera has pointed at, whether or not the frame was worth
    // anything. Kept apart from `observations`, which counts only frames that
    // earned credit, because guidance needs to tell "swept past and got
    // nothing" apart from "not reached yet" and those are different facts.
    this.visits = new Uint16Array(this.binCount);
    this.bestQuality = new Float32Array(this.binCount);
    this.lastYawRate = null;
    this.lastObservedAt = null;
    this.totalObservations = 0;
    this.rejectedObservations = 0;
    /* Bumped every time a bin crosses into "covered". Guidance uses it as the
     * single permission to re-pick its target: if no ground became covered,
     * nothing about the map changed that could justify moving the dot, however
     * far the phone turned. This is the mechanism that makes "the dot advances
     * because the horizon got covered" true rather than merely intended. */
    this.generation = 0;
  }

  /** Bin index containing a bearing. */
  indexOf(headingDeg) {
    return Math.floor(wrap360(headingDeg) / this.binSizeDeg) % this.binCount;
  }

  /** Centre bearing of a bin. */
  bearingOf(index) {
    return wrap360((index + 0.5) * this.binSizeDeg);
  }

  /**
   * How good was this instant, as a single 0..1 number?
   *
   * Split into hard gates and soft ramps on purpose. The gates are conditions
   * under which the frame did not observe the horizon at all — there is no
   * partial credit for a photograph of the inside of a pocket. The ramps are
   * conditions that degrade an observation that did happen, and they multiply,
   * so several mediocre factors compound the way they do in reality. Every ramp
   * sits at exactly 1.0 through the normal operating range, which is what stops
   * the product of eight of them from quietly punishing a good scan.
   */
  observationQuality(sample) {
    const t = this.tuning;
    if (sample.trackingLost) return 0;
    if (sample.frameStatus && DISQUALIFYING_FRAME_STATUS.has(sample.frameStatus)) return 0;
    if (Number.isFinite(sample.skylineConfidence)
      && sample.skylineConfidence < t.minSkylineConfidence) return 0;
    if (Number.isFinite(sample.glareFraction)
      && sample.glareFraction > t.maxGlareFraction) return 0;

    // Erratic motion, measured as change in turn rate since the last frame.
    let jerk = null;
    if (Number.isFinite(sample.yawRateDegPerSec) && Number.isFinite(this.lastYawRate)
      && Number.isFinite(sample.dtSec) && sample.dtSec > 1e-3) {
      jerk = Math.abs(sample.yawRateDegPerSec - this.lastYawRate) / sample.dtSec;
    }

    const factors = [
      fallingRamp(sample.yawRateDegPerSec, t.comfortableRateDegPerSec, t.maxRateDegPerSec),
      fallingRamp(sample.elevationDeg, t.comfortableElevationDeg, t.maxElevationDeg),
      fallingRamp(sample.rollDeg, t.comfortableRollDeg, t.maxRollDeg),
      fallingRamp(jerk, t.comfortableJerkDegPerSec2, t.maxJerkDegPerSec2),
      fallingRamp(sample.jitterDeg, t.comfortableJitterDeg, t.maxJitterDeg),
      risingRamp(sample.skylineConfidence, t.minSkylineConfidence, t.goodSkylineConfidence),
      risingRamp(sample.visualQuality, t.minVisualQuality, t.goodVisualQuality)
    ];
    let quality = 1;
    for (const f of factors) quality *= f;
    return clamp(quality, 0, 1);
  }

  /**
   * Credit one processed frame to every bin it could see.
   *
   * Crediting only the bin under the optical axis would be wrong twice over: it
   * would under-report a sweep (a 45-degree field genuinely observes 45 degrees
   * of horizon at once) and it would make coverage depend on frame rate rather
   * than on where the camera pointed. Credit is therefore spread across the
   * usable field with a raised-cosine falloff, so the centre — where the lens
   * is best behaved and the skyline best traced — is worth roughly three times
   * the edge.
   *
   * Returns what it did, which is what the capture audit and the guidance layer
   * want to know.
   */
  observe(sample = {}) {
    const t = this.tuning;
    const heading = Number(sample.headingDeg);
    if (!Number.isFinite(heading)) return { credited: false, reason: 'no-heading', quality: 0 };

    const dtSec = Number.isFinite(sample.dtSec)
      ? clamp(sample.dtSec, 0, t.maxFrameGapSec)
      : t.maxFrameGapSec * 0.5;

    const quality = this.observationQuality({ ...sample, dtSec });
    if (Number.isFinite(sample.yawRateDegPerSec)) this.lastYawRate = sample.yawRateDegPerSec;

    const hfov = Number.isFinite(sample.hfovDeg) && sample.hfovDeg > 1 ? sample.hfovDeg : 45;
    const halfSpan = hfov * t.usableFovFraction / 2;
    const first = Math.floor((heading - halfSpan) / this.binSizeDeg);
    const last = Math.ceil((heading + halfSpan) / this.binSizeDeg);

    let touched = 0;
    for (let raw = first; raw <= last; raw++) {
      const centre = (raw + 0.5) * this.binSizeDeg;
      const offset = Math.abs(angDiff(centre, heading));
      if (offset > halfSpan) continue;
      const index = ((raw % this.binCount) + this.binCount) % this.binCount;

      // The camera pointed here. Recorded even for a worthless frame, because
      // "swept through and got nothing" is precisely the state the guidance dot
      // has to recognise in order to wait for the operator.
      if (this.visits[index] < 65535) this.visits[index]++;
      if (quality <= 0) continue;

      // Raised cosine from 1 at the axis to `edgeWeight` at the usable edge.
      const u = offset / halfSpan;
      const weight = t.edgeWeight + (1 - t.edgeWeight) * (0.5 * (1 + Math.cos(Math.PI * u)));
      const gain = quality * weight * dtSec * t.gainPerSecond;
      const wasCovered = this.isCovered(index);
      // Asymptotic approach: repeated good looks help, with diminishing returns,
      // and the score cannot run past 1.
      this.score[index] += (1 - this.score[index]) * clamp(gain, 0, 1);
      if (this.observations[index] < 65535) this.observations[index]++;
      if (!wasCovered && this.isCovered(index)) this.generation++;
      if (quality * weight > this.bestQuality[index]) this.bestQuality[index] = quality * weight;
      touched++;
    }

    if (quality <= 0) {
      this.rejectedObservations++;
      return { credited: false, reason: 'quality-zero', quality: 0 };
    }
    this.totalObservations++;
    this.lastObservedAt = sample.atMs ?? null;
    return { credited: touched > 0, quality, bins: touched, dtSec };
  }

  /** Confidence 0..1 for a bin index. */
  scoreOf(index) {
    return this.score[((index % this.binCount) + this.binCount) % this.binCount];
  }

  /** Confidence 0..1 at a bearing. */
  scoreAt(headingDeg) {
    return this.score[this.indexOf(headingDeg)];
  }

  /**
   * Is this bin done? Both tests matter: the score says the looking was good,
   * the observation count says there was enough of it. A single very good frame
   * can drive the score high, and one frame is not a scan.
   */
  isCovered(index) {
    const i = ((index % this.binCount) + this.binCount) % this.binCount;
    return this.score[i] >= this.tuning.coverageThreshold
      && this.observations[i] >= this.tuning.minObservations;
  }

  coveredAt(headingDeg) {
    return this.isCovered(this.indexOf(headingDeg));
  }

  /**
   * Has the camera ever looked here at all, however badly?
   *
   * The distinction between "visited but not covered" and "never visited"
   * matters to guidance and nowhere else. Ground the operator swept through
   * without capturing anything usable is ground to send them back over; ground
   * they have simply not reached yet is not. Without this the dot would open
   * every scan by pointing backwards, because at the start nothing is covered
   * and everything therefore looks like it was missed.
   */
  visited(index) {
    return this.visits[((index % this.binCount) + this.binCount) % this.binCount] > 0;
  }

  visitedAt(headingDeg) {
    return this.visited(this.indexOf(headingDeg));
  }

  /** Overall state of the scan. */
  completeness() {
    let covered = 0, sum = 0, weakest = 0, weakestIndex = 0;
    let lowest = Infinity;
    for (let i = 0; i < this.binCount; i++) {
      if (this.isCovered(i)) covered++;
      sum += this.score[i];
      if (this.score[i] < lowest) { lowest = this.score[i]; weakestIndex = i; }
    }
    weakest = Number.isFinite(lowest) ? lowest : 0;
    const fraction = covered / this.binCount;
    return {
      binCount: this.binCount,
      coveredBins: covered,
      fraction,
      meanScore: sum / this.binCount,
      weakestScore: weakest,
      weakestBearingDeg: this.bearingOf(weakestIndex),
      // A tiny sliver missed at a seam should not hold a survey hostage.
      complete: (1 - fraction) <= this.tuning.completionTolerance,
      remainingDeg: (this.binCount - covered) * this.binSizeDeg
    };
  }

  /**
   * Contiguous runs of not-yet-covered bins, largest first. Used by the
   * guidance layer to choose somewhere to send the operator, and by the report
   * to say what is left.
   */
  gaps() {
    // Find a covered bin to start from, so a run that straddles north is walked
    // as one piece rather than clipped into two at the array boundary.
    let anchor = -1;
    for (let i = 0; i < this.binCount; i++) {
      if (this.isCovered(i)) { anchor = i; break; }
    }
    if (anchor < 0) {
      // Nothing covered at all: the gap is the whole circle.
      return [this._run(0, this.binCount)];
    }
    const runs = [];
    let start = -1;
    for (let k = 1; k <= this.binCount; k++) {
      const i = (anchor + k) % this.binCount;
      const covered = this.isCovered(i);
      if (!covered && start < 0) start = anchor + k;
      else if (covered && start >= 0) { runs.push(this._run(start, anchor + k)); start = -1; }
    }
    if (start >= 0) runs.push(this._run(start, anchor + this.binCount + 1));
    runs.sort((a, b) => b.widthDeg - a.widthDeg);
    return runs;
  }

  _run(startIndex, endIndex) {
    const widthBins = Math.min(this.binCount, endIndex - startIndex);
    const fromDeg = wrap360(startIndex * this.binSizeDeg);
    let worst = 1, worstIndex = startIndex;
    for (let i = startIndex; i < startIndex + widthBins; i++) {
      const s = this.scoreOf(i);
      if (s < worst) { worst = s; worstIndex = i; }
    }
    return {
      fromDeg,
      toDeg: wrap360(fromDeg + widthBins * this.binSizeDeg),
      widthDeg: widthBins * this.binSizeDeg,
      centreDeg: wrap360(fromDeg + widthBins * this.binSizeDeg / 2),
      weakestBearingDeg: this.bearingOf(worstIndex),
      weakestScore: worst
    };
  }

  /** Compact record for the debug archive and the acceptance report. */
  snapshot() {
    const summary = this.completeness();
    return {
      binSizeDeg: this.binSizeDeg,
      binCount: this.binCount,
      coverageThreshold: this.tuning.coverageThreshold,
      minObservations: this.tuning.minObservations,
      completionTolerance: this.tuning.completionTolerance,
      totalObservations: this.totalObservations,
      rejectedObservations: this.rejectedObservations,
      ...summary,
      gaps: this.gaps().slice(0, 12),
      score: Array.from(this.score, v => Number(v.toFixed(4))),
      observations: Array.from(this.observations),
      visits: Array.from(this.visits)
    };
  }
}
