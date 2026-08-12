/* Gyro axis-map solver, tested against the 2026-08-12 field failure.
 *
 * That device reported clean full turns on the WRONG rotationRate components:
 * a flat spin (physically about device z) integrated +330° on raw y, and an
 * upright spin (physically about device y) integrated +376° on raw z. The
 * projection onto world vertical therefore caught only -43° / -135° of two
 * real ~360° turns and calibration failed through no fault of the operator.
 *
 * Also locks in the bias plausibility gate: the same session measured a
 * "stationary" bias of 8.6°/s with 25-31°/s of noise — a handheld phone, not
 * a sensor bias — and that number must be refused, not applied.
 */
import { OrientationSource } from '../js/orientation.js';

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures++;
};
const noLog = () => {};

/** Feed a spin through the real _onMotion path. `rate` maps reported
 *  rotationRate keys to deg/s; `gravity` is accelerationIncludingGravity. */
function runSpin(o, kind, rate, gravity, seconds = 5) {
  o.beginSpinDiagnostic(kind);
  const dt = 20;
  for (let t = 0; t <= seconds * 1000; t += dt) {
    o._onMotion({
      timeStamp: o._lastMotionAt ? o._lastMotionAt + dt : 1000 + t,
      rotationRate: { beta: rate.beta || 0, gamma: rate.gamma || 0, alpha: rate.alpha || 0 },
      accelerationIncludingGravity: gravity
    });
  }
  return o.finishSpinDiagnostic();
}

console.log('=== Field device: gamma/alpha transposed ===');
{
  const o = new OrientationSource(noLog);
  // Flat CCW spin, physically about device z, reported on gamma (raw index 1).
  runSpin(o, 'flat', { gamma: 66 }, { x: 0, y: 0, z: 9.8 });      // ~330°
  // Upright CCW sweep, physically about device y, reported on alpha (raw 2).
  runSpin(o, 'upright', { alpha: 75 }, { x: 0, y: 9.8, z: 0 });   // ~375°
  const s = o.solveGyroAxisMap();
  check('solver reports a remap', s.status === 'remapped', `status ${s.status}`);
  check('y and z are swapped', s.perm && s.perm[1] === 2 && s.perm[2] === 1,
    `perm ${JSON.stringify(s.perm)}`);
  check('unconstrained x keeps + sign and identity slot', s.perm?.[0] === 0 && s.signs?.[0] === 1);
  check('both spins project to a full turn', s.projections?.every(p => p > 270 && p < 450),
    `projections ${s.projections?.map(p => p.toFixed(0)).join(', ')}`);
  check('residual small on clean data', s.residualDeg < 5, `${s.residualDeg?.toFixed(2)}°`);

  // With the map applied, an upright rotation must now project fully.
  o._onOrientation({ alpha: 0, beta: 90, gamma: 0 });   // upright pose
  const before = o.gyroYaw;
  runSpin(o, 'upright', { alpha: 72 }, { x: 0, y: 9.8, z: 0 });
  const projected = o.gyroYaw - before;
  check('projected yaw recovers the full turn after remap', Math.abs(Math.abs(projected) - 360) < 30,
    `${projected.toFixed(1)}° for a physical ~360°`);
  check('CCW turn projects negative (app convention)', projected < 0);
}

console.log('=== Exact integrated vectors from the debug bundle ===');
{
  const o = new OrientationSource(noLog);
  const mk = (I, g) => ({ trace: { rawAxisSignedDeg: I, meanGravity: g } });
  o.flatSpinDiagnostic = mk([-106.40, 330.15, 45.40], [0, 0, 1]);
  o.uprightSpinDiagnostic = mk([-126.14, -109.11, 376.17], [0, 1, 0]);
  const s = o.solveGyroAxisMap();
  check('field vectors solve to the y/z swap', s.status === 'remapped' && s.perm[1] === 2 && s.perm[2] === 1,
    `status ${s.status}, perm ${JSON.stringify(s.perm)}`);
  check('field projections land on full turns', s.projections?.every(p => p > 270 && p < 450),
    `projections ${s.projections?.map(p => p.toFixed(0)).join(', ')}`);
}

console.log('=== Spec-compliant device stays on identity ===');
{
  const o = new OrientationSource(noLog);
  runSpin(o, 'flat', { alpha: 68 }, { x: 0, y: 0, z: 9.8 });      // turn on z, as spec says
  runSpin(o, 'upright', { gamma: 70 }, { x: 0, y: 9.8, z: 0 });   // turn on y
  const s = o.solveGyroAxisMap();
  check('identity is recognised', s.status === 'identity', `status ${s.status}`);
  check('no map is installed', o.gyroAxisMap === null);
}

console.log('=== Degenerate poses are refused ===');
{
  const o = new OrientationSource(noLog);
  runSpin(o, 'flat', { alpha: 68 }, { x: 0, y: 0, z: 9.8 });
  runSpin(o, 'upright', { alpha: 68 }, { x: 0, y: 0.4, z: 9.7 }); // barely tilted
  const s = o.solveGyroAxisMap();
  check('same-pose spins cannot solve the map', s.status === 'poses-too-similar', `status ${s.status}`);
}

console.log('=== Handheld "stationary" bias is refused ===');
{
  const o = new OrientationSource(noLog);
  o.beginStationaryDiagnostic();
  let seed = 5;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let t = 0; t <= 4000; t += 30) {
    o._onMotion({
      timeStamp: 1000 + t,
      rotationRate: { beta: 8 + rnd() * 50, gamma: 2 + rnd() * 30, alpha: -7 + rnd() * 60 },
      accelerationIncludingGravity: { x: rnd(), y: 8 + rnd() * 2, z: 4.6 + rnd() * 3 }
    });
  }
  const r = o.finishStationaryDiagnostic();
  check('bias refused for a moving phone', !r.biasApplied, r.biasRefusedReason);
  check('gyro bias stays zero', o.gyroBias.every(b => b === 0));
}

console.log('=== Genuine stationary bias is still applied ===');
{
  const o = new OrientationSource(noLog);
  o.beginStationaryDiagnostic();
  for (let t = 0; t <= 4000; t += 30) {
    o._onMotion({
      timeStamp: 1000 + t,
      rotationRate: { beta: 0.6, gamma: -0.3, alpha: 0.4 },
      accelerationIncludingGravity: { x: 0.01, y: 0.02, z: 9.81 }
    });
  }
  const r = o.finishStationaryDiagnostic();
  check('bias applied on a still phone', r.biasApplied === true, r.biasRefusedReason || '');
  check('bias close to the injected value', Math.abs(o.gyroBias[0] - 0.6) < 0.05,
    `x bias ${o.gyroBias[0].toFixed(3)}`);
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exitCode = 1; }
else console.log('\nall gyro axis-map checks passed');
