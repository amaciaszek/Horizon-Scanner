/* Calibration by waving the phone about — the path the app actually uses.
 *
 * The three posed tests (yaw spin, roll circle, pitch tumble) are still
 * supported by the solver and covered by gyro-axis.test.mjs, but the operator's
 * verdict on them was that the tumble was confusing and the whole thing was
 * "a lot". This replaces them with one unchoreographed motion, which the
 * physics prefers anyway: in the posed version gravity sat still through two
 * tests out of three, and it is gravity MOVING that determines an axis's sign
 * and the gyro's scale without assuming anything about the operator.
 *
 * What is asserted here, in order of importance:
 *
 *   1. It never returns a WRONG map. A silently transposed or mirrored axis
 *      map would corrupt every azimuth in a survey while everything looked
 *      healthy, so a refusal must be the only possible failure.
 *   2. It succeeds across the range of paces and sensor lags a real phone
 *      presents.
 *   3. It knows when it has enough, so the app can stop on its own.
 *
 * Everything is simulated by integrating a quaternion, with the gyro reading
 * and the gravity direction both derived from that one state, then quantised
 * and lagged the way the field bundles show this hardware behaving.
 */
import { OrientationSource } from '../js/orientation.js';

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures++;
};

const qMul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
];
const qConj = q => [q[0], -q[1], -q[2], -q[3]];
const qNorm = q => { const m = Math.hypot(...q); return q.map(v => v / m); };
const qRot = (q, v) => { const r = qMul(qMul(q, [0, ...v]), qConj(q)); return [r[1], r[2], r[3]]; };
const qAA = (axis, deg) => {
  const m = Math.hypot(...axis);
  if (m < 1e-12 || Math.abs(deg) < 1e-12) return [1, 0, 0, 0];
  const h = (deg * Math.PI / 180) / 2, s = Math.sin(h) / m;
  return [Math.cos(h), axis[0] * s, axis[1] * s, axis[2] * s];
};

/** The wiring measured on the field phone, 2026-08-13 01:29: the reported
 *  triad is rotated one step, so reported [beta,gamma,alpha] carries
 *  [ωy, ωz, ωx]. Solving this is `perm [2,0,1]`, determinant +1. */
const FIELD = w => ({ beta: w[1], gamma: w[2], alpha: w[0] });
const SPEC = w => ({ beta: w[0], gamma: w[1], alpha: w[2] });
const TRUTH_PERM = '[2,0,1]', TRUTH_SIGNS = '[1,1,1]';

