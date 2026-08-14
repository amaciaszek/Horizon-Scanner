/* Measuring the lens, against a simulated pinhole camera with a known answer.
 *
 * Why this matters more than it looks: the focal length converts pixels into
 * angles, so it multiplies every altitude the survey reports — and because the
 * error grows toward the frame edges, a wrong one also makes the same skyline
 * point disagree with itself between keyframes. The 2026-08-13 field run
 * assumed a 66° frame that was really about 28°, which put altitudes out by
 * 2.6x and produced a 50° maximum spread that looked like a detector fault.
 *
 * The tests below check the two things that decide whether this is worth
 * trusting: that it recovers a known lens through realistic matcher noise and
 * outliers, and that it REFUSES rather than guessing when the evidence is poor.
 */
import { LensCalibrator } from '../js/lenscal.js';

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures++;
};

const WORK_W = 384, WORK_H = 288;
const DEG = Math.PI / 180, RAD = 180 / Math.PI;
const focalFor = (fovDeg, extent) => (extent / 2) / Math.tan(fovDeg / 2 * DEG);

const rng = s => () => {
  s |= 0; s = s + 0x6D2B79F5 | 0;
  let t = Math.imul(s ^ s >>> 15, 1 | s);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

/**
 * A person pointing the phone at a textured scene and panning it back and
 * forth, then tilting it up and down. `noisePx` is matcher jitter; `outlier`
 * is the fraction of frames where the matcher locks onto the wrong thing.
 */
function sweepSession(cal, { hfov, vfov, seconds = 12, seed = 1, noisePx = 0.6,
                             outlier = 0, quality = 0.28, elevationDeg = 0 } = {}) {
  const rnd = rng(seed);
  const fH = focalFor(hfov, WORK_W), fV = focalFor(vfov, WORK_H);
  const dt = 1 / 30;
  for (let t = 0; t < seconds; t += dt) {
    // Pan: a slow oscillation, the way a hand actually sweeps.
    const rate = 26 * Math.sin(2 * Math.PI * 0.22 * t) + 6 * Math.sin(2 * Math.PI * 0.07 * t + 1);
    const dYaw = rate * dt;
    let dx = fH * Math.tan(Math.abs(dYaw) * Math.cos(elevationDeg * DEG) * DEG);
    dx += (rnd() - 0.5) * 2 * noisePx;
    if (rnd() < outlier) dx *= 0.3 + rnd() * 2.5;      // matcher grabbed the wrong feature
    cal.addPan({ dxPx: dx, dYawDeg: dYaw, elevationDeg, quality });
  }
  for (let t = 0; t < seconds; t += dt) {
    const rate = 22 * Math.sin(2 * Math.PI * 0.19 * t + 0.5) + 5 * Math.sin(2 * Math.PI * 0.09 * t);
    const dPitch = rate * dt;
    let dy = fV * Math.tan(Math.abs(dPitch) * DEG);
    dy += (rnd() - 0.5) * 2 * noisePx;
    if (rnd() < outlier) dy *= 0.3 + rnd() * 2.5;
    cal.addTilt({ dyPx: dy, dPitchDeg: dPitch, quality });
  }
}

console.log('=== Recovers the lens the 2026-08-13 field run actually had ===');
{
  // Vision said the frame spanned ~27.6° horizontally while the app assumed 66°.
  const TRUE_H = 27.6, TRUE_V = 2 * Math.atan(Math.tan(27.6 / 2 * DEG) * (WORK_H / WORK_W)) * RAD;
  const cal = new LensCalibrator(WORK_W, WORK_H);
  sweepSession(cal, { hfov: TRUE_H, vfov: TRUE_V, seed: 3 });
  const r = cal.result();
  check('measurement is ready', r.ready, `${r.nPan} pan + ${r.nTilt} tilt pairs`);
  check('horizontal FOV recovered', Math.abs(r.hfovDeg - TRUE_H) < 0.8,
    `${r.hfovDeg?.toFixed(2)}° against a true ${TRUE_H}°`);
  check('vertical FOV recovered', Math.abs(r.vfovDeg - TRUE_V) < 0.8,
    `${r.vfovDeg?.toFixed(2)}° against a true ${TRUE_V.toFixed(2)}°`);
  check('and it disagrees loudly with the assumed 66°', Math.abs(r.hfovDeg - 66) > 30);
  check('and it says how well it knows the answer', r.uncertaintyH < 0.015 && r.uncertaintyV < 0.015,
    `+/-${(r.uncertaintyH * 100).toFixed(2)}% horizontal, +/-${(r.uncertaintyV * 100).toFixed(2)}% vertical`);
  // Focal length in pixels is one number for both axes on a square-pixel
  // sensor, so the two halves — measured against two different sensors —
  // agreeing is an independent check that neither is quietly wrong.
  check('the two halves agree about the same lens', Math.abs(r.squarePixelRatio - 1) < 0.05,
    `vertical/horizontal focal ${r.squarePixelRatio?.toFixed(3)}`);
}

console.log('=== Recovers an ordinary lens too, so it is not tuned to one answer ===');
for (const [h, label] of [[66, 'a 66° lens'], [40, 'a 40° lens'], [95, 'a wide 95° lens']]) {
  const v = 2 * Math.atan(Math.tan(h / 2 * DEG) * (WORK_H / WORK_W)) * RAD;
  const cal = new LensCalibrator(WORK_W, WORK_H);
  sweepSession(cal, { hfov: h, vfov: v, seed: h });
  const r = cal.result();
  check(`${label} recovered`, r.ready && Math.abs(r.hfovDeg - h) < Math.max(1, h * 0.03),
    `${r.hfovDeg?.toFixed(2)}° against ${h}°, +/-${(r.uncertaintyH * 100).toFixed(2)}%`);
}

console.log('=== The vertical is measured on its own, not derived ===');
{
  // A camera whose vertical does NOT follow from its horizontal — an anamorphic
  // crop, a non-square pixel, or simply a wrong assumption about the crop. The
  // derived model would get this wrong; measuring against gravity does not.
  const TRUE_H = 50, TRUE_V = 20;   // deliberately not WORK_H/WORK_W of each other
  const cal = new LensCalibrator(WORK_W, WORK_H);
  sweepSession(cal, { hfov: TRUE_H, vfov: TRUE_V, seed: 11 });
  const r = cal.result();
  check('horizontal correct', Math.abs(r.hfovDeg - TRUE_H) < 1.5, `${r.hfovDeg?.toFixed(2)}°`);
  check('vertical correct and independent', Math.abs(r.vfovDeg - TRUE_V) < 1.5, `${r.vfovDeg?.toFixed(2)}°`);
  const derived = 2 * Math.atan(Math.tan(r.hfovDeg / 2 * DEG) * (WORK_H / WORK_W)) * RAD;
  check('the derived-from-horizontal model would have been wrong',
    Math.abs(derived - TRUE_V) > 5, `derived would say ${derived.toFixed(1)}°, truth ${TRUE_V}°`);
}

console.log('=== Survives a matcher that sometimes locks onto the wrong thing ===');
{
  const TRUE_H = 30, TRUE_V = 2 * Math.atan(Math.tan(30 / 2 * DEG) * (WORK_H / WORK_W)) * RAD;
  let worst = 0, ready = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const cal = new LensCalibrator(WORK_W, WORK_H);
    sweepSession(cal, { hfov: TRUE_H, vfov: TRUE_V, seed, outlier: 0.2, noisePx: 1.2 });
    const r = cal.result();
    if (r.ready) ready++;
    if (r.hfovDeg) worst = Math.max(worst, Math.abs(r.hfovDeg - TRUE_H));
  }
  check('one pair in five being a bad match does not move the answer', worst < 1.5,
    `worst error ${worst.toFixed(2)}° across 12 sessions, ${ready}/12 ready`);
}

