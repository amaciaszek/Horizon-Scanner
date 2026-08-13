/* The three-axis calibration solver, against a rigid-body simulator.
 *
 * Every motion here is simulated properly — a quaternion is integrated from an
 * angular velocity, and both the gyro reading and the gravity direction are
 * derived from that same state. Nothing is hand-written per axis, so a test
 * cannot accidentally agree with a bug in the solver's frame conventions.
 *
 * The field failures this locks down (all 2026-08-12, same phone):
 *
 *   23:12  Both spins were clean full turns on the WRONG reported components:
 *          the flat spin (physically about device z) landed on reported y, and
 *          the upright sweep (about device y) landed on reported z.
 *   23:37  The solver averaged gravity across each spin, so a human gesture —
 *          pick the phone up, turn while holding it tilted, put it down —
 *          looked flat-dominated and every retry died "poses-too-similar".
 *   23:41  Five clean turns, five refusals, no survey ever started.
 *
 * The fix under test: three motions, one per device axis, judged once by the
 * kinematic identity du/dt = -(ω × u) rather than by per-test pass marks.
 */
import { OrientationSource } from '../js/orientation.js';

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures++;
};

/* ------------------------------------------------------- quaternion algebra */
const qMul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
];
const qConj = q => [q[0], -q[1], -q[2], -q[3]];
const qNorm = q => { const m = Math.hypot(...q); return q.map(v => v / m); };
/** Rotate a device-frame vector into the world frame. */
const qRot = (q, v) => {
  const r = qMul(qMul(q, [0, ...v]), qConj(q));
  return [r[1], r[2], r[3]];
};
const qAxisAngle = (axis, deg) => {
  const m = Math.hypot(...axis);
  if (m < 1e-12 || Math.abs(deg) < 1e-12) return [1, 0, 0, 0];
  const h = (deg * Math.PI / 180) / 2, s = Math.sin(h) / m;
  return [Math.cos(h), axis[0] * s, axis[1] * s, axis[2] * s];
};

/* ------------------------------------------------------------ device models
 * How a PHYSICAL device-frame angular velocity [x,y,z] reaches the app, which
 * reads rotationRate as [beta, gamma, alpha]. */
const SPEC = w => ({ beta: w[0], gamma: w[1], alpha: w[2] });
/** The field phone: reported gamma carries ω_z and reported alpha carries ω_y.
 *  A bare transposition is a reflection, so this triad is left-handed — which
 *  is what the 2026-08-12 raw numbers imply if both circles went left. */
const SWAPPED = w => ({ beta: w[0], gamma: w[2], alpha: w[1] });
/** The same swap composed with a sign flip, which is a proper rotation. The
 *  solver must tell this apart from SWAPPED and call it right-handed. */
const SWAPPED_RH = w => ({ beta: w[0], gamma: w[2], alpha: -w[1] });
/** A spec device whose gyro reads 10% high — tests the scale measurement. */
const HOT = w => ({ beta: w[0] * 1.1, gamma: w[1] * 1.1, alpha: w[2] * 1.1 });

/* --------------------------------------------------------------- the poses
 * q maps device → world. Identity therefore means the phone lies flat with
 * its screen at the sky, which is where the yaw test starts. */
const FLAT = [1, 0, 0, 0];
/** Upright, top edge at the zenith, screen toward the operator. */
const UPRIGHT = qAxisAngle([1, 0, 0], 90);
/** The same, tipped ~35° back — how anyone actually holds a phone. */
const HELD = qMul(qAxisAngle([1, 0, 0], 55), qAxisAngle([0, 0, 1], 20));

const DT_MS = 20;

/**
 * Run one calibration motion.
 *
 * Phases are { ms, rate, worldAxis | deviceAxis, wobble }: `worldAxis` turns
 * about a fixed direction in the world (what a person does turning on the
 * spot), `deviceAxis` turns about an axis fixed in the phone (the tumble).
 */
function runMotion(o, kind, model, startPose, phases) {
  let q = startPose.slice();
  let t = o._simClock || 1000;
  o.beginSpinDiagnostic(kind);
  for (const ph of phases) {
    for (let e = 0; e < ph.ms; e += DT_MS) {
      const dt = DT_MS / 1000;
      const axis = ph.deviceAxis ? ph.deviceAxis : qRot(qConj(q), ph.worldAxis || [0, 0, 1]);
      const am = Math.hypot(...axis) || 1;
      const wob = ph.wobble || 0;
      const w = [
        (ph.rate || 0) * axis[0] / am + wob * Math.sin(e / 260),
        (ph.rate || 0) * axis[1] / am + wob * Math.sin(e / 190 + 1.1),
        (ph.rate || 0) * axis[2] / am + wob * Math.sin(e / 330 + 2.3)
      ];
      const mag = Math.hypot(...w);
      q = qNorm(qMul(q, qAxisAngle(w, mag * dt)));
      t += DT_MS;
      o.quat = q;
      o._orientationSeen = true;
      const up = qRot(qConj(q), [0, 0, 1]);
      o._onMotion({
        timeStamp: t,
        rotationRate: model(w),
        accelerationIncludingGravity: { x: up[0] * 9.8, y: up[1] * 9.8, z: up[2] * 9.8 }
      });
    }
  }
  o._simClock = t;
  return { result: o.finishSpinDiagnostic(), q };
}