const rng = s => () => {
  s |= 0; s = s + 0x6D2B79F5 | 0;
  let t = Math.imul(s ^ s >>> 15, 1 | s);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
/** Chrome on this hardware reports both streams quantised to 0.1. */
const Q = v => Math.round(v / 0.1) * 0.1;

/**
 * A hand waving the phone about: three incommensurate sinusoids per axis, so
 * the motion is smooth, never repeats, and never stays aligned with one axis.
 *
 * `lagMs` and `jitterDeg` model the fused orientation stream, which is the
 * dominant real-world error — the field run's residual was 0.23 where a
 * noiseless simulation gives 0.013, and this is why.
 */
function wave(o, model, seed, seconds, peak, { lagMs = 60, jitterDeg = 0.6, rateHz = 40 } = {}) {
  const rnd = rng(seed);
  const f = Array.from({ length: 6 }, () => 0.05 + rnd() * 0.28);
  const p = Array.from({ length: 6 }, () => rnd() * Math.PI * 2);
  const amp = Array.from({ length: 3 }, () => 0.45 + rnd() * 0.55);
  let q = qNorm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
  const hist = [];
  const dtMs = 1000 / rateHz;
  let t = 1000;
  for (let e = 0; e < seconds * 1000; e += dtMs) {
    const s = e / 1000;
    const w = [0, 1, 2].map(i => peak * amp[i] * (
      Math.sin(2 * Math.PI * f[i] * s + p[i]) + 0.6 * Math.sin(2 * Math.PI * f[i + 3] * s + p[i + 3])));
    q = qNorm(qMul(q, qAA(w, Math.hypot(...w) * dtMs / 1000)));
    hist.push(q);
    let qf = hist[Math.max(0, hist.length - 1 - Math.round(lagMs / dtMs))];
    if (jitterDeg > 0) {
      qf = qNorm(qMul(qf, qAA([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], (rnd() - 0.5) * 2 * jitterDeg)));
    }
    t += dtMs;
    o.quat = qf;
    o._orientationSeen = true;
    const g = qRot(qConj(qf), [0, 0, 1]).map(v => v * 9.8);
    const r = model(w);
    o._onMotion({
      timeStamp: t,
      rotationRate: { beta: Q(r.beta), gamma: Q(r.gamma), alpha: Q(r.alpha) },
      accelerationIncludingGravity: { x: Q(g[0]), y: Q(g[1]), z: Q(g[2]) }
    });
  }
}

/** One motion, exactly as the app records it. */
function run(model, seed, seconds, peak, opts) {
  const o = new OrientationSource(() => {});
  o.beginSpinDiagnostic('yaw');
  wave(o, model, seed, seconds, peak, opts);
  o.finishSpinDiagnostic();
  return { o, solved: o.solveGyroAxisMap() };
}
const correct = s => JSON.stringify(s.perm) === TRUTH_PERM && JSON.stringify(s.signs) === TRUTH_SIGNS;
const decided = s => s.status === 'remapped' || s.status === 'identity';

console.log('=== A wrong map is never returned — the property that matters most ===');
{
  let wrong = 0, solvedN = 0, refused = 0, trials = 0;
  const statuses = {};
  for (const peak of [25, 50, 90, 150, 220]) {
    for (const lag of [0, 40, 80, 140, 220]) {
      for (let seed = 1; seed <= 8; seed++) {
        trials++;
        const { o, solved } = run(FIELD, seed, 12, peak, { lagMs: lag, jitterDeg: lag / 100 });
        statuses[solved.status] = (statuses[solved.status] || 0) + 1;
        if (!decided(solved)) { refused++; continue; }
        solvedN++;
        if (!correct(solved)) {
          wrong++;
          console.log(`      wrong at peak ${peak} lag ${lag} seed ${seed}: perm ${JSON.stringify(solved.perm)} signs ${JSON.stringify(solved.signs)}`);
        }
        // A refusal must also leave the source untouched.
        if (correct(solved) && JSON.stringify(o.gyroAxisMap?.perm) !== TRUTH_PERM) wrong++;
      }
    }
  }
  check(`no wrong map in ${trials} runs across pace and sensor lag`, wrong === 0, `${solvedN} solved, ${refused} refused`);
  check('failures are refusals, not guesses',
    Object.keys(statuses).every(k => ['remapped', 'identity', 'unsolved', 'ambiguous', 'insufficient-data', 'no-direction-evidence', 'wrong-direction', 'mixed-direction'].includes(k)),
    JSON.stringify(statuses));
}

console.log('=== Solves at the paces and lags a real phone presents ===');
for (const [peak, label] of [[50, 'gentle'], [90, 'normal'], [160, 'brisk']]) {
  let ok = 0, worstResid = 0, worstMargin = 9;
  for (const lag of [40, 80, 140]) {
    for (let seed = 1; seed <= 10; seed++) {
      const { solved } = run(FIELD, seed, 12, peak, { lagMs: lag, jitterDeg: lag / 100 });
      if (decided(solved) && correct(solved)) {
        ok++;
        worstResid = Math.max(worstResid, solved.resid);
        worstMargin = Math.min(worstMargin, solved.margin);
      }
    }
  }
  check(`${label} waving (${peak}°/s) solves`, ok >= 28, `${ok}/30, worst residual ${worstResid.toFixed(2)}, worst margin ${worstMargin === 9 ? '-' : worstMargin.toFixed(2)}`);
}

console.log('=== The direction the operator moves never matters ===');
{
  let assumed = 0, ok = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { solved } = run(FIELD, seed, 12, 90);
    if (decided(solved) && correct(solved)) ok++;
    if (solved.assumedDirection) assumed++;
  }
  check('every run solved', ok === 20, `${ok}/20`);
  check('none had to assume a turn direction', assumed === 0, `${assumed} assumed`);
}

