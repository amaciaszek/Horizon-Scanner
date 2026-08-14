'use strict';

/**
 * Measuring the lens, rather than assuming it.
 *
 * Every altitude this app reports is an angle read off a photograph, and the
 * conversion from pixels to angles is the focal length. Get it wrong and the
 * profile is wrong by that factor — and wrong by MORE toward the frame edges,
 * so the same skyline point seen twice disagrees with itself. That is what a
 * large "maximum spread" is made of. On 2026-08-13 the app was assuming a 66°
 * frame while the imagery and gyroscope agreed it spanned about 28°, and every
 * altitude was overstated roughly 2.6x.
 *
 * The measurement itself is the oldest trick there is. Rotate the camera by a
 * known angle and see how far the picture moved:
 *
 *     pixels = focal · tan(angle)
 *
 * What makes it trustworthy here is where the "known angle" comes from, and the
 * two axes get it from two different places on purpose:
 *
 *   HORIZONTAL — panning left and right, the angle comes from the gyroscope,
 *     which by this point has had its axes solved and its scale set.
 *   VERTICAL — tilting up and down, the angle comes from GRAVITY. Nothing in
 *     this app is more trustworthy than which way is down: it needs no
 *     calibration, cannot drift, and is unaffected by magnetic junk. Since
 *     altitude is the quantity the survey exists to report, measuring the
 *     vertical focal length directly against gravity — rather than deriving it
 *     from the horizontal and an assumed pixel aspect — puts the number that
 *     matters most on the firmest footing available.
 *
 * Both are fitted robustly, because a visual matcher occasionally locks onto
 * the wrong thing and one bad pair should not move the answer.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Angles too small are dominated by matcher noise; too large and the frames
 *  no longer overlap enough for the match to mean anything.
 *
 *  The lower bound has to respect the frame rate: a comfortable hand pan is
 *  20-40°/s, which at 30 fps is only 0.7-1.3° BETWEEN FRAMES, so a threshold
 *  set for the whole gesture rather than for one interval throws away almost
 *  everything. The minimum pixel shift below is the real guard against a
 *  poorly-conditioned pair, and it scales correctly with the lens: a wide lens
 *  simply has to be turned further to earn a sample. */
const MIN_ANGLE_DEG = 0.35;
const MAX_ANGLE_DEG = 9;
const MIN_SHIFT_PX = 2;
/**
 * Deliberately low, because match quality is a PROXY and this fit has a much
 * better arbiter available: the uncertainty of its own answer.
 *
 * Set at 0.45 this rejected 335 of about 440 frames during a field attempt —
 * the operator swept for a full minute and the measurement timed out with 20
 * pairs. That phone's matcher simply runs at 0.25-0.31, so the threshold was
 * unreachable and the step could never have succeeded on it. A weak match is
 * not a wrong match, only a noisier one, and noise is what the weighted median
 * and the uncertainty gate below are for.
 */
const MIN_QUALITY = 0.2;
/**
 * Enough pairs to be worth quoting, and an uncertainty small enough to adopt.
 *
 * The gate is on the uncertainty of the ESTIMATE, not on the scatter of the
 * individual pairs. Those are very different numbers: a 66° lens at 30 fps
 * moves the image only about 5 px between frames, so with sub-pixel matcher
 * noise each pair is individually good to maybe 8% — while the median of two
 * hundred such pairs is good to well under 1%. Gating on per-pair scatter
 * rejected perfectly sound measurements of ordinary lenses and accepted only
 * long ones, where the pixel shifts happen to be large.
 */
const READY_N = 45;
/**
 * 2%, not the 1.5% this started at. On a 50° lens 2% is about one degree,
 * which is nothing beside the discrepancies this exists to catch — and 1.5%
 * was an arbitrary round number that cost a real measurement: a field attempt
 * on 2026-08-14 converged to 0.0156 with 273 pan and 191 tilt pairs and was
 * thrown away entire, after the operator had swept for a full minute.
 */
const READY_UNCERTAINTY = 0.02;
/** On timeout, a measurement this good is still worth keeping rather than
 *  discarding a minute of the operator's effort and falling back to a guess. */
const SALVAGE_UNCERTAINTY = 0.04;

/** Weighted median of {v, w}, and the weighted interquartile half-spread. */
function robust(samples) {
  if (!samples.length) return { value: null, scatter: null };
  const s = samples.slice().sort((a, b) => a.v - b.v);
  const total = s.reduce((acc, x) => acc + x.w, 0);
  if (!(total > 0)) return { value: null, scatter: null };
  const at = f => {
    let acc = 0;
    for (const x of s) { acc += x.w; if (acc >= total * f) return x.v; }
    return s[s.length - 1].v;
  };
  const value = at(0.5);
  return { value, scatter: value > 0 ? (at(0.75) - at(0.25)) / 2 / value : null };
}

export class LensCalibrator {
  /** workW/workH: the frame the survey actually measures angles in. The video
   *  is cropped into it, so the lens that matters is this frame's, not the
   *  sensor's. */
  constructor(workW, workH) {
    this.workW = workW;
    this.workH = workH;
    this.reset();
  }

  reset() {
    this.pan = [];
    this.tilt = [];
    this.rejected = { angle: 0, shift: 0, quality: 0, absurd: 0 };
  }

