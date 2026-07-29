'use strict';
import {
  quatFromEuler, quatNormalize, wrap360, angDiff, clamp, circMean,
  screenQuat, quatRotate, vecToAzAlt, DEG, RAD
} from './math3d.js';

/**
 * Orientation source.
 *
 * The device orientation stream provides the rotation structure. The compass is
 * treated as a separate, suspect input: it only ever supplies a slowly-updated
 * absolute yaw datum, and it is dropped entirely when its short-term behaviour
 * disagrees with the integrated rotation. Visual registration (elsewhere) is the
 * arbiter of relative motion.
 */
const MOTION_WINDOW_MS = 450;

/** Least-squares slope of `key` against time, in units per second. */
function slope(pts, tKey, key) {
  const n = pts.length;
  let st = 0, sv = 0;
  for (const p of pts) { st += p[tKey]; sv += p[key]; }
  const mt = st / n, mv = sv / n;
  let num = 0, den = 0;
  for (const p of pts) { const dt = p[tKey] - mt; num += dt * (p[key] - mv); den += dt * dt; }
  return den === 0 ? 0 : (num / den) * 1000;
}

/** Peak-to-peak scatter about the fitted line, in degrees. */
function residualSpread(pts, key, ratePerSec) {
  const t0 = pts[0].t, v0 = pts[0][key];
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    const r = p[key] - (v0 + ratePerSec * (p.t - t0) / 1000);
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  return hi - lo;
}

export class OrientationSource {
  constructor(log) {
    this.log = log || (() => {});
    this.quat = quatFromEuler(0, 0, 0);
    this.alpha = null; this.beta = 0; this.gamma = 0;
    this.absolute = false;
    this.compassHeading = null;
    this.hasCompass = false;
    this.screenAngle = 0;
    this.lastEventAt = 0;
    this.eventRate = 0;
    this._rateWindow = [];

    // Yaw datum: maps the alpha-derived yaw onto true azimuth.
    this.yawDatum = 0;
    this.datumLocked = false;
    this._datumSamples = [];

    // Compass reliability
    this.compassChecks = 0;
    this.compassRejects = 0;
    this.compassReliability = 'unknown';
    this._lastCompass = null;
    this._lastAlpha = null;

    // Motion
    this.rotationRate = 0;      // deg/s about the vertical
    this.tiltRate = 0;
    this._prevYaw = null;
    this._prevPitch = null;
    this._lastYaw = null;
    this._motion = [];            // {t, y (unwrapped yaw), p (pitch)}
    this._yawUnwrapped = null;
    this._prevWrapped = 0;
    this.jitterDeg = 0;           // residual sensor scatter, deg
    this.eventDt = 0;
    this._prevAt = 0;
    this.stillness = 0;

    this._onOrientation = this._onOrientation.bind(this);
    this._onScreen = this._onScreen.bind(this);
  }

  static needsPermission() {
    return typeof DeviceOrientationEvent !== 'undefined'
      && typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  async start() {
    if (typeof DeviceOrientationEvent === 'undefined') {
      throw new Error('This browser does not report device orientation. Use a phone over HTTPS.');
    }
    if (OrientationSource.needsPermission()) {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result !== 'granted') throw new Error('Motion and orientation access was declined. Enable it in Settings > Safari > Motion & Orientation Access, then reload.');
    }
    window.addEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.addEventListener('deviceorientation', this._onOrientation, true);
    this._onScreen();
    if (screen.orientation) screen.orientation.addEventListener('change', this._onScreen);
    window.addEventListener('orientationchange', this._onScreen);
    await new Promise(r => setTimeout(r, 400));
    if (!this.lastEventAt) this.log('warn', 'No orientation events received yet. On desktop this is expected.');
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    if (screen.orientation) screen.orientation.removeEventListener('change', this._onScreen);
    window.removeEventListener('orientationchange', this._onScreen);
  }

  _onScreen() {
    this.screenAngle = (screen.orientation && Number.isFinite(screen.orientation.angle))
      ? screen.orientation.angle
      : (Number(window.orientation) || 0);
  }

