'use strict';
import {
  clamp, wrap360, angDiff, quatRotate, cameraRay, vecToAzAlt,
  weightedMedian, mad, screenQuat, quatMul, quatFromAxisAngle, yawQuat, DEG, RAD
} from './math3d.js';

export const BIN_COUNT = 720;
export const BIN_STEP = 0.5;

export const STATUS = { EMPTY: 0, THIN: 1, WEAK: 2, VERIFIED: 3 };

/** Acceptance rules. Everything the app calls "verified" comes from here. */
export const RULES = {
  minObservations: 4,
  minPasses: 2,
  maxSpreadDeg: 1.5,      // MAD of altitude observations within a bin
  minConfidence: 0.42,    // mean segmentation confidence
  maxLoopErrorDeg: 2.0,
  maxSpikeDeg: 5.0,       // departure from the local median that marks a bin as a spike

  /* ------------------------------------------------ the single-lap route
   *
   * A second lap was required because two passes are the obvious way to get
   * independent evidence for a bin. It is not the only way, and it is not free.
   *
   * Measured on the 2026-08-18 iPad capture: between two frames in the SAME lap
   * the disagreement no rotation can explain is 0.084° median, 0.185° at the
   * 90th percentile. Between two frames in DIFFERENT laps it is 0.203° and
   * 1.215° — 2.4x and 6.6x worse, growing with the time between them. The cause
   * is the operator's own position: a lap later they stand a few centimetres
   * elsewhere, and against a house twelve metres away that is real parallax,
   * which a camera model made of rotations cannot represent and a blender can
   * only average. That average is a doubled window.
   *
   * So a second lap buys confirmation and sells geometry. This route lets a bin
   * earn VERIFIED inside one lap instead, by holding it to a HARDER standard on
   * the evidence that lap actually produced: twice the observations, a tighter
   * spread, and a higher confidence floor. It is not a relaxation — a bin that
   * takes this route has more independent looks at the horizon than a
   * two-pass bin needs, just gathered without the operator moving.
   */
  singleLapObservations: 8,
  singleLapSpreadScale: 0.7,   // of the usual per-bin spread allowance
  singleLapConfidence: 0.55
};

export class Survey {
  constructor() { this.reset(); }

  reset() {
    this.bins = Array.from({ length: BIN_COUNT }, () => ({ obs: [], alt: NaN, spread: 0, conf: 0, passes: new Set(), status: STATUS.EMPTY }));
    this.keyframes = [];
    this.pass = 1;
    this.loopError = null;
    this.loopClosed = false;
    this.focalPx = null;          // self-calibrated horizontal focal length, in working-frame pixels
    this.focalSamples = [];
    this.scaleCalibration = null;
    this.focalRecent = [];
    this.focalEstablished = null;
    this.lensChanges = [];
    this.yawDatum = 0;
    this.startedAt = Date.now();
    this.manualEdits = 0;
    this.sensorHealth = { compass: 'unknown', gyro: 'unknown', compassRejects: 0, compassChecks: 0 };
  }

  /* ---------------------------------------------------------------- keyframes */

  /**
   * Record a keyframe. Column data is stored in IMAGE space so that the whole
   * profile can be reprojected later after drift correction — nothing is
   * committed to a bin irreversibly.
   */
  addKeyframe(kf) {
    kf.index = this.keyframes.length;
    kf.yawBase = kf.yawBase || 0;   // visual-fusion correction fixed at capture
    kf.yawCorrection = 0;           // loop-closure share, assigned afterwards
    this.keyframes.push(kf);
    return kf;
  }

  /** Total gyro-integrated yaw travelled across the pass-1 keyframe chain. */
  accumulatedYaw() {
    let total = 0;
    for (let i = 1; i < this.keyframes.length; i++) {
      total += angDiff(this.keyframes[i].yawRaw, this.keyframes[i - 1].yawRaw);
    }
    return total;
  }

  /* ------------------------------------------------------------ loop closure */

