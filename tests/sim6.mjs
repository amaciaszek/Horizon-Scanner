/* Regression: the field failure of 2026-07-28.
 *
 * Symptom: turn rate read 371-2586 deg/s while the phone was held still, so
 * stillness never rose above zero, calibration never completed, and zero
 * keyframes were captured. The log showed the orientation stream reporting
 * frame-to-frame yaw deltas of -174.6, +175.4, -174.1 degrees while visual
 * registration correctly reported 0.5.
 *
 * Cause: rawYaw() read the DeviceOrientation `alpha` scalar. The ZXY Euler
 * decomposition is singular at beta = +-90, which is the pose this app is used
 * in. Two triples describe the same physical orientation there and the browser
 * alternates between them, flipping alpha by 180 without the phone moving.
 */
import { OrientationSource } from '../js/orientation.js';

// Minimal DOM surface so the module can be constructed under Node.
globalThis.performance ??= { now: () => Date.now() };

const o = new OrientationSource();

/* Feed a pose the way _onOrientation would, without needing window events. */
function pose(alpha, beta, gamma, atMs) {
  o.alpha = alpha; o.beta = beta; o.gamma = gamma;
  o.quat = quat(alpha, beta, gamma);
  o._trackMotion(atMs);
}
const { quatFromEuler, quatNormalize } = await import('../js/math3d.js');
const quat = (a, b, g) => quatNormalize(quatFromEuler(a, b, g));

/* ---- 1. A stationary phone that the browser reports via alternating aliases */
console.log('--- phone held still, browser alternating Euler aliases ---');
let t = 0;
const seen = [];
for (let i = 0; i < 40; i++) {
  t += 60;
  // Same physical pose every frame, reported two different legal ways.
  if (i % 2 === 0) pose(30, 88, -3.4, t);
  else pose(210, 92, 176.6, t);
  if (i > 3) seen.push(Math.abs(o.rotationRate));
}
const worst = Math.max(...seen);
console.log(`  peak reported turn rate : ${worst.toFixed(2)} deg/s   (field build reported 2586)`);
console.log(`  stillness after 40 frames: ${o.stillness.toFixed(3)}   (needs > 0.6 to calibrate)`);
console.log(`  ${worst < 1 && o.stillness > 0.6 ? 'PASS' : 'FAIL'} - a still phone must read still\n`);

/* ---- 2. Real rotation must still be measured correctly */
console.log('--- phone genuinely rotating at 7 deg/s through the singularity ---');
const o2 = new OrientationSource();
let t2 = 0, alpha = 0;
const rates = [];
for (let i = 0; i < 60; i++) {
  t2 += 100;                       // 10 Hz
  alpha = (alpha + 0.7 + 360) % 360;  // 0.7 deg per 100 ms = 7 deg/s
  // Alias-flip half the samples, as a real browser does near beta = 90.
  if (i % 3 === 0) {
    o2.alpha = alpha; o2.beta = 89; o2.gamma = -2;
    o2.quat = quat(alpha, 89, -2);
  } else {
    o2.alpha = (alpha + 180) % 360; o2.beta = 91; o2.gamma = 178;
    o2.quat = quat((alpha + 180) % 360, 91, 178);
  }
  o2._trackMotion(t2);
  if (i > 20) rates.push(o2.rotationRate);
}
const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
console.log(`  measured turn rate      : ${mean.toFixed(2)} deg/s   (truth -7.00, sign is yaw convention)`);
console.log(`  ${Math.abs(Math.abs(mean) - 7) < 0.5 ? 'PASS' : 'FAIL'} - real rotation must survive the fix\n`);

/* ---- 3. Glitch rejection: one impossible sample must not poison the rate */
console.log('--- single 400+ deg/s glitch amid a still phone ---');
const o3 = new OrientationSource();
let t3 = 0;
for (let i = 0; i < 30; i++) {
  t3 += 60;
  if (i === 15) { o3.alpha = 200; o3.beta = 88; o3.gamma = -3.4; o3.quat = quat(200, 88, -3.4); }
  else { o3.alpha = 30; o3.beta = 88; o3.gamma = -3.4; o3.quat = quat(30, 88, -3.4); }
  o3._trackMotion(t3);
}
console.log(`  stillness after glitch  : ${o3.stillness.toFixed(3)}`);
console.log(`  ${o3.stillness > 0.6 ? 'PASS' : 'FAIL'} - one bad sample must not stall calibration`);
