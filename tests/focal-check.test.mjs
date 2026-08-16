/* Measuring the lens from repeat views, against a synthetic world.
 *
 * The estimator itself was chosen by measurement, not by taste. Solving focal
 * length inside the rotation bundle adjustment was implemented first and then
 * run against the 2026-08-15 field capture, where sweeping focal across plus or
 * minus fourteen percent and re-solving the rotations at each step moved the
 * mean pairwise disagreement only from 1.147 to 1.183 degrees. Parallax from a
 * house twelve metres away dominates that cost surface, so the solver returned
 * 0.99 where the truth was 1.07 — a confident number that was purely the shape
 * of the noise.
 *
 * Repeat views measure it properly. Two photographs of the same bearing from
 * different laps are taken from the same standing position, so parallax largely
 * cancels; they differ by an elevation that gravity measured directly. How far
 * the scenery slid vertically over how far the camera tilted IS the focal
 * length. Run over the real capture's own photographs at 220 features per
 * frame, every combination of thresholds tried put the vertical field of view
 * between 48.1 and 48.8 degrees against an offline reference of 48.2, with
 * correlations from 0.994 to 0.998. At 160 features the same code wandered
 * between 49.6 and 50.8, which is why the density is pinned upstream.
 */
import { extractFeatures } from '../js/bundle.js';
import { crossLapFocalCheck } from '../js/focal-check.js';
import { quatMul, quatRotate, quatFromAxisAngle, cameraRay, DEG, RAD } from '../js/math3d.js';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const rng = s => () => {
  s |= 0; s = s + 0x6D2B79F5 | 0;
  let t = Math.imul(s ^ s >>> 15, 1 | s);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

const OBJECTS = (() => {
  const r = rng(20260816);
  return Array.from({ length: 1600 }, () => ({
    az: (r() * 2 - 1) * Math.PI,
    alt: (r() - 0.5) * 1.4,
    s: 0.004 + r() * 0.016,
    a: (r() * 2 - 1) * 90
  }));
})();

function worldTexture(d) {
  const az = Math.atan2(d[0], d[1]), alt = Math.asin(Math.max(-1, Math.min(1, d[2])));
  let v = 128 + 26 * Math.sin(alt * 2.2);
  for (const o of OBJECTS) {
    let dz = az - o.az;
    if (dz > Math.PI) dz -= 2 * Math.PI; else if (dz < -Math.PI) dz += 2 * Math.PI;
    const dy = alt - o.alt;
    const q = (dz * dz + dy * dy) / (o.s * o.s);
    if (q < 9) v += o.a * Math.exp(-q * 0.5);
  }
  return Math.max(8, Math.min(247, v));
}

const TW = 200, TH = 267;                       // portrait, like the corrected frames
const TRUE_TAN_V = Math.tan(48.26 / 2 * DEG);   // the lens the camera really has
const TRUE_TAN_H = TRUE_TAN_V * (TW / TH);
const STATED_SCALE = 1 / 1.0655;                // the pinned known-device entry
const STATED_TAN_V = TRUE_TAN_V * STATED_SCALE;
const STATED_TAN_H = TRUE_TAN_H * STATED_SCALE;

function render(q) {
  const data = new Uint8ClampedArray(TW * TH * 4);
  for (let py = 0; py < TH; py++) {
    for (let px = 0; px < TW; px++) {
      const u = (px + 0.5) / TW * 2 - 1, v = 1 - (py + 0.5) / TH * 2;
      const val = worldTexture(quatRotate(q, cameraRay(u, v, TRUE_TAN_H, TRUE_TAN_V)));
      const p = (py * TW + px) * 4;
      data[p] = data[p + 1] = data[p + 2] = val; data[p + 3] = 255;
    }
  }
  return { w: TW, h: TH, data };
}

// Rx(90) puts the rear camera on the horizon; adding the elevation raises it.
// The sign matters and is not a matter of taste: with (90 - elevation) the
// camera looks DOWN as elevation rises, the fitted tangent comes out negative,
// and the check correctly reports a degenerate fit rather than a lens.
const poseAt = (yawDeg, elevationDeg) => quatMul(
  quatFromAxisAngle(0, 0, 1, yawDeg * DEG),
  quatFromAxisAngle(1, 0, 0, (90 + elevationDeg) * DEG)
);

/**
 * Two laps of the same ring. The operator does not hold the same elevation
 * twice — that variation is not noise here, it is the measurement.
 */
function buildSurvey({ count = 16, stepDeg = 22, lap2Offset = 7, statedScale = 1 } = {}) {
  const keyframes = [], sources = [];
  const push = (yaw, elevation, t, pass) => {
    const q = poseAt(yaw, elevation);
    sources.push(render(q));
    keyframes.push({
      index: keyframes.length, t, pass, captureKind: 'sweep',
      tanHalfH: TRUE_TAN_H * statedScale, tanHalfV: TRUE_TAN_V * statedScale,
      quat: q, yawFused: yaw, yawBase: 0, yawCorrection: 0,
      elevation, boundary: null, height: TH
    });
  };
  for (let i = 0; i < count; i++) push(i * stepDeg, 4 + 10 * Math.sin(i * 0.9), 1000 + i * 2000, 1);
  for (let i = 0; i < count; i++) {
    // The elevation difference between laps must VARY, and vary in sign. A
    // constant offset gives a perfectly usable set of pairs that between them
    // contain one data point, and a regression through one point is not a
    // measurement — it is a division.
    const delta = lap2Offset * Math.cos(i * 0.7);
    push(i * stepDeg + 1.5, 4 + 10 * Math.sin(i * 0.9) + delta, 1000 + (count + i) * 2000, 2);
  }
  return { keyframes, sources };
}

const featuresFor = (sources, keyframes, target = 220) =>
  sources.map((s, i) => extractFeatures(s, keyframes[i], { target }));

console.log('=== A pinned lens that is 6% wrong is measured back out ===');
{
  const { keyframes, sources } = buildSurvey({ statedScale: STATED_SCALE });
  const features = featuresFor(sources, keyframes);
  const r = crossLapFocalCheck({ keyframes, features });
  console.log(`   ${r.pairCount} repeat-view pairs, correlation ${r.correlation?.toFixed(4)}`);
  for (const row of r.pairs.slice(0, 4)) {
    console.log(`     ${row.from}->${row.to}  dElev ${row.elevationChangeDeg.toFixed(2)}°  ` +
      `medianShiftV ${row.medianShiftV.toFixed(4)}  (${row.matchCount} matches)`);
  }
  console.log(`   stated ${r.statedVfovDeg.toFixed(2)}° -> fitted ${r.fittedVfovDeg?.toFixed(2)}°`);
  check('the measurement is trusted', r.measured === true, r.reason);
  check('shift tracks elevation almost perfectly', r.correlation > 0.97, `${r.correlation?.toFixed(4)}`);
  check('recovers the field of view to within 1°',
    Math.abs(r.fittedVfovDeg - 48.26) < 1.0, `${r.fittedVfovDeg?.toFixed(2)}° vs 48.26°`);
  check('scale points the right way and is roughly right',
    r.scale > 1.03 && r.scale < 1.10, `${r.scale.toFixed(4)} (need ~1.0655)`);
}

console.log('\n=== A correct lens is not disturbed ===');
{
  const { keyframes, sources } = buildSurvey({ statedScale: 1 });
  const r = crossLapFocalCheck({ keyframes, features: featuresFor(sources, keyframes) });
  console.log(`   ${r.pairCount} pairs, fitted ${r.fittedVfovDeg?.toFixed(2)}°`);
  check('stays within 2% of unity', Math.abs(r.scale - 1) < 0.02, `${r.scale.toFixed(4)}`);
}

console.log('\n=== Without a second lap there is nothing to measure ===');
{
  const { keyframes, sources } = buildSurvey({ statedScale: STATED_SCALE });
  const single = keyframes.filter(k => k.pass === 1);
  const singleSources = sources.slice(0, single.length);
  const r = crossLapFocalCheck({
    keyframes: single, features: featuresFor(singleSources, single)
  });
  check('refuses rather than guessing', r.measured === false, r.reason);
  check('leaves the lens exactly alone', r.scale === 1, `${r.scale}`);
}

console.log('\n=== Repeat views at the same elevation carry no information ===');
{
  // Both laps flown at identical elevation: plenty of matches, zero lever arm.
  const { keyframes, sources } = buildSurvey({ statedScale: STATED_SCALE, lap2Offset: 0 });
  const r = crossLapFocalCheck({ keyframes, features: featuresFor(sources, keyframes) });
  check('rejects for want of an elevation lever',
    r.measured === false && r.rejected.noElevationLever > 0,
    `${r.reason}, ${r.rejected.noElevationLever} rejected`);
  check('leaves the lens alone', r.scale === 1, `${r.scale}`);
}

console.log('\n=== Two physical laps both labelled pass 1 are still found ===');
{
  // The capture this was written for labelled every frame pass 1, because loop
  // closure never matched and the survey never advanced. Pass number alone
  // would have found nothing; the time separation is what saves it.
  const { keyframes, sources } = buildSurvey({ statedScale: STATED_SCALE });
  const mislabelled = keyframes.map(k => ({ ...k, pass: 1 }));
  const r = crossLapFocalCheck({
    keyframes: mislabelled, features: featuresFor(sources, mislabelled)
  });
  check('finds the repeat views anyway', r.pairCount >= 5, `${r.pairCount} pairs`);
  check('and still measures the lens', r.measured === true, r.reason);
}

console.log('\n=== Feature density is a real dependency, not a preference ===');
{
  const { keyframes, sources } = buildSurvey({ statedScale: STATED_SCALE });
  const thin = crossLapFocalCheck({ keyframes, features: featuresFor(sources, keyframes, 60) });
  const dense = crossLapFocalCheck({ keyframes, features: featuresFor(sources, keyframes, 220) });
  console.log(`   60 features: ${thin.pairCount} pairs, ${thin.fittedVfovDeg?.toFixed(2) ?? 'n/a'}°`);
  console.log(`   220 features: ${dense.pairCount} pairs, ${dense.fittedVfovDeg?.toFixed(2)}°`);
  check('a dense set yields more usable repeat views',
    dense.pairCount > thin.pairCount, `${dense.pairCount} vs ${thin.pairCount}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