  /**
   * Distribute residual yaw error across the keyframe chain in proportion to
   * how far each frame is along the accumulated rotation. Same idea as closing
   * a traverse in survey work.
   */
  /**
   * Calibrate the optics from the closed loop.
   *
   * One physical circuit is 360 degrees by definition. So if the scan logged
   * 176, the scale is wrong by 360/176 = 2.05 — and since the only thing that
   * scales a visually derived rotation is the focal length, that ratio hands
   * back the true focal length directly. This turns the unknown field of view
   * from something the operator has to look up into something the survey
   * measures on its own, from the one datum that is exact and free.
   *
   * A worked example: the 2026-07-29 run logged 176 degrees for one lap while
   * assuming 66 degrees of horizontal field. That implies a true field of about
   * 106 degrees — the ultra-wide, not the main camera, which is what the phone
   * had actually handed over.
   *
   * Returns { scale, hfovDeg } or null if the ratio is implausible.
   */
  calibrateScaleFromLoop(measuredDeg, assumedHfovDeg, laps = 1) {
    if (!measuredDeg) return null;
    const trueDeg = 360 * laps * Math.sign(measuredDeg);
    const scale = trueDeg / measuredDeg;
    // Outside this band the operator did not walk the laps they said they did,
    // and rescaling would bake a mistake into the profile permanently.
    if (!(scale > 0.35 && scale < 3.5)) return null;

    for (const kf of this.keyframes) kf.yawBase *= scale;
    this.scaleCalibration = scale;

    const fAssumed = 0.5 / Math.tan(assumedHfovDeg / 2 * DEG);   // per unit width
    const fTrue = fAssumed / scale;
    const hfovDeg = 2 * Math.atan(0.5 / fTrue) * RAD;
    return { scale, hfovDeg };
  }

  applyLoopClosure(residualDeg) {
    this.loopError = residualDeg;
    const total = this.accumulatedYaw();
    if (!Number.isFinite(residualDeg) || Math.abs(total) < 90) return false;
    let travelled = 0;
    for (let i = 0; i < this.keyframes.length; i++) {
      if (i > 0) travelled += angDiff(this.keyframes[i].yawRaw, this.keyframes[i - 1].yawRaw);
      this.keyframes[i].yawCorrection = -residualDeg * (travelled / total);
    }
    this.loopClosed = true;
    return true;
  }

  /* ------------------------------------------------- focal self-calibration */

  /**
   * Compare visual pixel shift against gyro yaw change. The ratio is the focal
   * length in pixels, recovered from the scan itself rather than trusted from a
   * slider. Only near-level, well-matched, moderate-motion pairs are used.
   */
  addFocalSample(pixelDx, gyroYawDeg, pitchDeg, quality) {
    if (quality < 0.6) return;
    const a = Math.abs(gyroYawDeg);
    if (a < 1.5 || a > 12) return;
    if (Math.abs(pitchDeg) > 35) return;
    if (Math.abs(pixelDx) < 1.5) return;
    const f = Math.abs(pixelDx) / Math.tan(a * DEG * Math.cos(pitchDeg * DEG));
    if (!Number.isFinite(f) || f < 40 || f > 4000) return;
    this.focalSamples.push(f);
    this.focalRecent.push(f);
    if (this.focalRecent.length > 24) this.focalRecent.shift();

    if (this.focalSamples.length >= 12) {
      const s = this.focalSamples.slice().sort((x, y) => x - y);
      this.focalPx = s[Math.floor(s.length / 2)];
      if (this.focalSamples.length > 400) this.focalSamples.splice(0, this.focalSamples.length - 400);
    }
    return this._checkLensChange();
  }

  /**
   * Detect a lens change from the imagery, not from the device list.
   *
   * A phone that exposes one logical rear camera can switch physical sensors
   * without changing deviceId, resolution, or anything else visible to
   * getSettings(). What it cannot hide is the focal length: the main and
   * ultra-wide lenses differ by roughly 30-40%, so the pixel shift produced by
   * a given rotation changes by the same factor the instant the swap happens.
   *
   * This only works because rotation is now measured by a gyroscope rather than
   * a magnetometer. Against a noisy rotation estimate the focal samples were too
   * scattered to see a step in.
   *
   * Returns a descriptor when a change is detected, otherwise null. The caller
   * starts a new focal segment; keyframes already captured keep the intrinsics
   * they were captured with.
   */
  _checkLensChange() {
    if (this.focalRecent.length < 24 || !this.focalEstablished) return null;
    const r = this.focalRecent.slice().sort((a, b) => a - b);
    const recentMedian = r[Math.floor(r.length / 2)];
    const ratio = recentMedian / this.focalEstablished;
    // 18% is comfortably above the scatter of a settled estimate and well below
    // the gap between any two lenses a phone actually ships.
    if (ratio > 1.18 || ratio < 1 / 1.18) {
      const change = { from: this.focalEstablished, to: recentMedian, ratio };
      this.focalEstablished = recentMedian;
      this.focalSamples = this.focalRecent.slice();
      this.focalPx = recentMedian;
      this.lensChanges.push(change);
      return change;
    }
    return null;
  }