/** The three tests as a sloppy human performs them: idle at each end, a hold
 *  that is never level, and circles that are nowhere near exactly 360°. */
function humanRun(o, model, { yawDeg = 340, rollDeg = 385, pitchDeg = 300, wobble = 9 } = {}) {
  runMotion(o, 'yaw', model, FLAT, [
    { ms: 900, rate: 0, wobble: 3 },
    { ms: 5000, rate: yawDeg / 5, worldAxis: [0, 0, 1], wobble },
    { ms: 900, rate: 0, wobble: 3 }
  ]);
  runMotion(o, 'roll', model, HELD, [
    { ms: 1200, rate: 0, wobble: 4 },
    { ms: 6000, rate: rollDeg / 6, worldAxis: [0, 0, 1], wobble: wobble + 4 },
    { ms: 1200, rate: 0, wobble: 4 }
  ]);
  runMotion(o, 'pitch', model, UPRIGHT, [
    { ms: 800, rate: 0, wobble: 3 },
    { ms: 6000, rate: pitchDeg / 6, deviceAxis: [1, 0, 0], wobble: 5 },
    { ms: 800, rate: 0, wobble: 3 }
  ]);
}

console.log('=== The field phone (y/z swapped), tests done by a human ===');
{
  const o = new OrientationSource(() => {});
  humanRun(o, SWAPPED);
  const s = o.solveGyroAxisMap();
  check('solves', s.status === 'remapped', `status ${s.status}${s.resid !== undefined ? `, residual ${s.resid}` : ''}`);
  check('recovers the y/z swap', JSON.stringify(s.perm) === '[0,2,1]', `perm ${JSON.stringify(s.perm)}`);
  check('no axis is inverted', JSON.stringify(s.signs) === '[1,1,1]', `signs ${JSON.stringify(s.signs)}`);
  check('a bare swap is reported as the mirrored triad it is', s.leftHanded === true);
  check('the wrong axis order is far behind', s.margin > 0.4, `next-best ${s.margin} vs ${s.resid}`);
  check('map is installed on the source', JSON.stringify(o.gyroAxisMap?.perm) === '[0,2,1]');
  check('a human hold settles the signs without assuming a direction',
    s.decidedBy === 'kinematics' && s.assumedDirection === false, `decided by ${s.decidedBy}`);

  // The point of the whole exercise: after the map, a turn about vertical must
  // project into survey yaw at full size and in the app's sign convention.
  o._onOrientation({ alpha: 0, beta: 90, gamma: 0 });
  const before = o.gyroYaw;
  runMotion(o, 'roll', SWAPPED, UPRIGHT, [{ ms: 5000, rate: 72, worldAxis: [0, 0, 1] }]);
  const projected = o.gyroYaw - before;
  check('a full turn now projects as a full turn', Math.abs(Math.abs(projected) - 360) < 25,
    `${projected.toFixed(1)}° for a physical 360°`);
  check('counter-clockwise projects negative', projected < 0);
}

console.log('=== A spec-compliant phone is left alone ===');
{
  const o = new OrientationSource(() => {});
  humanRun(o, SPEC);
  const s = o.solveGyroAxisMap();
  check('identity is recognised', s.status === 'identity', `status ${s.status}, residual ${s.resid}`);
  check('no map is installed', o.gyroAxisMap === null);
}

console.log('=== Circles nowhere near 360° are fine ===');
{
  const o = new OrientationSource(() => {});
  humanRun(o, SWAPPED, { yawDeg: 250, rollDeg: 470, pitchDeg: 265 });
  const s = o.solveGyroAxisMap();
  check('a 250°/470° pair still solves', s.status === 'remapped', `status ${s.status}`);
  check('still the y/z swap', JSON.stringify(s.perm) === '[0,2,1]', `perm ${JSON.stringify(s.perm)}`);
}

