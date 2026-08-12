'use strict';
import {
  quatFromEuler, quatNormalize, wrap360, angDiff, clamp, circMean,
  screenQuat, quatRotate, quatConj, vecToAzAlt, DEG, RAD
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
    this.motionSource = 'orientation';

    // Raw gyroscope, from devicemotion. Separate from everything above,
    // because deviceorientationabsolute fuses the magnetometer and is therefore
    // useless for relative rotation in a magnetically disturbed spot — which is
    // most back yards, with gutters, wiring, cars, and a steel mount head.
    // The gyroscope has bias drift and no absolute reference, and drift is what
    // loop closure already exists to remove. Interference is not.
    this.gyroAvailable = false;
    this.gyroYaw = 0;             // integrated, unwrapped, arbitrary datum
    this.gyroYawRate = 0;         // deg/s about world vertical
    this.gyroSamples = 0;
    this.gyroBias = [0, 0, 0];   // device x/y/z bias, deg/s
    this.gyroScale = 1;           // conservative scale from a declared full turn
    // Signed axis permutation applied to rotationRate AFTER bias subtraction.
    // Some devices report rotationRate components transposed relative to their
    // own orientation frame (observed in the field: a flat spin landing on the
    // y gyro axis, an upright spin on z). null means identity — trust the spec.
    this.gyroAxisMap = null;      // { perm:[i,i,i], signs:[±1,±1,±1], residualDeg }
    this.lastGravity = null;
    this._lastMotionAt = 0;
    this._onMotion = this._onMotion.bind(this);
    this.eventDt = 0;
    this._prevAt = 0;
    this.stillness = 0;

    // Reproducible startup diagnostics. Raw samples are retained only for the
    // short calibration window; summaries remain available to logs/archives.
    this.stationaryDiagnostic = null;
    this.spinDiagnostic = null;
    this.flatSpinDiagnostic = null;
    this.uprightSpinDiagnostic = null;
    this._stationarySamples = [];
    this._stationaryActive = false;
    this._spinActive = false;
    this._spinStart = null;
    this._spinFlat = [];
    this._spinTrace = null;
    this._spinKind = 'flat';
    this.sensorSource = 'none';
    this._genericSensors = [];

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
    // Invoke both permission requests synchronously inside the original button
    // gesture. Awaiting one before asking for the other can consume iOS's user
    // activation and leave devicemotion silently unavailable.
    const permissionRequests = [];
    if (OrientationSource.needsPermission()) {
      permissionRequests.push(DeviceOrientationEvent.requestPermission().then(result => ['orientation', result]));
    }
    if (typeof DeviceMotionEvent !== 'undefined'
        && typeof DeviceMotionEvent.requestPermission === 'function') {
      permissionRequests.push(DeviceMotionEvent.requestPermission().then(result => ['motion', result]));
    }
    const permissions = await Promise.all(permissionRequests);
    const declined = permissions.find(([, result]) => result !== 'granted');
    if (declined) throw new Error(`${declined[0] === 'motion' ? 'Gyroscope' : 'Motion and orientation'} access was declined. Enable Motion & Orientation Access, then reload.`);
    window.addEventListener('devicemotion', this._onMotion, true);
    window.addEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.addEventListener('deviceorientation', this._onOrientation, true);
    this._onScreen();
    if (screen.orientation) screen.orientation.addEventListener('change', this._onScreen);
    window.addEventListener('orientationchange', this._onScreen);
    await new Promise(r => setTimeout(r, 650));
    if (!this.lastEventAt && this.gyroSamples === 0) {
      this.log('warn', 'Legacy motion events delivered no samples. Trying the Generic Sensor API fallback.');
      await this._startGenericSensors();
      await new Promise(r => setTimeout(r, 650));
    }
    if (!this.lastEventAt && this.gyroSamples === 0) {
      const availability = {
        DeviceOrientationEvent: typeof DeviceOrientationEvent !== 'undefined',
        DeviceMotionEvent: typeof DeviceMotionEvent !== 'undefined',
        Gyroscope: typeof Gyroscope !== 'undefined',
        Accelerometer: typeof Accelerometer !== 'undefined',
        AbsoluteOrientationSensor: typeof AbsoluteOrientationSensor !== 'undefined',
        RelativeOrientationSensor: typeof RelativeOrientationSensor !== 'undefined'
      };
      this.log('error', 'NO_MOTION_SENSORS', JSON.stringify(availability),
        'Chrome supplied neither legacy events nor Generic Sensor readings. Check Chrome > Settings > Site settings > Motion sensors, Android sensor privacy, and Permissions-Policy headers.');
    }
  }

  stop() {
    window.removeEventListener('devicemotion', this._onMotion, true);
    window.removeEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    if (screen.orientation) screen.orientation.removeEventListener('change', this._onScreen);
    window.removeEventListener('orientationchange', this._onScreen);
    for (const sensor of this._genericSensors) {
      try { sensor.stop(); } catch (_) { /* optional sensor */ }
    }
    this._genericSensors = [];
  }

  async _permissionState(name) {
    try {
      const status = await navigator.permissions?.query({ name });
      return status?.state || 'unknown';
    } catch (_) {
      return 'unsupported';
    }
  }

  async _startGenericSensors() {
    const permissionStates = {};
    for (const name of ['accelerometer', 'gyroscope', 'magnetometer']) {
      permissionStates[name] = await this._permissionState(name);
    }
    this.log('info', 'GENERIC_SENSOR_PERMISSIONS', JSON.stringify(permissionStates));

    const startSensor = (sensor, name) => {
      sensor.addEventListener('error', event => {
        this.log('error', `Generic ${name} failed:`, event.error?.name || 'Error', event.error?.message || '');
      });
      sensor.start();
      this._genericSensors.push(sensor);
      this.log('info', `Generic ${name} requested.`);
      return sensor;
    };

    try {
      if (typeof Accelerometer !== 'undefined') {
        const accel = startSensor(new Accelerometer({ frequency: 60 }), 'accelerometer');
        accel.addEventListener('reading', () => {
          this.lastGravity = [accel.x || 0, accel.y || 0, accel.z || 0];
        });
      }
    } catch (error) {
      this.log('error', 'Could not start Generic accelerometer:', error.name, error.message);
    }

    try {
      if (typeof Gyroscope !== 'undefined') {
        const gyro = startSensor(new Gyroscope({ frequency: 60 }), 'gyroscope');
        gyro.addEventListener('reading', () => {
          this._onMotion({
            timeStamp: gyro.timestamp || performance.now(),
            rotationRate: {
              beta: (gyro.x || 0) * RAD,
              gamma: (gyro.y || 0) * RAD,
              alpha: (gyro.z || 0) * RAD
            },
            accelerationIncludingGravity: this.lastGravity
              ? { x: this.lastGravity[0], y: this.lastGravity[1], z: this.lastGravity[2] }
              : null
          });
          this.sensorSource = 'generic-sensor';
        });
      }
    } catch (error) {
      this.log('error', 'Could not start Generic gyroscope:', error.name, error.message);
    }

    const OrientationCtor = typeof AbsoluteOrientationSensor !== 'undefined'
      ? AbsoluteOrientationSensor
      : (typeof RelativeOrientationSensor !== 'undefined' ? RelativeOrientationSensor : null);
    if (OrientationCtor) {
      try {
        const isAbsolute = typeof AbsoluteOrientationSensor !== 'undefined'
          && OrientationCtor === AbsoluteOrientationSensor;
        const name = isAbsolute ? 'absolute orientation' : 'relative orientation';
        const sensor = startSensor(new OrientationCtor({ frequency: 60, referenceFrame: 'device' }), name);
        sensor.addEventListener('reading', () => {
          const q = sensor.quaternion;
          if (!q || q.length !== 4) return;
          // Generic Sensor quaternions are [x,y,z,w]; this project uses [w,x,y,z].
          this.quat = quatNormalize([q[3], q[0], q[1], q[2]]);
          const now = sensor.timestamp || performance.now();
          this._rateWindow.push(now);
          while (this._rateWindow.length && now - this._rateWindow[0] > 1000) this._rateWindow.shift();
          this.eventRate = this._rateWindow.length;
          this.lastEventAt = now;
          this.absolute = isAbsolute;
          this.sensorSource = 'generic-sensor';
          this._trackMotion(now);
        });
      } catch (error) {
        this.log('error', 'Could not start Generic orientation sensor:', error.name, error.message);
      }
    }
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
    this.sensorSource = 'legacy-events';
    this.quat = quatNormalize(quatFromEuler(this.alpha || 0, this.beta, this.gamma));

    if (this._spinActive && this._spinTrace && Number.isFinite(e.alpha)) {
      if (this._spinTrace.lastAlpha !== null) {
        this._spinTrace.orientationAlphaTravel += angDiff(e.alpha, this._spinTrace.lastAlpha);
      }
      this._spinTrace.lastAlpha = e.alpha;
    }

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
   * Integrate the raw gyroscope into a yaw that no magnet can touch.
   *
   * DeviceMotionEvent.rotationRate is the gyroscope alone: alpha about device
   * z, beta about x, gamma about y, in deg/s. What the survey needs is rotation
   * about the WORLD vertical, so the angular velocity vector is projected onto
   * the up direction expressed in the device frame.
   *
   * Sign: azimuth increases clockwise seen from above, which is the negative
   * sense of a right-handed rotation about up, hence the minus.
   *
   * This drifts. That is fine and expected — drift is exactly what loop closure
   * was built to distribute, and a slow bias is recoverable in a way that a
   * magnetometer swinging by 69 degrees is not.
   */
  _onMotion(e) {
    const r = e.rotationRate;
    if (!r || r.alpha === null || r.alpha === undefined) return;
    const now = e.timeStamp || performance.now();
    const dt = this._lastMotionAt ? (now - this._lastMotionAt) / 1000 : 0;
    this._lastMotionAt = now;
    if (!(dt > 0 && dt < 0.5)) {
      if (this._spinActive && this._spinTrace) this._spinTrace.rejectedDt++;
      return;
    }

    // Angular velocity in the device frame, deg/s. Keep the uncorrected values
    // for stationary noise measurement, then remove the measured device-frame
    // bias before projecting onto world vertical.
    const rawW = [r.beta || 0, r.gamma || 0, r.alpha || 0];
    const g = e.accelerationIncludingGravity;
    const gravity = g ? [g.x || 0, g.y || 0, g.z || 0] : null;
    if (gravity) this.lastGravity = gravity;
    if (this._stationaryActive && this._stationarySamples.length < 1200) {
      const att = this.attitude();
      this._stationarySamples.push({
        t: now, w: rawW.slice(), g: gravity,
        alpha: this.alpha, beta: this.beta, gamma: this.gamma,
        elevation: att.elevation, roll: att.roll
      });
    }
    let w = rawW.map((v, i) => v - this.gyroBias[i]);
    if (this.gyroAxisMap) {
      const m = this.gyroAxisMap;
      w = [m.signs[0] * w[m.perm[0]], m.signs[1] * w[m.perm[1]], m.signs[2] * w[m.perm[2]]];
    }
    // World up, expressed in the device frame.
    const up = quatRotate(quatConj(this.quat), [0, 0, 1]);
    this.gyroYawRate = -(w[0] * up[0] + w[1] * up[1] + w[2] * up[2]) * this.gyroScale;
    this.gyroYaw += this.gyroYawRate * dt;
    this.gyroSamples++;
    if (this._spinActive && this._spinTrace) {
      const tr = this._spinTrace;
      const delta = this.gyroYawRate * dt;
      tr.acceptedDt++;
      tr.elapsedIntegratedSec += dt;
      tr.projectedSignedDeg += delta;
      tr.projectedAbsoluteDeg += Math.abs(delta);
      if (delta >= 0) tr.projectedPositiveDeg += delta;
      else tr.projectedNegativeDeg += delta;
      for (let i = 0; i < 3; i++) {
        tr.rawAxisSignedDeg[i] += w[i] * dt;
        tr.rawAxisAbsoluteDeg[i] += Math.abs(w[i] * dt);
      }
      tr.rateMin = Math.min(tr.rateMin, this.gyroYawRate);
      tr.rateMax = Math.max(tr.rateMax, this.gyroYawRate);
    }
    if (this._spinActive && gravity) {
      const mag = Math.hypot(...gravity);
      if (mag > 1) this._spinFlat.push(Math.acos(clamp(Math.abs(gravity[2]) / mag, -1, 1)) * RAD);
      if (mag > 1 && this._spinTrace) {
        // Mean gravity over the spin is the world-vertical in the device frame,
        // which is what the axis-map solver aligns the integrated turn against.
        for (let i = 0; i < 3; i++) this._spinTrace.gravitySum[i] += gravity[i] / mag;
        this._spinTrace.gravityN++;
      }
    }
    if (this.gyroSamples > 20 && !this.gyroAvailable) {
      this.gyroAvailable = true;
      if (this.log) this.log('info', 'Gyroscope samples are arriving via devicemotion. Rotation scale and sign are not trusted until the physical 360° test passes.');
    }
  }

  beginStationaryDiagnostic() {
    this._stationarySamples = [];
    this._stationaryActive = true;
    this.stationaryDiagnostic = null;
    // Do not carry an old correction into a new measurement.
    this.gyroBias = [0, 0, 0];
    this.gyroScale = 1;
  }

  get stationarySampleCount() {
    return this._stationarySamples.length;
  }

  screenFlatnessDeg() {
    if (!this.lastGravity) return null;
    const mag = Math.hypot(...this.lastGravity);
    return mag > 1 ? Math.acos(clamp(Math.abs(this.lastGravity[2]) / mag, -1, 1)) * RAD : null;
  }

  finishStationaryDiagnostic() {
    this._stationaryActive = false;
    const samples = this._stationarySamples;
    const stats = values => {
      const finite = values.filter(Number.isFinite);
      if (!finite.length) return { mean: null, std: null, p2p: null };
      const mean = finite.reduce((a, v) => a + v, 0) / finite.length;
      const variance = finite.reduce((a, v) => a + (v - mean) ** 2, 0) / finite.length;
      return { mean, std: Math.sqrt(variance), p2p: Math.max(...finite) - Math.min(...finite) };
    };
    const axes = [0, 1, 2].map(i => stats(samples.map(s => s.w[i])));
    const gravityAxes = [0, 1, 2].map(i => stats(samples.map(s => s.g?.[i])));
    const gravityMagnitude = stats(samples.map(s => s.g ? Math.hypot(...s.g) : null));
    const flatness = stats(samples.map(s => {
      if (!s.g) return null;
      const mag = Math.hypot(...s.g);
      return mag > 1 ? Math.acos(clamp(Math.abs(s.g[2]) / mag, -1, 1)) * RAD : null;
    }));
    const elevation = stats(samples.map(s => s.elevation));
    const roll = stats(samples.map(s => s.roll));
    const durationMs = samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0;
    const enough = samples.length >= 40 && durationMs >= 2000;
    // A bias is only a bias if it was measured on a phone that was actually
    // still. Field case: a handheld "stationary" test read 8.6°/s mean with
    // 25-31°/s of noise — hand tremor, not sensor bias — and subtracting it
    // corrupted every rotation for the rest of the session. Real MEMS bias is
    // under ~1°/s with noise well under 6°/s, so anything beyond that is the
    // operator moving, and applying zero bias is strictly safer.
    const noise = Math.max(...axes.map(a => a.std ?? Infinity));
    const biasMag = Math.max(...axes.map(a => Math.abs(a.mean ?? 0)));
    const wobble = flatness.std ?? Infinity;
    const still = noise < 6 && wobble < 4;
    const plausible = biasMag < 3;
    const biasApplied = enough && still && plausible;
    const biasRefusedReason = biasApplied ? null
      : !enough ? 'too-few-samples'
        : !still ? `not-still (gyro noise ${noise.toFixed(1)}°/s, pose wobble ${wobble.toFixed(1)}°)`
          : `implausible-bias (${biasMag.toFixed(1)}°/s)`;
    if (biasApplied) this.gyroBias = axes.map(a => a.mean || 0);
    this.stationaryDiagnostic = {
      samples: samples.length,
      durationMs,
      sampleRateHz: durationMs > 0 ? (samples.length - 1) * 1000 / durationMs : 0,
      gyroAxes: { x: axes[0], y: axes[1], z: axes[2] },
      gravityAxes: { x: gravityAxes[0], y: gravityAxes[1], z: gravityAxes[2] },
      gravityMagnitude,
      screenFlatnessDeg: flatness,
      orientationElevationDeg: elevation,
      orientationRollDeg: roll,
      biasApplied,
      biasRefusedReason
    };
    return this.stationaryDiagnostic;
  }

  beginSpinDiagnostic(kind = 'flat') {
    this._spinActive = true;
    this._spinKind = kind;
    this._spinFlat = [];
    this._spinStart = {
      t: performance.now(),
      gyroYaw: this.gyroYaw,
      compass: this.compassHeading,
      orientationYaw: this.rawYaw()
    };
    this._spinTrace = {
      acceptedDt: 0,
      rejectedDt: 0,
      elapsedIntegratedSec: 0,
      projectedSignedDeg: 0,
      projectedAbsoluteDeg: 0,
      projectedPositiveDeg: 0,
      projectedNegativeDeg: 0,
      rawAxisSignedDeg: [0, 0, 0],
      rawAxisAbsoluteDeg: [0, 0, 0],
      gravitySum: [0, 0, 0],
      gravityN: 0,
      orientationAlphaTravel: 0,
      lastAlpha: Number.isFinite(this.alpha) ? this.alpha : null,
      rateMin: Infinity,
      rateMax: -Infinity
    };
    this.spinDiagnostic = null;
  }

  spinProgress() {
    if (!this._spinStart) return 0;
    const gyro = Math.abs(this.gyroYaw - this._spinStart.gyroYaw);
    const orientation = Math.abs(this._spinTrace?.orientationAlphaTravel || 0);
    const rawAxis = this._spinTrace
      ? Math.max(...this._spinTrace.rawAxisSignedDeg.map(Math.abs))
      : 0;
    return this._spinKind === 'flat'
      ? Math.max(gyro, orientation, rawAxis)
      : rawAxis;
  }

  finishSpinDiagnostic() {
    this._spinActive = false;
    if (!this._spinStart) return null;
    const measuredDeg = this.gyroYaw - this._spinStart.gyroYaw;
    const absMeasured = Math.abs(measuredDeg);
    const proposedScale = absMeasured > 1 ? 360 / absMeasured : null;
    // A modest scale error is plausibly a sensor calibration error. A large
    // one more likely means the pose, axis mapping, or gesture was wrong; log
    // it prominently instead of teaching the survey a dangerous correction.
    const scaleApplied = this._spinKind === 'flat'
      && Number.isFinite(proposedScale) && proposedScale >= 0.8 && proposedScale <= 1.2;
    if (scaleApplied) this.gyroScale *= proposedScale;
    const flat = this._spinFlat.length
      ? { mean: this._spinFlat.reduce((a, v) => a + v, 0) / this._spinFlat.length,
          max: Math.max(...this._spinFlat) }
      : { mean: null, max: null };
    const result = {
      kind: this._spinKind,
      durationMs: performance.now() - this._spinStart.t,
      measuredDeg,
      direction: measuredDeg >= 0 ? 'clockwise-positive' : 'clockwise-negative',
      proposedScale,
      scaleApplied,
      resultingScale: this.gyroScale,
      compassClosureDeg: Number.isFinite(this.compassHeading) && Number.isFinite(this._spinStart.compass)
        ? angDiff(this.compassHeading, this._spinStart.compass) : null,
      orientationClosureDeg: angDiff(this.rawYaw(), this._spinStart.orientationYaw),
      flatnessMeanDeg: flat.mean,
      flatnessMaxDeg: flat.max,
      samples: this._spinFlat.length,
      trace: this._spinTrace ? {
        ...this._spinTrace,
        meanGravity: this._spinTrace.gravityN
          ? this._spinTrace.gravitySum.map(v => v / this._spinTrace.gravityN)
          : null,
        rateMin: Number.isFinite(this._spinTrace.rateMin) ? this._spinTrace.rateMin : null,
        rateMax: Number.isFinite(this._spinTrace.rateMax) ? this._spinTrace.rateMax : null
      } : null
    };
    this.spinDiagnostic = result;
    if (this._spinKind === 'flat') this.flatSpinDiagnostic = result;
    else this.uprightSpinDiagnostic = result;
    this._spinStart = null;
    this._spinTrace = null;
    return this.spinDiagnostic;
  }

  /**
   * Solve which reported gyro axis is which physical axis, from the two spins.
   *
   * Physics: during a rotation about world vertical, the angular-velocity
   * vector in the device frame must be parallel to vertical in the device
   * frame — and both come from the same event stream, so any disagreement IS
   * the frame error. One spin constrains one axis; the flat and upright tests
   * supply two roughly perpendicular poses, which pins the whole mapping.
   *
   * All 48 signed permutations are scored by how well they align the
   * integrated raw turn with the mean gravity direction of each spin. The
   * alignment is SIGNED against +gravity, which assumes both turns were
   * counter-clockwise as instructed — the one thing this cannot detect is an
   * operator who turned clockwise both times on a permuted device; the
   * landmark check remains the backstop for that.
   *
   * The turns do not need to be precise: axis identification needs direction,
   * not magnitude, so "roughly a full circle" is genuinely good enough.
   */
  solveGyroAxisMap() {
    const spins = [this.flatSpinDiagnostic, this.uprightSpinDiagnostic];
    if (spins.some(s => !s?.trace?.meanGravity)) return { status: 'insufficient-data' };
    const data = spins.map(s => {
      const g = s.trace.meanGravity;
      const mag = Math.hypot(...g) || 1;
      return { I: s.trace.rawAxisSignedDeg, g: g.map(v => v / mag) };
    });
    // If gravity barely moved between the two poses, the second spin adds no
    // new constraint and any solution is underdetermined.
    const poseDot = Math.abs(data[0].g[0] * data[1].g[0] + data[0].g[1] * data[1].g[1] + data[0].g[2] * data[1].g[2]);
    if (poseDot > 0.7) return { status: 'poses-too-similar', poseDot };

    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const score = (perm, signs) => {
      let residualDeg = 0;
      const projections = [];
      for (const d of data) {
        const v = [signs[0] * d.I[perm[0]], signs[1] * d.I[perm[1]], signs[2] * d.I[perm[2]]];
        const n = Math.hypot(...v) || 1;
        const dot = v[0] * d.g[0] + v[1] * d.g[1] + v[2] * d.g[2];
        residualDeg = Math.max(residualDeg, Math.acos(clamp(dot / n, -1, 1)) * RAD);
        projections.push(dot);
      }
      return { residualDeg, projections };
    };
    let best = null;
    for (const perm of perms) {
      for (let sx = -1; sx <= 1; sx += 2) for (let sy = -1; sy <= 1; sy += 2) for (let sz = -1; sz <= 1; sz += 2) {
        const signs = [sx, sy, sz];
        const r = score(perm, signs);
        // An axis that carried no rotation in either spin has an unconstrained
        // sign; the tiny penalty breaks such ties toward the least change from
        // the spec mapping instead of toward loop order.
        const changes = perm.reduce((n, p, i) => n + (p !== i ? 1 : 0), 0)
          + signs.reduce((n, s) => n + (s !== 1 ? 1 : 0), 0);
        const cost = r.residualDeg + 0.01 * changes;
        if (!best || cost < best.cost) best = { perm, signs, cost, ...r };
      }
    }
    const identity = score([0, 1, 2], [1, 1, 1]);
    const valid = r => r.residualDeg <= 30
      && r.projections.every(p => p >= 270 && p <= 450);
    if (valid(identity)) return { status: 'identity', ...identity };
    if (!valid(best)) return { status: 'unsolved', best, identity };

    const isIdentity = best.perm.every((p, i) => p === i) && best.signs.every(s => s === 1);
    if (isIdentity) return { status: 'identity', ...best };
    // Determinant of a signed permutation: permutation parity times the signs.
    const PARITY = [1, -1, -1, 1, 1, -1];   // matches the perms list order
    const det = PARITY[perms.indexOf(best.perm)] * best.signs[0] * best.signs[1] * best.signs[2];
    this.gyroAxisMap = { perm: best.perm, signs: best.signs, residualDeg: best.residualDeg };
    return { status: 'remapped', ...best, leftHanded: det < 0 };
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
    const pitch = this.attitude().elevation;

    // Measure motion with the gyroscope where there is one. Judging stillness
    // from the magnetometer-fused yaw was reporting jitter of tens of degrees
    // on a phone that was not moving, and then telling the operator to hold
    // still — about a signal the survey does not even use for rotation any more.
    if (this.gyroAvailable) {
      this._yawUnwrapped = this.gyroYaw;
      this.motionSource = 'gyroscope';
    } else {
      const yaw = this.rawYaw();
      if (this._yawUnwrapped === null) this._yawUnwrapped = yaw;
      else this._yawUnwrapped += angDiff(yaw, this._prevWrapped);
      this._prevWrapped = yaw;
      this.motionSource = 'orientation';
    }

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
      gyro: this.gyroAvailable ? 'available' : 'absent',
      motionSource: this.motionSource,
      gyroSamples: this.gyroSamples,
      sensorSource: this.sensorSource,
      gyroBiasDegPerSec: this.gyroBias.map(v => Number(v.toFixed(4))),
      gyroScale: Number(this.gyroScale.toFixed(6)),
      gyroAxisMap: this.gyroAxisMap,
      stationaryDiagnostic: this.stationaryDiagnostic,
      spinDiagnostic: this.spinDiagnostic,
      flatSpinDiagnostic: this.flatSpinDiagnostic,
      uprightSpinDiagnostic: this.uprightSpinDiagnostic,
      sampleIntervalMs: Math.round(this.eventDt * 1000)
    };
  }
}