  /**
   * One frame-to-frame pair from a horizontal pan.
   * dxPx        image shift, in WORKING-FRAME pixels
   * dYawDeg     rotation about world vertical over the same interval (gyro)
   * elevationDeg  how far the camera was tilted at the time
   */
  addPan({ dxPx, dYawDeg, elevationDeg = 0, quality = 1 }) {
    // A yaw rotation sweeps the image less when the camera is tilted, by the
    // cosine of the elevation. Keeping the test near level keeps this a small
    // correction rather than a load-bearing one.
    const eff = Math.abs(dYawDeg) * Math.cos(clampNum(elevationDeg, -60, 60) * DEG);
    return this._add(this.pan, Math.abs(dxPx), eff, quality, this.workW);
  }

  /**
   * One frame-to-frame pair from a vertical tilt.
   * dPitchDeg is the change in camera elevation, taken from gravity.
   */
  addTilt({ dyPx, dPitchDeg, quality = 1 }) {
    return this._add(this.tilt, Math.abs(dyPx), Math.abs(dPitchDeg), quality, this.workH);
  }

  _add(bucket, shiftPx, angleDeg, quality, extentPx) {
    if (!(quality >= MIN_QUALITY)) { this.rejected.quality++; return false; }
    if (!(angleDeg >= MIN_ANGLE_DEG && angleDeg <= MAX_ANGLE_DEG)) { this.rejected.angle++; return false; }
    const focal = shiftPx / Math.tan(angleDeg * DEG);
    // A focal length outside this range would mean a fisheye or a telescope;
    // either is a failed match, not a lens.
    if (!Number.isFinite(focal) || focal < extentPx * 0.15 || focal > extentPx * 20) {
      this.rejected.absurd++; return false;
    }
    // Larger rotations carry proportionally less matcher noise, so weight by
    // the angle as well as by the match quality.
    bucket.push({ v: focal, w: angleDeg * quality, angle: angleDeg });
    return true;
  }

  /**
   * Fit one axis, discarding pairs whose shift was too small to be worth
   * anything — judged by the shift the fit PREDICTS, never by the shift that
   * was measured.
   *
   * That distinction is the whole of this function. Cutting on the measured
   * shift keeps only those borderline pairs that noise happened to push above
   * the threshold, which biases the focal length upward and the field of view
   * down; on a wide lens, where most pairs sit near the boundary, it cost 3.3°
   * of a 95° measurement. Predicting the shift from a provisional fit breaks
   * that dependence, since the prediction does not know which way the noise on
   * that particular pair went.
   */
  _fit(bucket) {
    if (bucket.length < 8) return { value: null, scatter: null, used: 0 };
    const provisional = robust(bucket);
    if (!provisional.value) return { value: null, scatter: null, used: 0 };
    const kept = bucket.filter(s => provisional.value * Math.tan(s.angle * DEG) >= MIN_SHIFT_PX);
    if (kept.length < 8) return { ...provisional, used: bucket.length };
    return { ...robust(kept), used: kept.length };
  }

  /**
   * Current best estimate.
   *
   * `ready` means each axis has enough mutually-consistent pairs to be worth
   * adopting. `scatter` is the relative interquartile half-spread — roughly the
   * fractional uncertainty, so 0.03 is a 3% measurement.
   */
  result() {
    const h = this._fit(this.pan);
    const v = this._fit(this.tilt);
    // Standard error of a median, near enough: the per-pair spread divided by
    // the root of the count. This is the number worth showing an operator,
    // because it answers "how well do we know the field of view".
    const uncertainty = r => (r.scatter === null || !r.used) ? null : r.scatter / Math.sqrt(r.used);
    const uH = uncertainty(h), uV = uncertainty(v);
    const ok = (r, u) => r.value !== null && r.used >= READY_N && u !== null && u <= READY_UNCERTAINTY;
    const panReady = ok(h, uH);
    const tiltReady = ok(v, uV);
    return {
      focalH: h.value,
      focalV: v.value,
      scatterH: h.scatter,
      scatterV: v.scatter,
      uncertaintyH: uH,
      uncertaintyV: uV,
      nPan: h.used ?? this.pan.length,
      nTilt: v.used ?? this.tilt.length,
      hfovDeg: h.value ? 2 * Math.atan((this.workW / 2) / h.value) * RAD : null,
      vfovDeg: v.value ? 2 * Math.atan((this.workH / 2) / v.value) * RAD : null,
      panReady,
      tiltReady,
      ready: panReady && tiltReady,
      // Good enough to adopt if time runs out, though not good enough to stop
      // early for. Reported separately so the caller decides, not this class.
      salvageable: h.value !== null && v.value !== null
        && h.used >= READY_N && v.used >= READY_N
        && uH !== null && uV !== null
        && uH <= SALVAGE_UNCERTAINTY && uV <= SALVAGE_UNCERTAINTY,
      // Focal length in pixels is the SAME number for both axes on a
      // square-pixel sensor — tanHalfH = (W/2)/f and tanHalfV = (H/2)/f share
      // that f. So this ratio is an independent check on the whole
      // measurement, not just a curiosity: near 1 says the two halves, taken
      // against two different sensors, agree about the same lens. Far from 1
      // says either the pixels are not square after the crop, or one of the
      // halves is wrong — and the scatter figures say which.
      squarePixelRatio: (h.value && v.value) ? v.value / h.value : null,
      rejected: { ...this.rejected }
    };
  }
}

function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