console.log('=== Tilted panning still works, because the cosine is corrected ===');
{
  const TRUE_H = 35, TRUE_V = 2 * Math.atan(Math.tan(35 / 2 * DEG) * (WORK_H / WORK_W)) * RAD;
  const cal = new LensCalibrator(WORK_W, WORK_H);
  sweepSession(cal, { hfov: TRUE_H, vfov: TRUE_V, seed: 7, elevationDeg: 25 });
  const r = cal.result();
  check('panning at 25° of tilt still recovers the lens', Math.abs(r.hfovDeg - TRUE_H) < 1.5,
    `${r.hfovDeg?.toFixed(2)}° against ${TRUE_H}°`);
}

console.log('=== Works at the match quality this phone actually produces ===');
{
  // The 2026-08-13 attempt rejected 335 of ~440 frames on a 0.45 quality gate
  // and timed out with 20 pairs. Nothing about a 0.28 match is wrong, only
  // noisier, so the fit must survive it.
  const TRUE_H = 66, TRUE_V = 2 * Math.atan(Math.tan(66 / 2 * DEG) * (WORK_H / WORK_W)) * RAD;
  let ready = 0, worst = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const cal = new LensCalibrator(WORK_W, WORK_H);
    sweepSession(cal, { hfov: TRUE_H, vfov: TRUE_V, seed, quality: 0.28, noisePx: 1.0 });
    const r = cal.result();
    if (r.ready) ready++;
    if (r.hfovDeg) worst = Math.max(worst, Math.abs(r.hfovDeg - TRUE_H));
  }
  check('a 0.28-quality matcher still measures the lens', ready === 10,
    `${ready}/10 ready, worst error ${worst.toFixed(2)}°`);
  check('and no rejections are attributed to quality',
    new LensCalibrator(WORK_W, WORK_H).result().rejected.quality === 0);
}

console.log('=== Refuses rather than guessing when the evidence is thin ===');
{
  const cal = new LensCalibrator(WORK_W, WORK_H);
  sweepSession(cal, { hfov: 40, vfov: 30, seconds: 0.7 });
  const r = cal.result();
  check('a couple of seconds is not enough', !r.ready, `${r.nPan} pan + ${r.nTilt} tilt pairs`);

  // A phone held still: no rotation, so nothing to measure.
  const still = new LensCalibrator(WORK_W, WORK_H);
  for (let i = 0; i < 400; i++) still.addPan({ dxPx: 0.2, dYawDeg: 0.05, quality: 0.9 });
  check('a still phone yields nothing at all', !still.result().ready && still.result().nPan === 0,
    `${still.result().rejected.angle} rejected for too little rotation`);

  // Only panning, never tilting: the horizontal is known, the vertical is not,
  // and the vertical is the one altitudes depend on.
  const halfDone = new LensCalibrator(WORK_W, WORK_H);
  sweepSession(halfDone, { hfov: 40, vfov: 30, seconds: 12, seed: 5 });
  halfDone.tilt.length = 0;
  const hr = halfDone.result();
  check('panning alone is not accepted', !hr.ready && hr.panReady && !hr.tiltReady,
    'horizontal ready, vertical not — altitudes would still be unverified');
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exitCode = 1; }
else console.log('\nall lens calibration checks passed');