  /** Called once the focal estimate has converged, to arm change detection. */
  establishFocal(px) {
    this.focalEstablished = px;
  }

  /**
   * Convergence state of the focal-length estimate.
   *
   * The median alone says nothing about whether it can be trusted, so the
   * calibration UI gates on the interquartile spread instead: a lens solved
   * from consistent geometry tightens, one solved from a drifting sensor or a
   * textureless scene does not, however many samples accumulate.
   */
  focalStats() {
    const n = this.focalSamples.length;
    if (n < 4) return { n, median: null, iqrPct: null, converged: false };
    const s = this.focalSamples.slice().sort((a, b) => a - b);
    const q = f => s[Math.min(s.length - 1, Math.max(0, Math.floor(f * s.length)))];
    const median = q(0.5), iqr = q(0.75) - q(0.25);
    const iqrPct = median > 0 ? (iqr / median) * 100 : null;
    return { n, median, iqrPct, converged: n >= 25 && iqrPct !== null && iqrPct < 8 };
  }

  /* ---------------------------------------------------------- reprojection */

  /** Rebuild every bin from stored keyframe column data. */
  reproject(intrinsics) {
    for (const b of this.bins) { b.obs.length = 0; b.passes = new Set(); }
    for (const kf of this.keyframes) this._projectKeyframe(kf, intrinsics);
    this.recompute();
  }

  _projectKeyframe(kf, intrinsics) {
    // A keyframe carries the intrinsics it was actually captured with. On a
    // phone that exposes one logical rear camera backed by several physical
    // lenses, the platform may change lens mid-scan without changing deviceId
    // or resolution, so a single global focal length would silently misproject
    // every frame on the far side of the swap.
    const tanH = kf.tanHalfH ?? intrinsics.tanHalfH;
    const tanV = kf.tanHalfV ?? intrinsics.tanHalfV;
    const total = (kf.yawBase || 0) + (kf.yawCorrection || 0) + (this.yawDatum || 0);
    const q = total ? quatMul(yawQuat(total), kf.quat) : kf.quat;
    const n = kf.boundary.length;
    for (let x = 0; x < n; x++) {
      if (kf.flags[x] !== 0) continue;
      const conf = kf.confidence[x];
      if (conf <= 0.05) continue;
      const u = (x + 0.5) / n * 2 - 1;
      const v = 1 - (kf.boundary[x] / kf.height) * 2;
      const world = quatRotate(q, cameraRay(u, v, tanH, tanV));
      const { az, alt } = vecToAzAlt(world);
      if (alt < -20 || alt > 89.5) continue;
      const idx = Math.round(wrap360(az) / BIN_STEP) % BIN_COUNT;
      // Down-weight the outer edge of the frame where lens distortion and the
      // focal estimate are least trustworthy.
      const edgeWeight = 1 - 0.45 * Math.pow(Math.abs(u), 3);
      this.bins[idx].obs.push({
        value: clamp(alt, 0, 90),
        weight: conf * edgeWeight,
        frame: kf.index,
        pass: kf.pass,
        source: kf.captureKind || 'sweep'
      });
      this.bins[idx].passes.add(kf.pass);
    }
  }

  /* -------------------------------------------------------------- statistics */

  recompute() {
    // Stage 1: robust altitude and spread per bin, independent of neighbours.
    for (const b of this.bins) {
      if (!b.obs.length) { b.alt = NaN; b.spread = 0; b.conf = 0; b.status = STATUS.EMPTY; continue; }
      const med = weightedMedian(b.obs);
      const values = b.obs.map(o => o.value);
      const spread = mad(values, med);
      // Second pass: drop observations more than 3 MAD out, then re-median.
      const cut = Math.max(0.6, spread * 3);
      const kept = b.obs.filter(o => Math.abs(o.value - med) <= cut);
      const use = kept.length >= 2 ? kept : b.obs;
      b.alt = weightedMedian(use);
      b.spread = mad(use.map(o => o.value), b.alt);
      b.conf = use.reduce((s, o) => s + o.weight, 0) / use.length;
    }
    // Stage 2: local slope, so a genuinely steep skyline is not mistaken for a
    // noisy one. Rays inside a single bin that straddle a roof edge legitimately
    // disagree by roughly the height of the edge.
    for (let i = 0; i < BIN_COUNT; i++) {
      const prev = this.bins[(i - 1 + BIN_COUNT) % BIN_COUNT];
      const next = this.bins[(i + 1) % BIN_COUNT];
      const a = this.bins[i];
      a.slope = (Number.isFinite(prev.alt) && Number.isFinite(next.alt))
        ? Math.abs(next.alt - prev.alt) / 2 : 0;
    }
    for (const b of this.bins) b.status = this._grade(b);
    this._flagIsolatedSpikes();
  }