console.log('=== Gyro scale comes from gravity, not from the operator ===');
{
  const o = new OrientationSource(() => {});
  // Deliberately ragged circles, so any scale read off "assume that was 360°"
  // would be wrong by tens of percent.
  humanRun(o, HOT, { yawDeg: 300, rollDeg: 430, pitchDeg: 280 });
  const s = o.solveGyroAxisMap();
  check('identity map on a spec-wired phone', s.status === 'identity', `status ${s.status}`);
  check('scale recovers the 10% error', Math.abs(s.scaleFromSweep - 1 / 1.1) < 0.03,
    `measured ${s.scaleFromSweep}, true ${(1 / 1.1).toFixed(4)}`);
  check('scale is applied', s.scaleApplied === true && Math.abs(o.gyroScale - 1 / 1.1) < 0.03,
    `gyroScale ${o.gyroScale.toFixed(4)}`);
}

console.log('=== A mirrored triad is told apart from a mere swap ===');
{
  const o = new OrientationSource(() => {});
  humanRun(o, SWAPPED_RH);
  const s = o.solveGyroAxisMap();
  check('solves', s.status === 'remapped', `status ${s.status}`);
  check('same axis order', JSON.stringify(s.perm) === '[0,2,1]', `perm ${JSON.stringify(s.perm)}`);
  // Reported alpha carries -ω_y, so recovering ω_y means reading reported
  // index 2 and negating it: perm [0,2,1] with signs [1,-1,1].
  check('with the inverted axis found', JSON.stringify(s.signs) === '[1,-1,1]', `signs ${JSON.stringify(s.signs)}`);
  check('and reported right-handed', s.leftHanded === false);
}

console.log('=== Turning the wrong way, on a hold that has any wobble at all ===');
{
  // Both circles clockwise, held by a person. Two degrees per second of tremor
  // is enough for the kinematics to work the signs out on its own, so the
  // operator is NOT punished for turning right — the map still comes out
  // correct and the direction is merely noted.
  const o = new OrientationSource(() => {});
  runMotion(o, 'yaw', SPEC, FLAT, [{ ms: 5000, rate: -70, worldAxis: [0, 0, 1], wobble: 6 }]);
  runMotion(o, 'roll', SPEC, HELD, [{ ms: 5000, rate: -70, worldAxis: [0, 0, 1], wobble: 8 }]);
  runMotion(o, 'pitch', SPEC, UPRIGHT, [{ ms: 5000, rate: 60, deviceAxis: [1, 0, 0], wobble: 5 }]);
  const s = o.solveGyroAxisMap();
  check('the correct map is still found', s.status === 'identity', `status ${s.status}`);
  check('decided by physics, not by the instruction', s.decidedBy === 'kinematics');
  check('and the clockwise turn is noticed', s.turnedClockwise === true);
}

console.log('=== Turning the wrong way on a rig too steady to tell ===');
{
  // With gravity mathematically fixed in the device frame, both sign choices
  // fit the data exactly and no amount of cleverness separates them. The
  // solver must lean on the instruction and SAY that it did.
  const o = new OrientationSource(() => {});
  runMotion(o, 'yaw', SPEC, FLAT, [{ ms: 5000, rate: -70, worldAxis: [0, 0, 1] }]);
  runMotion(o, 'roll', SPEC, UPRIGHT, [{ ms: 5000, rate: -70, worldAxis: [0, 0, 1] }]);
  runMotion(o, 'pitch', SPEC, UPRIGHT, [{ ms: 5000, rate: 60, deviceAxis: [1, 0, 0] }]);
  const s = o.solveGyroAxisMap();
  check('a map is produced', s.status === 'identity' || s.status === 'remapped', `status ${s.status}`);
  check('the assumption is declared, not hidden', s.assumedDirection === true && s.decidedBy === 'direction');
}

console.log('=== Two circles that went opposite ways ===');
{
  const o = new OrientationSource(() => {});
  runMotion(o, 'yaw', SPEC, FLAT, [{ ms: 5000, rate: 70, worldAxis: [0, 0, 1], wobble: 0.5 }]);
  runMotion(o, 'roll', SPEC, UPRIGHT, [{ ms: 5000, rate: -70, worldAxis: [0, 0, 1], wobble: 0.5 }]);
  runMotion(o, 'pitch', SPEC, UPRIGHT, [{ ms: 5000, rate: 60, deviceAxis: [1, 0, 0], wobble: 0.5 }]);
  const s = o.solveGyroAxisMap();
  check('reported as mixed directions', s.status === 'mixed-direction', `status ${s.status}`);
}

