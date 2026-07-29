/* Can a mid-scan lens swap be detected and survived?
 *
 * A phone that exposes one logical rear camera can switch physical sensors
 * without changing deviceId, resolution, or anything else getSettings() reports.
 * What it cannot hide is focal length: main and ultra-wide differ by roughly
 * 30-40%, so the pixel shift produced by a given rotation changes by that
 * factor the instant the swap happens.
 *
 * This detection only became possible once rotation came from a gyroscope. The
 * third case below shows why: against a magnetometer-grade rotation estimate the
 * focal samples scatter too widely for a step to be visible.
 */
import { Survey } from '../js/survey.js';
import { DEG, quatFromEuler, quatNormalize } from '../js/math3d.js';

let seed = 20260729;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

/** Feed samples consistent with a lens of focal `f`, rotating at ~4 deg/frame. */
function feed(sv, f, n, rotNoiseDeg = 0) {
  let detected = null;
  for (let i = 0; i < n; i++) {
    const trueRot = 4 + rnd() * 1.5;
    const measuredRot = trueRot + rnd() * rotNoiseDeg;
    const dx = f * Math.tan(trueRot * DEG);
    const hit = sv.addFocalSample(dx, measuredRot, 5, 0.85);
    if (hit && !detected) detected = hit;
  }
  return detected;
}

console.log('--- clean gyro: main lens, then a swap to ultra-wide ---');
{
  const sv = new Survey();
  feed(sv, 220, 60);                       // main lens, focal 220 px
  sv.establishFocal(sv.focalPx);
  console.log(`  established focal : ${sv.focalPx.toFixed(1)} px`);
  const change = feed(sv, 145, 60);        // ultra-wide, focal 145 px
  if (change) {
    console.log(`  detected swap     : ${change.from.toFixed(1)} -> ${change.to.toFixed(1)} px  (ratio ${change.ratio.toFixed(2)})`);
    console.log('  PASS - swap detected from the imagery alone\n');
  } else {
    console.log('  FAIL - swap not detected\n');
  }
}

console.log('--- no swap: a settled lens must not produce false alarms ---');
{
  const sv = new Survey();
  feed(sv, 220, 60);
  sv.establishFocal(sv.focalPx);
  const change = feed(sv, 220, 300);       // same lens, long run
  console.log(`  lens changes reported: ${sv.lensChanges.length}`);
  console.log(`  ${!change && sv.lensChanges.length === 0 ? 'PASS' : 'FAIL'} - a steady lens must stay quiet\n`);
}

console.log('--- magnetometer-grade rotation noise: detection is not possible ---');
{
  const sv = new Survey();
  feed(sv, 220, 80, 25);                   // +-12 deg of rotation error
  sv.establishFocal(sv.focalPx || 220);
  feed(sv, 145, 80, 25);
  console.log(`  lens changes reported: ${sv.lensChanges.length}  (with a clean gyro: 1)`);
  console.log('  This is why the gyroscope fix had to come first.\n');
}

console.log('--- keyframes keep the intrinsics they were captured with ---');
{
  const sv = new Survey();
  // Two keyframes of the same scene, captured through different lenses. Each
  // stores its own tanHalf, so both must reproject to the same altitude.
  // Phone held upright (beta = 90), camera at the horizon. An identity
  // quaternion would mean the phone is flat on its back, pointing at the ground.
  const upright = quatNormalize(quatFromEuler(0, 90, 0));
  const mk = (tanH, tanV, boundaryRow) => ({
    quat: upright, pass: 1, height: 288,
    boundary: new Float32Array(64).fill(boundaryRow),
    confidence: new Float32Array(64).fill(0.9),
    flags: new Uint8Array(64),
    tanHalfH: tanH, tanHalfV: tanV
  });
  const wide = Math.tan(107 / 2 * DEG);
  const main = Math.tan(82 / 2 * DEG);
  sv.addKeyframe(mk(main, main * 288 / 384, 100));
  sv.addKeyframe(mk(wide, wide * 288 / 384, 100));
  sv.reproject({ tanHalfH: main, tanHalfV: main * 288 / 384 });

  const withAlt = sv.bins.filter(b => b.obs.length);
  const alts = withAlt.flatMap(b => b.obs.map(o => o.value));
  const lo = Math.min(...alts), hi = Math.max(...alts);
  console.log(`  altitudes spanned : ${lo.toFixed(1)}° to ${hi.toFixed(1)}°`);
  console.log(`  ${hi - lo > 3 ? 'PASS' : 'FAIL'} - the two lenses must project differently, proving per-keyframe intrinsics are in use`);
  console.log('  (a single global focal would collapse both to the same altitude)');
}