  /** Spread allowance for a bin, widened where the horizon is genuinely steep. */
  spreadLimit(b) {
    return RULES.maxSpreadDeg + 1.4 * (b.slope || 0);
  }

  /**
   * Can this bin stand on one lap alone?
   *
   * Recorded on the bin rather than recomputed by callers, because the coverage
   * table, the report and the guidance all need to say WHICH route a bin took
   * and an operator deciding whether to walk again deserves a straight answer.
   */
  _singleLapVerified(b) {
    return b.obs.length >= RULES.singleLapObservations
      && b.spread <= this.spreadLimit(b) * RULES.singleLapSpreadScale
      && b.conf >= RULES.singleLapConfidence;
  }

  _grade(b) {
    b.route = null;
    if (!b.obs.length) return STATUS.EMPTY;
    if (b.obs.length < 2) return STATUS.THIN;

    const spreadOk = b.spread <= this.spreadLimit(b);
    const twoPass = b.obs.length >= RULES.minObservations
      && b.passes.size >= RULES.minPasses
      && spreadOk
      && b.conf >= RULES.minConfidence;
    if (twoPass) { b.route = 'two-pass'; return STATUS.VERIFIED; }

    // Only offer the single-lap route to a bin that has genuinely only had one
    // lap. A bin seen twice and still disagreeing has been contradicted, and
    // dense sampling within one of those laps is not an answer to that.
    if (b.passes.size <= 1 && this._singleLapVerified(b)) {
      b.route = 'single-lap';
      return STATUS.VERIFIED;
    }
    return STATUS.WEAK;
  }

  /**
   * Demote isolated spikes, not steps. A real roofline edge is a step: the
   * local median follows it. A segmentation failure is a spike that the median
   * of its neighbours rejects. Comparing against a windowed median separates
   * the two, where a simple slope threshold could not.
   */
  _flagIsolatedSpikes() {
    const HALF = 4;
    for (let i = 0; i < BIN_COUNT; i++) {
      const b = this.bins[i];
      if (!Number.isFinite(b.alt)) continue;
      const win = [];
      for (let d = -HALF; d <= HALF; d++) {
        const v = this.bins[(i + d + BIN_COUNT) % BIN_COUNT].alt;
        if (Number.isFinite(v)) win.push(v);
      }
      if (win.length < 5) continue;
      win.sort((x, y) => x - y);
      const med = win[Math.floor(win.length / 2)];
      if (Math.abs(b.alt - med) > RULES.maxSpikeDeg) {
        b.spike = true;
        if (b.status === STATUS.VERIFIED) b.status = STATUS.WEAK;
      } else {
        b.spike = false;
      }
    }
  }

  /* ------------------------------------------------------------- weak sectors */