console.log('=== Three motions that never separated the axes ===');
{
  const o = new OrientationSource(() => {});
  for (const kind of ['yaw', 'roll', 'pitch']) {
    runMotion(o, kind, SWAPPED, FLAT, [{ ms: 5000, rate: 70, worldAxis: [0, 0, 1], wobble: 0.5 }]);
  }
  const s = o.solveGyroAxisMap();
  check('refuses rather than guessing an axis order',
    s.status === 'ambiguous' || s.status === 'no-direction-evidence', `status ${s.status}`);
  check('nothing is applied', o.gyroAxisMap === null);
}

console.log('=== Barely moving is named honestly ===');
{
  const o = new OrientationSource(() => {});
  runMotion(o, 'yaw', SPEC, FLAT, [{ ms: 2000, rate: 4, worldAxis: [0, 0, 1] }]);
  runMotion(o, 'roll', SPEC, UPRIGHT, [{ ms: 2000, rate: 4, worldAxis: [0, 0, 1] }]);
  runMotion(o, 'pitch', SPEC, UPRIGHT, [{ ms: 2000, rate: 4, deviceAxis: [1, 0, 0] }]);
  const s = o.solveGyroAxisMap();
  check('too little rotation is reported as such',
    s.status === 'insufficient-data' || s.status === 'too-little-rotation', `status ${s.status}`);
}

console.log('=== Each motion is classified from what happened, not its label ===');
{
  const o = new OrientationSource(() => {});
  const yaw = runMotion(o, 'yaw', SPEC, FLAT, [{ ms: 5000, rate: 70, worldAxis: [0, 0, 1], wobble: 9 }]).result;
  const pitch = runMotion(o, 'pitch', SPEC, UPRIGHT, [{ ms: 5000, rate: 70, deviceAxis: [1, 0, 0] }]).result;
  check('a wobbly turn still reads as about-vertical', yaw.motion === 'about-vertical',
    `${yaw.motion}, sweep ratio ${yaw.sweepRatio?.toFixed(2)}`);
  check('a tumble reads as a tumble', pitch.motion === 'tumble',
    `${pitch.motion}, sweep ratio ${pitch.sweepRatio?.toFixed(2)}`);
  check('the tumble sweeps roughly the angle it turned',
    Math.abs(pitch.sweepDeg - 350) < 40, `swept ${pitch.sweepDeg.toFixed(0)}° for a 350° tumble`);
}

console.log('=== Works from the accelerometer alone if orientation is missing ===');
{
  const o = new OrientationSource(() => {});
  const patched = Object.create(o);
  humanRun(o, SWAPPED);
  // Re-run with the orientation stream suppressed: the fallback path takes
  // world-up from accelerationIncludingGravity instead.
  const o2 = new OrientationSource(() => {});
  const realOnMotion = o2._onMotion.bind(o2);
  o2._onMotion = e => { o2._orientationSeen = false; realOnMotion(e); };
  humanRun(o2, SWAPPED);
  const s2 = o2.solveGyroAxisMap();
  check('accelerometer fallback still recovers the swap',
    s2.status === 'remapped' && JSON.stringify(s2.perm) === '[0,2,1]',
    `status ${s2.status}, perm ${JSON.stringify(s2.perm)}`);
  void patched;
}

console.log('=== Bias is measured only from a phone that was actually still ===');
{
  const o = new OrientationSource(() => {});
  o.beginStationaryDiagnostic();
  let seed = 5;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  // The 2026-08-12 numbers: a phone still in the operator's hand.
  for (let t = 0; t <= 4000; t += 30) {
    o._onMotion({
      timeStamp: 1000 + t,
      rotationRate: { beta: 8 + rnd() * 50, gamma: 2 + rnd() * 30, alpha: -7 + rnd() * 60 },
      accelerationIncludingGravity: { x: rnd(), y: 8 + rnd() * 2, z: 4.6 + rnd() * 3 }
    });
  }
  const r = o.finishStationaryDiagnostic();
  check('handheld bias is refused', !r.biasApplied, r.biasRefusedReason);

  const o2 = new OrientationSource(() => {});
  o2.beginStationaryDiagnostic();
  for (let t = 0; t <= 4000; t += 30) {
    o2._onMotion({
      timeStamp: 1000 + t,
      rotationRate: { beta: 0.6, gamma: -0.3, alpha: 0.4 },
      accelerationIncludingGravity: { x: 0.01, y: 0.02, z: 9.81 }
    });
  }
  const r2 = o2.finishStationaryDiagnostic();
  check('a genuinely still phone is trusted', r2.biasApplied === true, r2.biasRefusedReason || '');
  check('and its bias is recovered', Math.abs(o2.gyroBias[0] - 0.6) < 0.05, `x bias ${o2.gyroBias[0].toFixed(3)}`);
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exitCode = 1; }
else console.log('\nall three-axis calibration checks passed');