  _onOrientation(e) {
    const now = performance.now();
    if (!Number.isFinite(e.alpha) && !Number.isFinite(e.beta)) return;

    this._rateWindow.push(now);
    while (this._rateWindow.length && now - this._rateWindow[0] > 1000) this._rateWindow.shift();
    this.eventRate = this._rateWindow.length;

    this.alpha = Number.isFinite(e.alpha) ? e.alpha : this.alpha;
    this.beta = Number.isFinite(e.beta) ? e.beta : this.beta;
    this.gamma = Number.isFinite(e.gamma) ? e.gamma : this.gamma;
    this.absolute = this.absolute || !!e.absolute;
    this.quat = quatNormalize(quatFromEuler(this.alpha || 0, this.beta, this.gamma));

    if (Number.isFinite(e.webkitCompassHeading)) {
      this.hasCompass = true;
      this.compassHeading = e.webkitCompassHeading;
      if (Number.isFinite(e.webkitCompassAccuracy) && e.webkitCompassAccuracy < 0) {
        this.compassReliability = 'poor';
      }
    } else if (e.absolute && Number.isFinite(e.alpha)) {
      this.hasCompass = true;
      this.compassHeading = wrap360(360 - e.alpha);
    }

    this._trackMotion(now);
    this._auditCompass();
    this.lastEventAt = now;
  }

  /**
   * Yaw implied by the orientation stream, before the datum is applied.
   *
   * This must NOT read `alpha` directly. The DeviceOrientation ZXY Euler
   * decomposition is singular at beta = ±90°, which is exactly the pose this
   * app is used in — phone upright, camera at the skyline. At that pose two
   * different (alpha, beta, gamma) triples describe the same physical
   * orientation, and the browser is free to report either one frame to frame.
   * The pair (30, 88, -3.4) and (210, 92, 176.6) are the same pose; alpha-derived
   * yaw differs between them by 180°.
   *
   * The quaternion rebuilt from all three angles is continuous across that
   * alias, so the azimuth of the camera forward axis is stable where alpha is
   * not. Same convention as the old scalar — alpha = 0 still yields yaw 0 —
   * so datums and keyframes recorded either way remain comparable.
   */
  rawYaw() {
    // The forward axis lies along device Z, so the screen rotation (also about
    // device Z) leaves it unchanged and does not need to be applied here.
    const fwd = quatRotate(this.quat, [0, 0, -1]);
    const horiz = Math.hypot(fwd[0], fwd[1]);
    // Within ~8° of zenith or nadir the azimuth of the forward axis is not
    // meaningful. Hold the last good value rather than emitting noise.
    if (horiz < 0.14) return this._lastYaw ?? 0;
    this._lastYaw = vecToAzAlt(fwd).az;
    return this._lastYaw;
  }

  /** Camera-axis elevation and screen roll, both derived from the same
   *  quaternion the projection uses rather than from beta/gamma directly. */
  attitude() {
    const q = screenQuat(this.quat, this.screenAngle);
    const fwd = quatRotate(q, [0, 0, -1]);
    const right = quatRotate(q, [1, 0, 0]);
    const elevation = Math.asin(clamp(fwd[2], -1, 1)) * RAD;
    // Roll: how far the screen's right axis is tipped out of the horizontal.
    const roll = Math.asin(clamp(right[2], -1, 1)) * RAD;
    return { elevation, roll, forward: fwd };
  }