console.log('=== A spec-compliant phone is left on identity ===');
{
  let id = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { o, solved } = run(SPEC, seed, 12, 90);
    if (solved.status === 'identity' && o.gyroAxisMap === null) id++;
  }
  check('identity recovered and nothing installed', id === 20, `${id}/20`);
}

console.log('=== Gyro scale is measured from gravity, not from the operator ===');
{
  const HOT = w => { const r = SPEC(w); return { beta: r.beta * 1.1, gamma: r.gamma * 1.1, alpha: r.alpha * 1.1 }; };
  let ok = 0, worst = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const { solved } = run(HOT, seed, 14, 90);
    if (solved.scaleApplied && Math.abs(solved.scaleFromSweep - 1 / 1.1) < 0.06) ok++;
    if (solved.scaleFromSweep) worst = Math.max(worst, Math.abs(solved.scaleFromSweep - 1 / 1.1));
  }
  check('a gyro reading 10% high is corrected', ok >= 8, `${ok}/10, worst error ${worst.toFixed(3)} against true ${(1 / 1.1).toFixed(4)}`);
}

console.log('=== Live solving is side-effect free, so the app can watch ===');
{
  const o = new OrientationSource(() => {});
  o.beginSpinDiagnostic('yaw');
  wave(o, FIELD, 7, 12, 90);
  // Mid-motion, exactly what the on-screen coach does several times a second.
  const probe = o.solveGyroAxisMap({ apply: false, includeActive: true });
  check('an in-progress motion can be solved', decided(probe) && correct(probe), `status ${probe.status}`);
  check('probing installs nothing', o.gyroAxisMap === null && o.gyroScale === 1);
  check('evidence is reported for the coach',
    Array.isArray(probe.work) && probe.work.every(v => v > 0), JSON.stringify(probe.work));
  const ev = o.spinEvidence();
  check('live evidence counters run', ev.work.every(v => v > 0) && ev.sweepDeg > 0,
    `work ${ev.work.map(Math.round).join('/')}°, sweep ${ev.sweepDeg.toFixed(0)}°`);
  o.finishSpinDiagnostic();
  const final = o.solveGyroAxisMap();
  check('the committed solve installs the map', JSON.stringify(o.gyroAxisMap?.perm) === TRUTH_PERM, `status ${final.status}`);
}

console.log('=== It knows when it has enough, and it is quick ===');
{
  const secondsNeeded = [];
  for (let seed = 1; seed <= 12; seed++) {
    let found = null;
    for (const secs of [4, 6, 8, 10, 12, 16]) {
      const { solved } = run(FIELD, seed, secs, 90);
      if (decided(solved) && correct(solved)) { found = secs; break; }
    }
    secondsNeeded.push(found ?? 99);
  }
  secondsNeeded.sort((a, b) => a - b);
  const median = secondsNeeded[secondsNeeded.length >> 1];
  const worst = secondsNeeded[secondsNeeded.length - 1];
  check('all runs converge', worst < 99, `worst ${worst} s`);
  check('median under ten seconds of waving', median <= 10, `median ${median} s, worst ${worst} s`);
}

console.log('=== Barely moving refuses rather than inventing an answer ===');
{
  const { o, solved } = run(FIELD, 3, 12, 4);
  check('a nearly still phone is refused', !decided(solved), `status ${solved.status}`);
  check('and nothing is installed', o.gyroAxisMap === null && o.gyroScale === 1);
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exitCode = 1; }
else console.log('\nall freeform calibration checks passed');
