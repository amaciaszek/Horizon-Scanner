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
 * between 49.3 and 50.4 degrees, with correlations from 0.994 to 0.998. At 160
 * features the same code wandered between 50.6 and 52.5, which is why the
 * density is pinned upstream in panorama-optimize.js.
 *
 * The synthetic fixture below uses 48.26 degrees as its ground truth, which is
 * the figure the offline analysis reported for the real capture. That is a
 * coincidence of history and not a target: the fixture only has to prove the
 * estimator returns whatever lens the virtual camera was actually given. The
 * real capture's own answer is the 49.3-50.4 above, higher than 48.26 because
 * the offline fit carried the on-axis bias that `residualAt` exists to avoid.
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
  return Array.from({ length: 700 }, () => ({
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

const TW = 160, TH = 213;                       // portrait, like the corrected frames
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

/*
 * Rendering is by far the expensive part of this fixture, and almost every
 * scenario below photographs the SAME world from the SAME poses — what varies is
 * only what the keyframes claim about the lens, the pass number or the recorded
 * elevation. Rendering once and re-labelling the metadata took this file from
 * 111 seconds to a few, which matters because a suite nobody will sit through
 * is a suite that stops being run.
 */
const BASE = buildSurvey({ statedScale: 1 });
const BASE_FEATURES = new Map();
const featuresOf = (target = 220) => {
  if (!BASE_FEATURES.has(target)) {
    BASE_FEATURES.set(target, BASE.sources.map((s, i) =>
      extractFeatures(s, BASE.keyframes[i], { target })));
  }
  return BASE_FEATURES.get(target);
};
/** The shared capture, re-labelled. `edit` may change any keyframe field. */
const survey = (edit = k => k) => ({
  keyframes: BASE.keyframes.map((k, i) => edit({ ...k }, i)),
  sources: BASE.sources
});
const statedAt = scale => (k => ({
  ...k, tanHalfH: TRUE_TAN_H * scale, tanHalfV: TRUE_TAN_V * scale
}));

const featuresFor = (sources, keyframes, target = 220) =>
  sources.map((s, i) => extractFeatures(s, keyframes[i], { target }));

console.log('=== A pinned lens that is 6% wrong is measured back out ===');
{
  const { keyframes } = survey(statedAt(STATED_SCALE));
  const r = crossLapFocalCheck({ keyframes, features: featuresOf() });
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
  const { keyframes } = survey(statedAt(1));
  const r = crossLapFocalCheck({ keyframes, features: featuresOf() });
  console.log(`   ${r.pairCount} pairs, fitted ${r.fittedVfovDeg?.toFixed(2)}°`);
  check('stays within 2% of unity', Math.abs(r.scale - 1) < 0.02, `${r.scale.toFixed(4)}`);
}

console.log('\n=== Without a second lap there is nothing to measure ===');
{
  const { keyframes } = survey(statedAt(STATED_SCALE));
  const single = keyframes.filter(k => k.pass === 1);
  const r = crossLapFocalCheck({
    keyframes: single, features: featuresOf().slice(0, single.length)
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
  const { keyframes: mislabelled } = survey(k => ({ ...statedAt(STATED_SCALE)(k), pass: 1 }));
  const r = crossLapFocalCheck({ keyframes: mislabelled, features: featuresOf() });
  check('finds the repeat views anyway', r.pairCount >= 5, `${r.pairCount} pairs`);
  check('and still measures the lens', r.measured === true, r.reason);
}

console.log('\n=== Every pair is accounted for in the evidence ===');
{
  const { keyframes } = survey(statedAt(STATED_SCALE));
  const r = crossLapFocalCheck({ keyframes, features: featuresOf() });
  check('each kept pair says whether it was used in the fit',
    r.pairs.length > 0 && r.pairs.every(p => typeof p.used === 'boolean'));
  check('each kept pair carries its own evidence',
    r.pairs.every(p => Number.isFinite(p.elevationChangeDeg)
      && Number.isFinite(p.medianShiftV) && Number.isFinite(p.horizontalShiftSpread)
      && Number.isFinite(p.matchCount)));
  check('rejected pairs are listed with a reason',
    Array.isArray(r.rejectedPairs) && r.rejectedPairs.every(p => typeof p.reason === 'string'));
  check('the per-pair lens estimates are reported',
    Array.isArray(r.perPairScales) && r.perPairScales.length === r.pairCount,
    `${r.perPairScales.length} scales`);
  check('an uncertainty is reported alongside the answer',
    Number.isFinite(r.fittedVfovUncertaintyDeg),
    `±${r.fittedVfovUncertaintyDeg?.toFixed(2)}°`);
  console.log(`   ${r.fittedVfovDeg.toFixed(2)}° ± ${r.fittedVfovUncertaintyDeg.toFixed(2)}°, pairs agree to ${r.scaleAgreementMad.toFixed(4)}`);
}

console.log('\n=== Pairs that disagree about the lens are not averaged in ===');
{
  // A pair whose scenery moved for reasons other than the camera turning —
  // parallax on a near roofline is the case that matters — implies a different
  // focal length from the rest. The consensus band must exclude it rather than
  // splitting the difference, because splitting the difference produces a
  // confident number that is wrong by however much the outlier pulled.
  const features = featuresOf();
  const { keyframes } = survey(statedAt(STATED_SCALE));
  const clean = crossLapFocalCheck({ keyframes, features });

  // Corrupt one frame's recorded elevation. Its pair now implies a lens that
  // disagrees with every other pair, which is the signature being tested.
  const { keyframes: poisoned } = survey((k, i) => i === 16
    ? { ...statedAt(STATED_SCALE)(k), elevation: k.elevation + 5 }
    : statedAt(STATED_SCALE)(k));
  const dirty = crossLapFocalCheck({ keyframes: poisoned, features });
  console.log(`   clean ${clean.fittedVfovDeg.toFixed(2)}°, with one bad pair ${dirty.fittedVfovDeg.toFixed(2)}°`);
  check('the outlier is identified rather than absorbed',
    dirty.rejectedPairs.some(p => p.reason === 'disagrees-with-other-pairs')
    || dirty.pairs.some(p => p.used === false),
    `${dirty.rejectedPairs.length} rejected`);
  check('the answer barely moves',
    Math.abs(dirty.fittedVfovDeg - clean.fittedVfovDeg) < 0.6,
    `${Math.abs(dirty.fittedVfovDeg - clean.fittedVfovDeg).toFixed(3)}° shift`);
}

console.log('\n=== Wholesale disagreement refuses to change the geometry ===');
{
  // If the pairs cannot agree at all, there is no lens to report. This is the
  // guard against a survey shot so close to a building that parallax, not
  // optics, is what the estimator is looking at.
  const { keyframes: scrambled } = survey((k, i) => i >= 16
    ? { ...statedAt(STATED_SCALE)(k), elevation: k.elevation + ((i * 7919) % 13) - 6 }
    : statedAt(STATED_SCALE)(k));
  const r = crossLapFocalCheck({ keyframes: scrambled, features: featuresOf() });
  console.log(`   pairs agree to ${r.scaleAgreementMad?.toFixed(4)}, reason: ${r.reason}`);
  check('it refuses when the pairs do not concur',
    r.measured === false, r.reason);
  check('and leaves the lens exactly alone', r.scale === 1, `${r.scale}`);
}

console.log('\n=== Feature density is a real dependency, not a preference ===');
{
  const { keyframes } = survey(statedAt(STATED_SCALE));
  const thin = crossLapFocalCheck({ keyframes, features: featuresOf(60) });
  const dense = crossLapFocalCheck({ keyframes, features: featuresOf(220) });
  console.log(`   60 features: ${thin.pairCount} pairs, ${thin.fittedVfovDeg?.toFixed(2) ?? 'n/a'}°`);
  console.log(`   220 features: ${dense.pairCount} pairs, ${dense.fittedVfovDeg?.toFixed(2)}°`);
  check('a dense set yields more usable repeat views',
    dense.pairCount > thin.pairCount, `${dense.pairCount} vs ${thin.pairCount}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
