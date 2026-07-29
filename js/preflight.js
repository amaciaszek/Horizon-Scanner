'use strict';
import { wrap360, angDiff, clamp, circMean } from './math3d.js';

/**
 * Pre-flight sweep.
 *
 * This is a compass swing, the same procedure a ship's compass gets on a
 * swinging berth: turn through known headings and record what the compass says
 * against a reference that does not care about magnetism. Here the reference is
 * the fused visual + inertial rotation, which is the app's primary source of
 * relative motion anyway.
 *
 * The point is NOT to correct the compass. A figure-8 gesture calibrates hard
 * and soft iron — a constant bias and a fixed distortion in the DEVICE frame —
 * and that is the one error this design already discards, because the mount
 * supplies real azimuth afterwards. It is also uncorrectable in the case that
 * matters most: a phone standing beside a steel tripod sits in a distortion
 * fixed in the WORLD frame, which changes as the phone moves through it and
 * which no device-frame calibration can model. The browser cannot trigger the
 * platform's magnetometer calibration or read whether it converged, so a
 * gesture sold as "calibration" would be an unverifiable ritual.
 *
 * So this measures instead. It returns a number and a verdict, and the survey
 * is never blocked on either.
 *
 * The same gesture supplies the focal-length solve — pixel shift against
 * measured rotation — because that needs exactly the same motion over exactly
 * the same kind of textured scene.
 */

export const VERDICT = {
  ABSENT: 'absent',
  INCONCLUSIVE: 'inconclusive',
  GOOD: 'good',
  FAIR: 'fair',
  DEAD: 'dead'
};

/** Minimum arc before any verdict is offered. Below this the sweep has not
 *  visited enough of the field to distinguish distortion from noise. */
export const MIN_SWEEP_DEG = 60;

const SWING_BINS = 12;               // 30° per bin

function percentile(sorted, f) {
  if (!sorted.length) return 0;
  const i = clamp(Math.floor(f * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[i];
}

export class PreflightSweep {
  constructor() { this.reset(); }

  reset() {
    this.active = false;
    this.samples = [];       // {heading, residual, jitter, quality}
    this.minYaw = Infinity;
    this.maxYaw = -Infinity;
    this.hasCompass = false;
    this.startedAt = 0;
  }

  start() {
    this.reset();
    this.active = true;
    this.startedAt = Date.now();
  }

  stop() { this.active = false; }

  /**
   * @param compass   compass heading in degrees, or null when unavailable
   * @param integrated  fused visual+inertial yaw, monotonic, any datum
   * @param jitter    residual orientation scatter, degrees
   * @param quality   visual registration quality 0..1
   */
  add({ compass, integrated, jitter = 0, quality = 0 }) {
    if (!this.active || !Number.isFinite(integrated)) return;
    if (integrated < this.minYaw) this.minYaw = integrated;
    if (integrated > this.maxYaw) this.maxYaw = integrated;
    if (!Number.isFinite(compass)) return;
    this.hasCompass = true;
    // Residual against an arbitrary datum; the datum falls out in result().
    this.samples.push({
      heading: wrap360(integrated),
      residual: angDiff(compass, integrated),
      jitter, quality
    });
    if (this.samples.length > 4000) this.samples.splice(0, 1000);
  }

  get sweepDeg() {
    return this.maxYaw === -Infinity ? 0 : this.maxYaw - this.minYaw;
  }

  /**
   * Deviation is the SPREAD of the compass-minus-reference residual across
   * headings, not its mean. A constant offset is just the datum and is
   * harmless. A residual that swings as you turn is magnetic distortion, and
   * that is what rotates parts of the profile relative to others.
   */
  result() {
    const sweep = this.sweepDeg;
    const n = this.samples.length;

    if (!this.hasCompass) {
      return { verdict: VERDICT.ABSENT, sweepDeg: sweep, n, deviationDeg: null, meanJitter: this._meanJitter(),
        summary: 'No compass readings were offered by this browser. Azimuth will be relative; set the offset from mount calibration.' };
    }
    if (sweep < MIN_SWEEP_DEG || n < 40) {
      return { verdict: VERDICT.INCONCLUSIVE, sweepDeg: sweep, n, deviationDeg: null, meanJitter: this._meanJitter(),
        summary: `Only ${sweep.toFixed(0)}° swept over ${n} sample(s). Turn through at least ${MIN_SWEEP_DEG}° so the compass is seen from enough directions to tell distortion from noise.` };
    }

    const centre = circMean(this.samples.map(s => s.residual));
    const centred = this.samples.map(s => angDiff(s.residual, centre)).sort((a, b) => a - b);
    // 5th-95th percentile span, so one bad frame cannot set the verdict.
    const deviation = percentile(centred, 0.95) - percentile(centred, 0.05);

    const verdict = deviation < 5 ? VERDICT.GOOD
      : deviation < 15 ? VERDICT.FAIR
        : VERDICT.DEAD;

    const summary = verdict === VERDICT.GOOD
      ? `Compass agrees with measured rotation to within ${deviation.toFixed(1)}° across ${sweep.toFixed(0)}°. Usable as an absolute datum.`
      : verdict === VERDICT.FAIR
        ? `Compass swings by ${deviation.toFixed(1)}° across ${sweep.toFixed(0)}°. Usable only as a rough starting azimuth; expect to correct it from the mount.`
        : `Compass swings by ${deviation.toFixed(1)}° across ${sweep.toFixed(0)}°. That is worse than having no compass at all, because it varies with direction rather than offsetting the whole profile. Surveying on a relative datum instead.`;

    return {
      verdict, sweepDeg: sweep, n,
      deviationDeg: deviation,
      offsetDeg: centre,
      meanJitter: this._meanJitter(),
      swingTable: this._swingTable(centre),
      summary
    };
  }

  _meanJitter() {
    if (!this.samples.length) return 0;
    return this.samples.reduce((a, s) => a + s.jitter, 0) / this.samples.length;
  }

  /**
   * Residual per 30° of heading. A residual that varies smoothly with direction
   * is iron distortion; one that scatters without pattern is noise. The
   * distinction changes what the operator should do — move the phone, versus
   * accept that this site has no usable compass.
   */
  _swingTable(centre) {
    const sums = new Float64Array(SWING_BINS);
    const counts = new Int32Array(SWING_BINS);
    for (const s of this.samples) {
      const b = Math.min(SWING_BINS - 1, Math.floor(s.heading / (360 / SWING_BINS)));
      sums[b] += angDiff(s.residual, centre);
      counts[b]++;
    }
    const out = [];
    for (let b = 0; b < SWING_BINS; b++) {
      out.push({
        fromDeg: b * (360 / SWING_BINS),
        n: counts[b],
        residualDeg: counts[b] ? sums[b] / counts[b] : null
      });
    }
    return out;
  }
}
