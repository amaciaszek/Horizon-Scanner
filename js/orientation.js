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
const DEG2RAD = Math.PI / 180;

/**
 * The three calibration motions, named for the axis each one turns about.
 * Naming follows the standard phone convention (device X out the right side,
 * Y out the top, Z out of the screen), so:
 *
 *   yaw   — about device Z. Phone flat, screen up; spin it like a record.
 *   roll  — about device Y. Phone upright, top at the zenith; turn a circle.
 *   pitch — about device X. Phone tumbles end over end.
 *
 * Between them every reported gyro component is exercised. The pitch tumble
 * is the only one where gravity MOVES in the device frame, and that motion is
 * ground truth: it fixes an axis, its sign, and the gyro's scale without
 * assuming anything at all about the operator's aim.
 */
export const SPIN_KINDS = ['yaw', 'roll', 'pitch'];

/** Below this rate the orientation stream's own jitter dominates its apparent
 *  motion, so such intervals are dropped from the axis solve. See the note in
 *  solveGyroAxisMap where it is applied. */
const RATE_FLOOR_DEG_S = 20;

/** Seconds over which gravity's movement is measured in the axis solve. Long
 *  enough to bury the orientation stream's jitter, short enough that treating
 *  the arc as a straight line stays a sub-percent approximation. */
const GRAVITY_BASELINE_S = 0.1;

/**
 * What kind of motion this was, from the fraction of it that moved gravity
 * through the device frame. Near 0 is a turn about vertical (gravity parked on
 * one axis); near 1 is an end-over-end tumble.
 *
 * Thresholds sized for a human hand, not a rig: a 360° turn wobbling by ±10° a
 * few times drags gravity through ~120° of path, so "about vertical" has to
 * tolerate a ratio near 0.35 before it starts calling a turn a tumble.
 */