  /** Contiguous runs of non-verified bins, largest first. */
  weakSectors(minWidthDeg = 1.5) {
    const runs = [];
    let start = -1;
    const bad = i => this.bins[i].status !== STATUS.VERIFIED;
    // A normal first lap has zero verified bins by definition: verification
    // requires observations from two passes. The circular run below has no
    // good bin at which to close an all-bad run, so it used to return [] and
    // falsely announce that every sector was verified. Preserve the full ring.
    if (this.bins.every((_, i) => bad(i))) {
      return [{ fromDeg: 0, toDeg: 0, widthDeg: 360 }];
    }
    for (let i = 0; i < BIN_COUNT * 2; i++) {
      const idx = i % BIN_COUNT;
      if (bad(idx)) { if (start < 0) start = i; }
      else if (start >= 0) {
        if (i - start >= minWidthDeg / BIN_STEP && start < BIN_COUNT) {
          runs.push({ fromDeg: wrap360(start * BIN_STEP), toDeg: wrap360(i * BIN_STEP), widthDeg: (i - start) * BIN_STEP });
        }
        start = -1;
      }
      if (i >= BIN_COUNT && start < 0) break;
    }
    const seen = new Set();
    return runs.filter(r => {
      const k = r.fromDeg.toFixed(1);
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).sort((a, b) => b.widthDeg - a.widthDeg);
  }

  coverage() {
    let observed = 0, verified = 0, obsTotal = 0, maxSpread = 0, confTotal = 0, confN = 0;
    for (const b of this.bins) {
      if (b.obs.length) { observed++; obsTotal += b.obs.length; confTotal += b.conf; confN++; }
      if (b.status === STATUS.VERIFIED) verified++;
      if (b.spread > maxSpread) maxSpread = b.spread;
    }
    const counts = this.bins.filter(b => b.obs.length).map(b => b.obs.length).sort((a, b) => a - b);
    // The DISTRIBUTION of spread, not only its worst case. A single bin sets
    // the maximum, and at the vertical edge of a close building the true
    // skyline falls forty degrees within two or three degrees of azimuth — so
    // a couple of degrees of pointing error there produces a huge maximum while
    // the other seven hundred bins are sound. Reporting only the worst case
    // has been failing surveys that were visibly usable.
    const spreads = this.bins.filter(b => b.obs.length).map(b => b.spread).sort((a, b) => a - b);
    const at = f => spreads.length ? spreads[Math.min(spreads.length - 1, Math.floor(spreads.length * f))] : 0;
    return {
      observedBins: observed,
      verifiedBins: verified,
      coverageDeg: observed * BIN_STEP,
      medianObservations: counts.length ? counts[Math.floor(counts.length / 2)] : 0,
      totalObservations: obsTotal,
      maxSpread,
      medianSpread: at(0.5),
      p90Spread: at(0.9),
      spreadOver5: spreads.filter(s => s > 5).length,
      meanConfidence: confN ? confTotal / confN : 0
    };
  }

  /** The survey report. Nothing here is cosmetic — export gating reads it. */
  report() {
    const c = this.coverage();
    const weak = this.weakSectors();
    const checks = [
      { name: 'Full 360° observed', pass: c.observedBins === BIN_COUNT, detail: `${c.coverageDeg.toFixed(1)}° of 360.0°` },
      { name: 'Every bin verified', pass: c.verifiedBins === BIN_COUNT, detail: `${c.verifiedBins} / ${BIN_COUNT}` },
      // Independent evidence, not a second physical lap. A bin that gathered
      // enough tight, confident looks inside one lap satisfies this without the
      // operator moving — which is the point, because moving is what introduces
      // the parallax the stitcher then has to average away.
      { name: 'Independent evidence per bin',
        pass: this.bins.every(b => !b.obs.length
          || b.passes.size >= RULES.minPasses || this._singleLapVerified(b)),
        detail: (() => {
          const single = this.bins.filter(b => b.route === 'single-lap').length;
          const two = this.bins.filter(b => b.route === 'two-pass').length;
          const short = this.bins.filter(b => b.obs.length && !b.route).length;
          return `${two} bin(s) on two passes, ${single} on a single lap, ${short} still short`;
        })() },
      // Judged on the ninetieth percentile rather than on the single worst bin.
      // Every bin still has to be within limit for a clean pass, but a survey
      // whose only offenders are a handful of bins at the vertical edge of a
      // close building is no longer condemned outright — that is geometry, not
      // a fault, and the old wording made a usable profile read as a failure.
      { name: 'Altitude spread in range',
        pass: this.bins.every(b => !b.obs.length || b.spread <= this.spreadLimit(b)),
        detail: `median ${c.medianSpread.toFixed(2)}°, 90th pct ${c.p90Spread.toFixed(2)}°, worst ${c.maxSpread.toFixed(2)}° (limit ${RULES.maxSpreadDeg}° plus slope allowance; ${c.spreadOver5} bin(s) over 5°)` },
      { name: 'No isolated spikes', pass: !this.bins.some(b => b.spike), detail: `${this.bins.filter(b => b.spike).length} spike bin(s)` },
      { name: 'Segmentation confidence', pass: c.meanConfidence >= RULES.minConfidence, detail: `mean ${(c.meanConfidence * 100).toFixed(1)}%` },
      { name: 'Loop closure', pass: this.loopClosed && Math.abs(this.loopError) <= RULES.maxLoopErrorDeg, detail: this.loopClosed ? `${this.loopError >= 0 ? '+' : ''}${this.loopError.toFixed(2)}° residual` : 'not measured' },
      { name: 'No unresolved sectors', pass: weak.length === 0, detail: weak.length ? `${weak.length} sector${weak.length > 1 ? 's' : ''}` : 'none' }
    ];
    const passed = checks.filter(c2 => c2.pass).length;

    // A finished single lap is a real result and must not be graded the same as
    // a scan that fell apart. Both of these checks are now REACHABLE in one lap
    // — a bin that gathered enough tight looks verifies without a second pass —
    // but a lap that merely swept quickly will still miss them, and grading that
    // INSUFFICIENT would tell the operator their work was worthless when it is
    // usable and merely unconfirmed.
    const singlePassChecks = ['Every bin verified', 'Independent evidence per bin'];
    const structural = checks.filter(c2 => !singlePassChecks.includes(c2.name));
    const structuralPassed = structural.filter(c2 => c2.pass).length;
    const fullCircle = c.observedBins === BIN_COUNT;

    let grade = 'INSUFFICIENT';
    if (passed === checks.length) grade = 'EXCELLENT';
    else if (passed >= checks.length - 1) grade = 'GOOD';
    else if (fullCircle && structuralPassed === structural.length) grade = 'PROVISIONAL';
    else if (passed >= checks.length - 3) grade = 'MARGINAL';

    return {
      checks, grade, passed, total: checks.length, coverage: c, weak,
      singlePass: fullCircle && structuralPassed === structural.length,
      routes: {
        twoPass: this.bins.filter(b => b.route === 'two-pass').length,
        singleLap: this.bins.filter(b => b.route === 'single-lap').length,
        unverified: this.bins.filter(b => b.obs.length && !b.route).length,
        empty: this.bins.filter(b => !b.obs.length).length
      },
      note: grade === 'PROVISIONAL'
        ? 'One complete lap, every structural check passed. The bins that are still '
          + 'short need more looks, not another lap — slow down over them and let the '
          + 'observation count build. A second lap confirms from a different standing '
          + 'position, which costs the panorama some sharpness against nearby objects.'
        : null
    };
  }

  /* ---------------------------------------------------------------- editing */

  setAltitudeRange(fromIdx, toIdx, alt) {
    for (let i = fromIdx; i <= toIdx; i++) {
      const b = this.bins[((i % BIN_COUNT) + BIN_COUNT) % BIN_COUNT];
      b.alt = clamp(alt, 0, 90);
      b.manual = true;
      b.status = STATUS.WEAK;
      b.spread = 0;
    }
    this.manualEdits++;
  }

  /** Fill gaps no wider than maxGapDeg by interpolation; marks them as manual. */
  interpolateGaps(maxGapDeg = 3) {
    const maxGap = Math.round(maxGapDeg / BIN_STEP);
    let filled = 0;
    for (let i = 0; i < BIN_COUNT; i++) {
      if (Number.isFinite(this.bins[i].alt)) continue;
      let len = 0;
      while (len < maxGap && !Number.isFinite(this.bins[(i + len) % BIN_COUNT].alt)) len++;
      if (len === 0 || len > maxGap) continue;
      const a = this.bins[((i - 1) + BIN_COUNT) % BIN_COUNT].alt;
      const b = this.bins[(i + len) % BIN_COUNT].alt;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      for (let k = 0; k < len; k++) {
        const bin = this.bins[(i + k) % BIN_COUNT];
        bin.alt = a + (b - a) * ((k + 1) / (len + 1));
        bin.interpolated = true;
        bin.status = STATUS.WEAK;
        filled++;
      }
      i += len;
    }
    return filled;
  }

  altitudes() {
    return this.bins.map(b => Number.isFinite(b.alt) ? b.alt : NaN);
  }
}

/** Build the screen-frame orientation quaternion for a sample. */
export function orientationQuat(sample, screenAngleDeg, yawDatumDeg) {
  const q = screenQuat(sample.quat, screenAngleDeg);
  return yawDatumDeg ? quatMul(quatFromAxisAngle(0, 0, 1, -yawDatumDeg * DEG), q) : q;
}
