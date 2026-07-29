/* Regression: the tripod failure of 2026-07-28, 02:16.
 *
 * Symptom: phone clamped to a tripod, elevation 11.8 and roll -0.1 both dead
 * steady, azimuth reading a stable 296.9 — and turn rate reporting 44.7 deg/s.
 * Stillness stayed at zero, calibration never completed, keyframes 0.
 *
 * Cause: rotationRate was a derivative between consecutive orientation samples.
 * At 30-60 Hz that dt is 16-33 ms, so about a degree of ordinary magnetometer
 * jitter becomes tens of degrees per second. The position was fine; only its
 * derivative was noise.
 *
 * Fix: least-squares slope over a ~450 ms window, plus a jitter measure so the
 * operator is told the sensor is the problem, plus a calibration timeout that
 * proceeds on a relative azimuth datum.
 */
import { OrientationSource } from '../js/orientation.js';
import { quatFromEuler, quatNormalize } from '../js/math3d.js';

globalThis.performance ??= { now: () => Date.now() };
const quat = (a, b, g) => quatNormalize(quatFromEuler(a, b, g));

/* Deterministic pseudo-noise so the test does not flake. */
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

/**
 * Feed a phone that is not moving, with `jitter` degrees peak-to-peak of yaw
 * noise, at `hz` samples per second, for `seconds`.
 */
function stationary(jitter, hz, seconds) {
  const o = new OrientationSource();
  const step = 1000 / hz;
  let t = 0;
  for (let i = 0; i < hz * seconds; i++) {
    t += step;
    const a = 63.1 + rnd() * jitter;     // 296.9 azimuth, jittering
    o.alpha = a; o.beta = 101.8; o.gamma = -0.1;
    o.quat = quat(a, 101.8, -0.1);
    o._trackMotion(t);
  }
  return o;
}

console.log('--- stationary tripod, 1 deg of magnetometer jitter at 50 Hz ---');
const o = stationary(1.0, 50, 4);
console.log(`  reported turn rate : ${Math.abs(o.rotationRate).toFixed(2)} deg/s   (field build reported 44.7)`);
console.log(`  measured jitter    : ${o.jitterDeg.toFixed(2)} deg peak-to-peak`);
console.log(`  stillness          : ${o.stillness.toFixed(3)}   (needs > 0.6)`);
console.log(`  ${Math.abs(o.rotationRate) < 4 && o.stillness > 0.6 ? 'PASS' : 'FAIL'} - a tripod must read still\n`);

console.log('--- same, but 3 deg of jitter: must still settle, and flag itself ---');
const o2 = stationary(3.0, 50, 4);
console.log(`  reported turn rate : ${Math.abs(o2.rotationRate).toFixed(2)} deg/s`);
console.log(`  measured jitter    : ${o2.jitterDeg.toFixed(2)} deg  (guide warns above 1.2)`);
console.log(`  stillness          : ${o2.stillness.toFixed(3)}`);
console.log(`  ${o2.jitterDeg > 1.2 ? 'PASS' : 'FAIL'} - heavy jitter must be reported as sensor noise\n`);

console.log('--- real rotation at 7 deg/s must survive the smoothing ---');
const o3 = new OrientationSource();
let t3 = 0, a3 = 0;
for (let i = 0; i < 300; i++) {
  t3 += 20;                                   // 50 Hz
  a3 = (a3 + 0.14 + 360) % 360;               // 0.14 deg per 20 ms = 7 deg/s
  const a = a3 + rnd() * 1.0;
  o3.alpha = a; o3.beta = 101.8; o3.gamma = -0.1;
  o3.quat = quat(a, 101.8, -0.1);
  o3._trackMotion(t3);
}
console.log(`  measured turn rate : ${Math.abs(o3.rotationRate).toFixed(2)} deg/s   (truth 7.00)`);
console.log(`  ${Math.abs(Math.abs(o3.rotationRate) - 7) < 1 ? 'PASS' : 'FAIL'} - real rotation must survive\n`);

console.log('--- lag check: the window must not hide a genuine stop ---');
let t4 = 0;
const o4 = new OrientationSource();
let a4 = 0;
for (let i = 0; i < 150; i++) { t4 += 20; a4 += 0.14; o4.alpha = a4 % 360; o4.beta = 101.8; o4.gamma = -0.1; o4.quat = quat(a4 % 360, 101.8, -0.1); o4._trackMotion(t4); }
const moving = Math.abs(o4.rotationRate);
for (let i = 0; i < 40; i++) { t4 += 20; o4.alpha = a4 % 360; o4.beta = 101.8; o4.gamma = -0.1; o4.quat = quat(a4 % 360, 101.8, -0.1); o4._trackMotion(t4); }
console.log(`  while turning      : ${moving.toFixed(2)} deg/s`);
console.log(`  800 ms after stop  : ${Math.abs(o4.rotationRate).toFixed(2)} deg/s`);
console.log(`  ${Math.abs(o4.rotationRate) < 1 ? 'PASS' : 'FAIL'} - must register a stop within a second`);