function classifyMotion(sweepRatio) {
  if (sweepRatio === null) return 'too-little';
  if (sweepRatio < 0.5) return 'about-vertical';
  return sweepRatio > 0.65 ? 'tumble' : 'mixed';
}

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
    this.datumSpreadDeg = null;
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
    this.spinDiagnostics = { yaw: null, roll: null, pitch: null };
    this._stationarySamples = [];
    this._stationaryActive = false;
    this._spinActive = false;
    this._spinStart = null;
    this._spinFlat = [];
    this._spinTrace = null;
    this._spinKind = 'yaw';
    this._spinSamples = [];
    this._spinLastUp = null;
    // Per-kind raw evidence for the axis solver. Held only across calibration.
    this._spinData = { yaw: null, roll: null, pitch: null };
    this._orientationSeen = false;
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
          this._orientationSeen = true;
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
    this._orientationSeen = true;

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
    // wRaw stays in the REPORTED frame (bias-subtracted only): the spin traces
    // and the axis-map solver must see the device's own frame, or a re-solve
    // after a retry would double-apply the map.
    const wRaw = rawW.map((v, i) => v - this.gyroBias[i]);
    let w = wRaw;
    if (this.gyroAxisMap) {
      const m = this.gyroAxisMap;
      w = [m.signs[0] * wRaw[m.perm[0]], m.signs[1] * wRaw[m.perm[1]], m.signs[2] * wRaw[m.perm[2]]];
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
        tr.rawAxisSignedDeg[i] += wRaw[i] * dt;
        tr.rawAxisAbsoluteDeg[i] += Math.abs(wRaw[i] * dt);
      }
      tr.rateMin = Math.min(tr.rateMin, this.gyroYawRate);
      tr.rateMax = Math.max(tr.rateMax, this.gyroYawRate);
    }
    if (this._spinActive && this._spinTrace) {
      const tr = this._spinTrace;
      const mag = gravity ? Math.hypot(...gravity) : 0;
      if (mag > 1) this._spinFlat.push(Math.acos(clamp(Math.abs(gravity[2]) / mag, -1, 1)) * RAD);
      tr.totalRotDeg += Math.hypot(...wRaw) * dt;

      // The solver's raw material: angular velocity in the REPORTED frame
      // beside world-up in the TRUE device frame, sample by sample.
      //
      // `up` comes from the fused orientation quaternion rather than the
      // accelerometer. That matters for the tumble: a hand-held phone swung
      // end over end carries its own linear acceleration, which corrupts raw
      // gravity exactly when the measurement counts. `up` is also independent
      // of alpha, so a magnetometer swinging by 69° cannot reach it.
      const u = this._orientationSeen ? up
        : (mag > 3 ? [gravity[0] / mag, gravity[1] / mag, gravity[2] / mag] : null);
      if (u) {
        if (this._spinLastUp) {
          // Chord to arc, exact for unit vectors: how far world-up has
          // travelled through the device frame. Zero for a turn about
          // vertical; a full circle for a clean end-over-end tumble.
          const chord = Math.hypot(u[0] - this._spinLastUp[0], u[1] - this._spinLastUp[1], u[2] - this._spinLastUp[2]);
          tr.sweepDeg += 2 * Math.asin(clamp(chord / 2, -1, 1)) * RAD;
        }
        this._spinLastUp = u;
        if (this._spinSamples.length < 4000) this._spinSamples.push({ w: wRaw.slice(), u, dt });
        if (mag > 3) {
          for (let i = 0; i < 3; i++) tr.gravitySum[i] += gravity[i] / mag;
          tr.gravityN++;
        }
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

  beginSpinDiagnostic(kind = 'yaw') {
    this._spinActive = true;
    this._spinKind = kind;
    this._spinFlat = [];
    this._spinSamples = [];
    this._spinLastUp = null;
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
      totalRotDeg: 0,
      sweepDeg: 0,
      orientationAlphaTravel: 0,
      lastAlpha: Number.isFinite(this.alpha) ? this.alpha : null,
      rateMin: Infinity,
      rateMax: -Infinity
    };
    this.spinDiagnostic = null;
  }

  /**
   * What the in-progress motion has supplied so far: how far each REPORTED
   * gyro axis has been turned, and how far gravity has travelled through the
   * device frame.
   *
   * These are exactly the two things the solver needs — the first tells it
   * which reported axis is which, the second tells it which way each one
   * points — so they are also exactly what is worth coaching. Deliberately
   * map-independent, since the mapping is the unknown.
   */
  spinEvidence() {
    const tr = this._spinTrace;
    if (!tr) return { work: [0, 0, 0], sweepDeg: 0, totalRotDeg: 0 };
    return { work: tr.rawAxisAbsoluteDeg.slice(), sweepDeg: tr.sweepDeg, totalRotDeg: tr.totalRotDeg };
  }

  finishSpinDiagnostic() {
    this._spinActive = false;
    if (!this._spinStart) return null;
    const measuredDeg = this.gyroYaw - this._spinStart.gyroYaw;
    // Nothing is scaled from "the operator meant to do exactly 360°". That
    // assumption is what made these tests feel like a precision exam nobody
    // could pass; the gyro's scale is measured instead against the angle
    // gravity actually swept during the tumble. See solveGyroAxisMap.
    const flat = this._spinFlat.length
      ? { mean: this._spinFlat.reduce((a, v) => a + v, 0) / this._spinFlat.length,
          max: Math.max(...this._spinFlat) }
      : { mean: null, max: null };
    const tr = this._spinTrace;
    const totalRotDeg = tr?.totalRotDeg || 0;
    const sweepDeg = tr?.sweepDeg || 0;
    // How much of this motion moved gravity through the device frame. Near 0
    // means a turn about vertical (gravity parked on one axis); near 1 means a
    // tumble. Measured from the orientation stream alone, so it is true
    // regardless of what the gyro claims — which is what lets the solver work
    // out for itself which kind of motion it was actually handed.
    const sweepRatio = totalRotDeg > 20 ? sweepDeg / totalRotDeg : null;
    const motion = classifyMotion(sweepRatio);
    const result = {
      kind: this._spinKind,
      durationMs: performance.now() - this._spinStart.t,
      measuredDeg,
      totalRotDeg,
      sweepDeg,
      sweepRatio,
      motion,
      resultingScale: this.gyroScale,
      compassClosureDeg: Number.isFinite(this.compassHeading) && Number.isFinite(this._spinStart.compass)
        ? angDiff(this.compassHeading, this._spinStart.compass) : null,
      orientationClosureDeg: angDiff(this.rawYaw(), this._spinStart.orientationYaw),
      flatnessMeanDeg: flat.mean,
      flatnessMaxDeg: flat.max,
      samples: this._spinFlat.length,
      trace: this._spinTrace ? (tr => ({
        acceptedDt: tr.acceptedDt,
        rejectedDt: tr.rejectedDt,
        elapsedIntegratedSec: tr.elapsedIntegratedSec,
        projectedSignedDeg: tr.projectedSignedDeg,
        projectedAbsoluteDeg: tr.projectedAbsoluteDeg,
        projectedPositiveDeg: tr.projectedPositiveDeg,
        projectedNegativeDeg: tr.projectedNegativeDeg,
        rawAxisSignedDeg: tr.rawAxisSignedDeg,
        rawAxisAbsoluteDeg: tr.rawAxisAbsoluteDeg,
        meanGravity: tr.gravityN ? tr.gravitySum.map(v => v / tr.gravityN) : null,
        orientationAlphaTravel: tr.orientationAlphaTravel,
        lastAlpha: tr.lastAlpha,
        rateMin: Number.isFinite(tr.rateMin) ? tr.rateMin : null,
        rateMax: Number.isFinite(tr.rateMax) ? tr.rateMax : null
      }))(this._spinTrace) : null
    };
    this.spinDiagnostic = result;
    this.spinDiagnostics[this._spinKind] = result;
    // Raw per-sample evidence, kept out of the JSON-able result.
    this._spinData[this._spinKind] = {
      kind: this._spinKind, samples: this._spinSamples, totalRotDeg, sweepDeg, motion
    };
    this._spinStart = null;
    this._spinTrace = null;
    this._spinSamples = [];
    this._spinLastUp = null;
    return this.spinDiagnostic;
  }

  /** Forget every rotation test so a retry starts from clean evidence. */
  resetSpinEvidence() {
    this._spinData = { yaw: null, roll: null, pitch: null };
    this.spinDiagnostics = { yaw: null, roll: null, pitch: null };
    this.spinDiagnostic = null;
    this.gyroAxisMap = null;
    this.gyroScale = 1;
  }

  /**
   * Solve which reported gyro axis is which physical axis, from the three
   * calibration motions.
   *
   * The whole method rests on one equation of rigid-body kinematics. World-up
   * is fixed in the world, so seen from the turning device it counter-rotates:
   *
   *     du/dt = -(ω × u)
   *
   * Every motion sample is therefore one equation in the unknown axis map, and
   * `u` comes from the orientation stream while `ω` comes from the gyro — two
   * independent sensors that must agree. Where they disagree IS the frame
   * error. All 48 signed permutations are scored on how badly they violate
   * this, summed over every sample of every test, normalised by total
   * rotation: 0 is perfect, ~1 means the map explains none of the motion.
   *
   * What each motion contributes:
   *
   *   pitch (tumble) — gravity sweeps, so du/dt is large and the equation
   *     pins that axis outright, sign included. Nothing is assumed.
   *   yaw / roll (turns about vertical) — ω is parallel to u, so ω × u is
   *     zero whichever way the operator turned. These pin which axis, but
   *     their sign ties, and the tie is broken by whatever wobble the hold
   *     had, or failing that by the instruction to turn left.
   *
   * Nothing here asks for precision. There is no target angle, no pose
   * tolerance, no flatness requirement, and no assumption that a circle was
   * exactly 360° — a human turning roughly, holding the phone roughly, is
   * exactly the input this was built for.
   */
  solveGyroAxisMap({ apply = true, includeActive = false, maxIntervals = 1200 } = {}) {
    const spins = SPIN_KINDS
      .map(k => this._spinData[k])
      .filter(s => s && s.samples.length > 8 && s.totalRotDeg > 20);
    // The live coach solves repeatedly while the operator is still moving the
    // phone, so it needs the in-progress samples and must not install anything.
    if (includeActive && this._spinActive && this._spinTrace && this._spinSamples.length > 8) {
      const tr = this._spinTrace;
      const ratio = tr.totalRotDeg > 20 ? tr.sweepDeg / tr.totalRotDeg : null;
      spins.push({
        kind: this._spinKind, samples: this._spinSamples,
        totalRotDeg: tr.totalRotDeg, sweepDeg: tr.sweepDeg, motion: classifyMotion(ratio)
      });
    }
    if (!spins.length) return { status: 'insufficient-data', usableTests: 0 };

    // Per-interval quantities, computed once because they do not depend on the
    // candidate map. Midpoint values throughout: at 200°/s and 50 Hz a step is
    // 4°, and a one-sided difference would carry a systematic error of that
    // size straight into the residual.
    const iv = [];
    const work = [0, 0, 0];
    spins.forEach((spin, si) => {
      const s = spin.samples;
      // Sample times, so the gravity baseline below can be chosen in seconds
      // rather than in samples — the motion stream's rate varies from 30 to
      // 60 Hz across devices and even within one run.
      const t = new Float64Array(s.length);
      for (let k = 1; k < s.length; k++) t[k] = t[k - 1] + (s[k].dt > 0 && s[k].dt < 0.5 ? s[k].dt : 0);

      let lo = 0, hi = 0;
      for (let k = 0; k + 1 < s.length; k++) {
        const dt = s[k + 1].dt;
        if (!(dt > 0 && dt < 0.5)) continue;
        const w = [0, 1, 2].map(i => (s[k].w[i] + s[k + 1].w[i]) / 2);
        for (let i = 0; i < 3; i++) work[i] += Math.abs(w[i]) * dt;
        // Skip near-stationary moments. The orientation stream's own jitter
        // produces an apparent du/dt of tens of degrees per second however
        // slowly the phone is actually moving, so these intervals carry far
        // more noise than signal — as do the idle seconds at either end of
        // any motion, by the same argument.
        if (Math.hypot(...w) < RATE_FLOOR_DEG_S) continue;

        // Measure how far gravity moved over a WIDE baseline rather than
        // between neighbouring samples. Orientation jitter of a degree or so
        // becomes ~50°/s of phantom du/dt when divided by a 20 ms step, which
        // swamps a gently waved phone; spread over ~100 ms it falls by the
        // ratio of the spans while the real motion is unchanged. The cost is
        // a second-order chord-versus-arc error, well under 1% even when the
        // phone is being thrown about at 200°/s.
        while (lo + 1 < s.length && t[k] - t[lo] > GRAVITY_BASELINE_S / 2) lo++;
        if (hi < k) hi = k;
        while (hi + 1 < s.length && t[hi] - t[k] < GRAVITY_BASELINE_S / 2) hi++;
        const span = t[hi] - t[lo];
        if (!(span > 0)) continue;
        const um = [0, 1, 2].map(i => (s[lo].u[i] + s[hi].u[i]) / 2);
        const un = Math.hypot(...um);
        if (!(un > 0.5)) continue;   // gravity reversed across the span
        iv.push({
          si, dt, w, span,
          u: um.map(v => v / un),
          du: [0, 1, 2].map(i => (s[hi].u[i] - s[lo].u[i]) / span)
        });
      }
    });
    if (iv.length < 20) {
      return { status: 'insufficient-data', intervals: iv.length, work: work.map(v => Math.round(v)) };
    }
    // Cost is 48 candidates times this list, and the live coach re-solves
    // several times a second on a phone while the camera pipeline is also
    // running. Thinning it keeps that bounded; the evidence is spread evenly
    // through the motion, so a stride costs accuracy nothing that matters.
    const stride = Math.ceil(iv.length / maxIntervals);
    const ivs = stride > 1 ? iv.filter((_, i) => i % stride === 0) : iv;

    // Total rotation in radians. A signed permutation cannot change a vector's
    // length, so this is identical for all 48 candidates and turns the residual
    // into a dimensionless score.
    let den = 0;
    for (const v of ivs) den += Math.hypot(...v.w) * DEG2RAD * v.dt;
    if (!(den > 1)) return { status: 'too-little-rotation', totalDeg: Math.round(den / DEG2RAD) };

    const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const PARITY = [1, -1, -1, 1, 1, -1];   // permutation parity, same order
    const mapped = (v, perm, signs) =>
      [signs[0] * v.w[perm[0]], signs[1] * v.w[perm[1]], signs[2] * v.w[perm[2]]];

    const cands = [];
    for (let pi = 0; pi < 6; pi++) {
      const perm = PERMS[pi];
      for (let sx = -1; sx <= 1; sx += 2) for (let sy = -1; sy <= 1; sy += 2) for (let sz = -1; sz <= 1; sz += 2) {
        const signs = [sx, sy, sz];
        let num = 0;
        const align = spins.map(() => 0);
        for (const v of ivs) {
          const a = mapped(v, perm, signs);
          const r0 = a[0] * DEG2RAD, r1 = a[1] * DEG2RAD, r2 = a[2] * DEG2RAD;
          // Residual of du/dt + ω × u, which a correct map drives to zero.
          num += Math.hypot(
            r1 * v.u[2] - r2 * v.u[1] + v.du[0],
            r2 * v.u[0] - r0 * v.u[2] + v.du[1],
            r0 * v.u[1] - r1 * v.u[0] + v.du[2]
          ) * v.dt;
          align[v.si] += (a[0] * v.u[0] + a[1] * v.u[1] + a[2] * v.u[2]) * v.dt;
        }
        cands.push({
          perm, signs,
          det: PARITY[pi] * sx * sy * sz,
          changes: perm.reduce((n, p, i) => n + (p !== i ? 1 : 0), 0)
            + signs.reduce((n, s) => n + (s !== 1 ? 1 : 0), 0),
          resid: num / den,
          align
        });
      }
    }
    cands.sort((a, b) => a.resid - b.resid);
    const best = cands[0];
    const report = c => ({
      perm: c.perm, signs: c.signs, det: c.det,
      resid: Number(c.resid.toFixed(3)),
      align: c.align.map(a => Number(a.toFixed(1)))
    });
    const tests = spins.map(s => ({
      kind: s.kind, motion: s.motion,
      totalDeg: Math.round(s.totalRotDeg), sweepDeg: Math.round(s.sweepDeg)
    }));

    // Nothing fits. Either the two sensor streams genuinely disagree, or the
    // phone was shaken rather than turned.
    if (best.resid > 0.6) return { status: 'unsolved', tests, best: report(best) };

    // Candidates the data cannot tell apart. A rotation parallel to gravity
    // has ω × u = 0 whichever way it went, so its sign always ties here.
    const tol = Math.max(best.resid * 1.3, best.resid + 0.04);
    const tied = cands.filter(c => c.resid <= tol);

    // A rival PERMUTATION inside the tolerance is different in kind: it means
    // the three motions failed to separate the axes, and no sign-picking
    // rescues that. Say so rather than guessing.
    const rival = tied.find(c => c.perm.some((p, i) => p !== best.perm[i]));
    if (rival) return { status: 'ambiguous', tests, best: report(best), rival: report(rival) };

    // A physical gyroscope triad is right-handed. Prefer that, but do not
    // refuse a mirrored one outright — firmware does occasionally ship it.
    const rightHanded = tied.filter(c => c.det > 0);
    const pool = rightHanded.length ? rightHanded : tied;

    // Only turns about vertical can testify about direction. During a tumble
    // ω is perpendicular to gravity and its alignment is ~0 by construction,
    // so letting it vote would be noise with an opinion.
    const voters = spins.map((s, i) => (s.motion === 'about-vertical' ? i : -1)).filter(i => i >= 0);
    const directionOf = c => voters.map(i => Math.sign(c.align[i]));

    let pick, decidedBy, assumedDirection = false;
    if (pool.length === 1) {
      // Only one map survives, so the hold wobbled enough for the kinematics to
      // settle every sign by itself. Two degrees per second of hand tremor is
      // sufficient — which is to say every real hold. Which way the operator
      // turned is then merely observed, never assumed, and never a reason to
      // fail them: the map is right either way.
      pick = pool[0];
      decidedBy = 'kinematics';
    } else if (!voters.length) {
      return { status: 'no-direction-evidence', tests, best: report(best) };
    } else {
      // A rotation exactly parallel to gravity has ω × u = 0 whichever way it
      // went, so a phone turned on a rig steady enough to have no wobble at
      // all leaves the signs genuinely undecidable. The instruction to turn
      // left is the only remaining information, and leaning on it is recorded
      // as an assumption rather than passed off as a measurement.
      const ccw = pool.filter(c => directionOf(c).every(s => s > 0));
      const cw = pool.filter(c => directionOf(c).every(s => s < 0));
      if (!ccw.length) {
        return {
          status: cw.length ? 'wrong-direction' : 'mixed-direction',
          tests, best: report(best)
        };
      }
      ccw.sort((a, b) => a.changes - b.changes || a.resid - b.resid);
      pick = ccw[0];
      decidedBy = 'direction';
      assumedDirection = true;
    }
    // Which way the two turns about vertical actually went, as measured under
    // the chosen map. Worth surfacing: an operator who turned right is fine,
    // but it is the kind of thing a field log should record rather than hide.
    const turnedClockwise = voters.length > 0 && voters.every(i => pick.align[i] < 0);

    // Gyro scale, measured against gravity instead of against the operator.
    // The component of ω perpendicular to up is exactly what drags up through
    // the device frame, so the angle it integrates must equal the angle up
    // actually swept. Their ratio is the scale error — and how close the
    // operator came to a full circle never enters into it.
    // This number multiplies every azimuth the survey ever records, so its
    // run-to-run stability IS the survey's bearing accuracy: the field runs of
    // 2026-08-13 returned 1.0112 and 1.0538 from the same phone, and 4% of a
    // lap is 15° of bearing. A ratio of sums let a handful of fast, badly
    // tracked instants set it, so this takes the MEDIAN of the per-interval
    // ratios instead and reports how much they disagreed. Any motion that
    // moves gravity contributes, tumble or not.
    const ratios = [];
    for (const v of ivs) {
      const a = mapped(v, pick.perm, pick.signs).map(x => x * DEG2RAD);
      const dot = a[0] * v.u[0] + a[1] * v.u[1] + a[2] * v.u[2];
      const perp = Math.hypot(a[0] - dot * v.u[0], a[1] - dot * v.u[1], a[2] - dot * v.u[2]);
      if (perp < 0.35) continue;                     // lost in the noise floor
      const swept = Math.hypot(...v.du);
      if (swept < 0.2) continue;
      // du is a CHORD rate: it measures the straight line between two points on
      // gravity's arc, which is shorter than the arc itself. Ignoring that
      // understates fast motion — and rejecting the fast intervals instead is
      // worse, because it keeps only the slow ones where jitter dominates. The
      // angle turned across the baseline is known, so correct for it: arc =
      // chord · (θ/2)/sin(θ/2). Second-order, so the uncalibrated θ is fine.
      const theta = perp * v.span;
      if (theta > 1.2) continue;                     // too coarse to correct
      const arc = theta > 1e-3 ? swept * (theta / 2) / Math.sin(theta / 2) : swept;
      ratios.push({ r: arc / perp, w: perp * v.dt });
    }
    let scaleFromSweep = null, scaleSpread = null;
    if (ratios.length >= 25) {
      ratios.sort((a, b) => a.r - b.r);
      const total = ratios.reduce((s, x) => s + x.w, 0);
      const at = f => {
        let acc = 0;
        for (const x of ratios) { acc += x.w; if (acc >= total * f) return x.r; }
        return ratios[ratios.length - 1].r;
      };
      scaleFromSweep = at(0.5);
      scaleSpread = (at(0.75) - at(0.25)) / 2;   // half the interquartile range
    }
    // Refuse a figure the evidence does not actually support. Leaving the scale
    // at 1 costs a percent or so that loop closure absorbs; adopting a bad one
    // rotates the whole survey.
    const scaleApplied = Number.isFinite(scaleFromSweep)
      && scaleFromSweep >= 0.8 && scaleFromSweep <= 1.2
      && scaleSpread < 0.08;
    if (scaleApplied && apply) this.gyroScale = scaleFromSweep;

    const isIdentity = pick.perm.every((p, i) => p === i) && pick.signs.every(s => s === 1);
    if (apply) this.gyroAxisMap = isIdentity ? null : { perm: pick.perm, signs: pick.signs };
    return {
      status: isIdentity ? 'identity' : 'remapped',
      perm: pick.perm, signs: pick.signs,
      leftHanded: pick.det < 0,
      decidedBy,
      assumedDirection,
      turnedClockwise,
      resid: Number(pick.resid.toFixed(3)),
      margin: Number((cands.find(c => c.perm.some((p, i) => p !== pick.perm[i]))?.resid ?? Infinity).toFixed(3)),
      align: pick.align.map(a => Number(a.toFixed(1))),
      scaleFromSweep: scaleFromSweep === null ? null : Number(scaleFromSweep.toFixed(4)),
      scaleSpread: scaleSpread === null ? null : Number(scaleSpread.toFixed(4)),
      scaleApplied,
      // How much each REPORTED axis was exercised, and how far gravity
      // travelled. The live coach reads these to say what is still missing.
      work: work.map(v => Math.round(v)),
      tests
    };
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
    this.datumSpreadDeg = spread;
    if (spread > 12) this.compassReliability = 'poor';
    // This one number is the accuracy of every absolute bearing in the finished
    // profile. The shape of the horizon comes from the gyroscope and is fine
    // either way, but "which compass bearing is that rooftop at" is only ever
    // as good as this, and a scattered magnetometer used to slip by as a quiet
    // INFO line while the survey looked perfectly healthy.
    const bad = spread > 12;
    this.log(bad ? 'warn' : 'info',
      `Yaw datum locked at ${this.yawDatum.toFixed(1)}° from ${this._datumSamples.length} compass samples, spread ${spread.toFixed(1)}°.`
      + (bad
        ? ` The magnetometer disagreed with itself by ${spread.toFixed(0)}°, so every bearing in this survey could be out by roughly ±${(spread / 2).toFixed(0)}°. The horizon SHAPE is unaffected. Fix the bearings afterwards with the landmark tool: two landmarks at least 90° apart with map bearings will pin the offset.`
        : ''));
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
      datumSpreadDeg: this.datumSpreadDeg === null ? null : Number(this.datumSpreadDeg.toFixed(1)),
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
      spinDiagnostics: this.spinDiagnostics,
      sampleIntervalMs: Math.round(this.eventDt * 1000)
    };
  }
}