  /**
   * Rotation rate and stillness, measured over a window rather than between
   * consecutive samples.
   *
   * Differentiating two samples 20 ms apart amplifies sensor noise by 50x: a
   * phone clamped to a tripod, with elevation and roll reading dead steady,
   * still produced 44.7 deg/s of apparent turn because the magnetometer-derived
   * yaw jitters by about a degree and dt is tiny. Nothing about that number was
   * motion, but it held the stillness gate at zero and calibration never
   * finished.
   *
   * A least-squares slope over a ~450 ms window divides that noise by both a
   * much larger time base and the square root of the sample count, taking the
   * residual rate error to roughly 1 deg/s. The measured jitter is kept
   * separately so the operator can be told that the problem is the sensor and
   * not their hands.
   */
  _trackMotion(now) {
    const yaw = this.rawYaw();
    const pitch = this.attitude().elevation;

    // Unwrap into a continuous track so the window can be fitted across 0/360.
    if (this._yawUnwrapped === null) this._yawUnwrapped = yaw;
    else this._yawUnwrapped += angDiff(yaw, this._prevWrapped);
    this._prevWrapped = yaw;

    this._motion.push({ t: now, y: this._yawUnwrapped, p: pitch });
    while (this._motion.length > 2 && now - this._motion[0].t > MOTION_WINDOW_MS) this._motion.shift();
    if (this._motion.length < 5) return;

    const span = (this._motion[this._motion.length - 1].t - this._motion[0].t) / 1000;
    if (span < 0.2) return;

    this.rotationRate = slope(this._motion, 't', 'y');
    this.tiltRate = slope(this._motion, 't', 'p');

    // Jitter is the residual scatter about those fitted lines: what the sensor
    // is doing that is not steady rotation.
    this.jitterDeg = Math.max(residualSpread(this._motion, 'y', this.rotationRate),
      residualSpread(this._motion, 'p', this.tiltRate));

    const speed = Math.hypot(this.rotationRate, this.tiltRate);
    this.stillness = clamp(1 - speed / 6, 0, 1);
    this.eventDt = span / (this._motion.length - 1);
  }

  /**
   * Compare short-term compass change against short-term orientation change.
   * Magnetic interference shows up as the compass moving when the device is not,
   * or moving by a different amount than the rotation stream reports.
   */
  _auditCompass() {
    if (this.compassHeading === null) return;
    if (this._lastCompass === null || this._lastAlpha === null) {
      this._lastCompass = this.compassHeading;
      this._lastAlpha = this.rawYaw();
      return;
    }
    const dC = angDiff(this.compassHeading, this._lastCompass);
    const dA = angDiff(this.rawYaw(), this._lastAlpha);
    if (Math.abs(dC) > 1.0 || Math.abs(dA) > 1.0) {
      this.compassChecks++;
      const disagreement = Math.abs(dC - dA);
      if (disagreement > Math.max(4, Math.abs(dA) * 0.45)) this.compassRejects++;
      this._lastCompass = this.compassHeading;
      this._lastAlpha = this.rawYaw();
    }
    if (this.compassChecks >= 20) {
      const rate = this.compassRejects / this.compassChecks;
      this.compassReliability = rate > 0.35 ? 'poor' : rate > 0.15 ? 'fair' : 'good';
    }
  }

  /** Collect compass observations to fix the absolute yaw datum once. */
  sampleDatum() {
    if (this.compassHeading === null) return;
    this._datumSamples.push(wrap360(this.compassHeading - this.rawYaw()));
    if (this._datumSamples.length > 80) this._datumSamples.shift();
  }

  lockDatum() {
    if (!this._datumSamples.length) {
      this.yawDatum = 0;
      this.datumLocked = false;
      this.log('warn', 'No compass samples. Azimuth is relative; set the offset after mount calibration.');
      return false;
    }
    this.yawDatum = circMean(this._datumSamples);
    this.datumLocked = true;
    const spread = this._datumSamples.reduce((m, s) => Math.max(m, Math.abs(angDiff(s, this.yawDatum))), 0);
    this.log('info', `Yaw datum locked at ${this.yawDatum.toFixed(1)}° from ${this._datumSamples.length} compass samples, spread ${spread.toFixed(1)}°.`);
    if (spread > 12) this.compassReliability = 'poor';
    return true;
  }

  /** Azimuth the rear camera is pointing at, using the current datum. */
  headingEstimate() {
    return wrap360(this.rawYaw() + this.yawDatum);
  }

  health() {
    return {
      eventRate: this.eventRate,
      absolute: this.absolute,
      hasCompass: this.hasCompass,
      compassReliability: this.compassReliability,
      compassRejects: this.compassRejects,
      compassChecks: this.compassChecks,
      gyroReliability: this.eventRate >= 25 ? 'good' : this.eventRate >= 10 ? 'fair' : 'poor',
      screenAngle: this.screenAngle,
      jitterDeg: Number(this.jitterDeg.toFixed(2)),
      sampleIntervalMs: Math.round(this.eventDt * 1000)
    };
  }
}
