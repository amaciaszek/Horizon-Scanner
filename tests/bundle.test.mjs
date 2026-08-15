/* Rotation-only bundle adjustment, against a synthetic world with known truth.
 *
 * The panorama is now the product rather than a diagnostic: the operator
 * corrects the horizon by dragging it, so what matters is that the picture is
 * internally consistent — the same chimney drawn in the same place by every
 * frame that can see it — rather than that the whole thing points at exactly
 * the right compass bearing.
 *
 * So these tests measure consistency, not accuracy. A synthetic textured sphere
 * is photographed by a ring of virtual cameras whose TRUE rotations are known.
 * The rotations handed to the solver are then corrupted the way real sensors
 * corrupt them — accumulating yaw drift, a little tilt noise — and the solver
 * has to put the frames back into agreement with each other.
 */
import { extractFeatures, matchPair, refineRotations, overlappingPairs, rayOf, verifyPair } from '../js/bundle.js';
import { quatMul, quatConj, quatRotate, quatFromAxisAngle, cameraRay, DEG, RAD } from '../js/math3d.js';

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

/* A world of fixed texture: value as a function of direction. Deterministic and
 * band-limited enough to match, busy enough to have corners everywhere. */
// A world made of DISTINCT objects at random directions, which is what a real
// horizon is: window corners, branch junctions, chimney edges, fence posts.
// The first version of this was pure periodic texture, and that turned out to
// be a far harder problem than reality rather than an easier one — whole pairs
// of frames locked onto the wrong period of it, self-consistently, which no
// amount of geometric verification can detect because the wrong answer fits a
// single rotation perfectly. Matching is only well posed when the scene has
// something unique at the scale of a patch, and real ones do.
const OBJECTS = (() => {
  const r = rng(20260815);
  return Array.from({ length: 1400 }, () => ({
    az: (r() * 2 - 1) * Math.PI,
    alt: (r() - 0.5) * 1.1,
    s: 0.004 + r() * 0.016,
    a: (r() * 2 - 1) * 90
  }));
})();

function worldTexture(d) {
  const az = Math.atan2(d[0], d[1]), alt = Math.asin(Math.max(-1, Math.min(1, d[2])));
  let v = 128 + 26 * Math.sin(alt * 2.2);          // gentle sky-to-ground ramp
  for (const o of OBJECTS) {
    let dz = az - o.az;
    if (dz > Math.PI) dz -= 2 * Math.PI; else if (dz < -Math.PI) dz += 2 * Math.PI;
    const dy = alt - o.alt;
    const q = (dz * dz + dy * dy) / (o.s * o.s);
    if (q < 9) v += o.a * Math.exp(-q * 0.5);
  }
  return Math.max(8, Math.min(247, v));
}

const TW = 200, TH = 150;              // thumbnail size
// Degrees subtended by one pixel here. The real thumbnails are 640x480, where
// a pixel is 0.07 deg, so anything expressed in pixels transfers and anything
// expressed in degrees flatters or punishes the test by its own resolution.
const DEG_PER_PX = 45.6 / TW;
const TAN_H = Math.tan(45.6 / 2 * DEG);
const TAN_V = Math.tan(35.0 / 2 * DEG);

/** Render one virtual photograph at a known rotation. */
function render(q, { skyAbove = null } = {}) {
  const data = new Uint8ClampedArray(TW * TH * 4);
  for (let py = 0; py < TH; py++) {
    for (let px = 0; px < TW; px++) {
      const u = (px + 0.5) / TW * 2 - 1, v = 1 - (py + 0.5) / TH * 2;
      const d = quatRotate(q, cameraRay(u, v, TAN_H, TAN_V));
      // Optional moving "cloud" band above a horizon, to prove it is excluded.
      let val;
      if (skyAbove !== null && v > skyAbove) {
        val = 210 + 40 * Math.sin(px * 0.21 + skyAbove * 90) * Math.cos(py * 0.17);
      } else {
        val = worldTexture(d);
      }
      const p = (py * TW + px) * 4;
      data[p] = data[p + 1] = data[p + 2] = val; data[p + 3] = 255;
    }
  }
  return { w: TW, h: TH, data };
}

/** A keyframe descriptor matching what the survey stores. `skyRowNorm` is where
 *  the detected skyline sits, in v (-1 bottom .. +1 top). */
function makeKf(skyRowNorm = 0.35) {
  const cols = 96, height = 288;
  const boundary = new Float32Array(cols);
  for (let i = 0; i < cols; i++) boundary[i] = (1 - skyRowNorm) / 2 * height;
  return { tanHalfH: TAN_H, tanHalfV: TAN_V, boundary, height };
}

/** A ring of cameras around the horizon, plus a tilted-up band if asked. */
function buildRing({ count = 12, stepDeg = 18, tiltDeg = 0 }) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const yaw = i * stepDeg;
    const q = quatMul(
      quatFromAxisAngle(0, 0, 1, yaw * DEG),
      quatFromAxisAngle(1, 0, 0, (90 + tiltDeg) * DEG)   // camera looks at the horizon
    );
    out.push(q);
  }
  return out;
}

/** Spread of pairwise disagreement, in degrees: THE metric that matters. */
function consistency(frames, pairs, qs) {
  let sum = 0, n = 0, worst = 0;
  for (const pr of pairs) {
    for (const m of pr.matches) {
      const a = rayOf(frames[pr.i].kf, m.ua, m.va, qs[pr.i]);
      const b = rayOf(frames[pr.j].kf, m.ub, m.vb, qs[pr.j]);
      const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
      const e = Math.acos(dot) * RAD;
      sum += e; n++; worst = Math.max(worst, e);
    }
  }
  return { mean: n ? sum / n : 0, worst, n };
}

/** Corrupt truth the way sensors do: yaw that drifts, tilt that jitters. */
function corrupt(truth, { driftDegPerFrame = 0.55, tiltNoiseDeg = 0.25, seed = 5 }) {
  const rnd = rng(seed);
  return truth.map((q, i) => {
    const drift = quatFromAxisAngle(0, 0, 1, driftDegPerFrame * i * DEG);
    const tilt = quatMul(
      quatFromAxisAngle(1, 0, 0, (rnd() - 0.5) * 2 * tiltNoiseDeg * DEG),
      quatFromAxisAngle(0, 1, 0, (rnd() - 0.5) * 2 * tiltNoiseDeg * DEG)
    );
    return quatMul(quatMul(drift, tilt), q);
  });
}

function run(label, opts) {
  const truth = buildRing(opts);
  const noisy = corrupt(truth, opts);
  const kf = makeKf(opts.skyRowNorm ?? 0.35);
  const srcs = truth.map(q => render(q, { skyAbove: opts.cloud ? (opts.skyRowNorm ?? 0.35) : null }));
  const frames = noisy.map(q => ({ kf, q }));
  const feats = srcs.map(s => extractFeatures(s, kf, { target: 150 }));

  const pairs = overlappingPairs(frames).map(p => ({
    ...p,
    matches: verifyPair(matchPair(feats[p.i], feats[p.j], kf, kf, frames[p.i].q, frames[p.j].q), kf, kf, frames[p.i].q, frames[p.j].q)
  })).filter(p => p.matches.length >= 6);

  const before = consistency(frames, pairs, noisy);
  const res = refineRotations(frames, pairs, opts.solver);
  const after = consistency(frames, pairs, res.q);

  console.log(`\n${label}`);
  console.log(`   ${pairs.length} overlapping pairs, ${before.n} matches`);
  console.log(`   disagreement  before ${before.mean.toFixed(3)}° (worst ${before.worst.toFixed(2)}°)`);
  console.log(`                 after  ${after.mean.toFixed(3)}° (worst ${after.worst.toFixed(2)}°)`);
  console.log(`   frames moved  max ${res.maxMovedDeg.toFixed(2)}°`);
  return { before, after, res, truth, noisy, pairs, frames };
}

console.log('=== Features are found, and only below the skyline ===');
{
  const kf = makeKf(0.3);
  const q = buildRing({ count: 1 })[0];
  const f = extractFeatures(render(q, { skyAbove: 0.3 }), kf, { target: 150 });
  check('finds a useful number of features', f.feats.length > 40, `${f.feats.length}`);
  const skyPx = (1 - 0.3) / 2 * TH;
  const above = f.feats.filter(p => p.py < skyPx).length;
  check('none come from above the skyline', above === 0,
    `${above} of ${f.feats.length} above the line (cloud would be matched otherwise)`);
}

console.log('\n=== A ring with drifting yaw is pulled back into agreement ===');
{
  const r = run('12 frames, 18° apart, 0.55°/frame of yaw drift', {
    count: 12, stepDeg: 18, driftDegPerFrame: 0.55, tiltNoiseDeg: 0.25, seed: 3
  });
  check('matches were found across the ring', r.before.n > 200, `${r.before.n} matches`);
  check('disagreement drops sharply', r.after.mean < r.before.mean * 0.35,
    `${r.before.mean.toFixed(3)}° -> ${r.after.mean.toFixed(3)}°`);
  check('agreement is sub-pixel', r.after.mean < DEG_PER_PX,
    `${r.after.mean.toFixed(3)}° = ${(r.after.mean / DEG_PER_PX).toFixed(2)} px`);
  check('no frame is thrown a long way', r.res.maxMovedDeg < 12, `${r.res.maxMovedDeg.toFixed(2)}°`);
}

console.log('\n=== Gravity is protected: tilt must not be used to explain matches ===');
{
  const r = run('same ring, checking what the solver did to tilt', {
    count: 12, stepDeg: 18, driftDegPerFrame: 0.6, tiltNoiseDeg: 0.3, seed: 11
  });
  // Decompose each correction into yaw about world z and tilt away from it.
  let worstTilt = 0, worstYaw = 0;
  for (let i = 0; i < r.frames.length; i++) {
    const rel = quatMul(r.res.q[i], quatConj(r.frames[i].q));
    const ang = 2 * Math.acos(Math.min(1, Math.abs(rel[0])));
    const s = Math.sqrt(Math.max(1e-12, 1 - rel[0] * rel[0]));
    const axis = [rel[1] / s, rel[2] / s, rel[3] / s];
    const yaw = Math.abs(axis[2]) * ang * RAD;
    const tilt = Math.hypot(axis[0], axis[1]) * ang * RAD;
    worstYaw = Math.max(worstYaw, yaw); worstTilt = Math.max(worstTilt, tilt);
  }
  console.log(`   corrections: yaw up to ${worstYaw.toFixed(2)}°, tilt up to ${worstTilt.toFixed(2)}°`);
  check('yaw is free to move', worstYaw > 0.5, `${worstYaw.toFixed(2)}°`);
  check('tilt is held near what gravity said', worstTilt < 0.6, `${worstTilt.toFixed(2)}°`);
  check('and it still converged', r.after.mean < DEG_PER_PX, `${(r.after.mean / DEG_PER_PX).toFixed(2)} px`);
}

console.log('\n=== Moving cloud above the skyline cannot drag the solution ===');
{
  // The cloud band is rendered DIFFERENTLY per frame — it moves, as cloud does.
  // If it were matched, it would pull frames together wrongly.
  const r = run('ring with a per-frame-varying cloud band above the horizon', {
    count: 12, stepDeg: 18, driftDegPerFrame: 0.5, tiltNoiseDeg: 0.2, seed: 7,
    cloud: true, skyRowNorm: 0.3
  });
  check('still converges with cloud present', r.after.mean < DEG_PER_PX, `${(r.after.mean / DEG_PER_PX).toFixed(2)} px`);
  check('improvement is real', r.after.mean < r.before.mean * 0.4,
    `${r.before.mean.toFixed(3)}° -> ${r.after.mean.toFixed(3)}°`);
}

console.log('\n=== A tilted-up band stitches to the level band ===');
{
  // Two rings at different elevations, as the two-sweep capture will produce.
  const level = buildRing({ count: 10, stepDeg: 22, tiltDeg: 0 });
  const up = buildRing({ count: 10, stepDeg: 22, tiltDeg: 22 });
  const truth = [...level, ...up];
  const noisy = corrupt(truth, { driftDegPerFrame: 0.4, tiltNoiseDeg: 0.25, seed: 17 });
  const kf = makeKf(0.95);                       // skyline near the top: almost all ground
  const srcs = truth.map(q => render(q));
  const frames = noisy.map(q => ({ kf, q }));
  const feats = srcs.map(s => extractFeatures(s, kf, { target: 150 }));
  const pairs = overlappingPairs(frames).map(p => ({
    ...p, matches: verifyPair(matchPair(feats[p.i], feats[p.j], kf, kf, frames[p.i].q, frames[p.j].q), kf, kf, frames[p.i].q, frames[p.j].q)
  })).filter(p => p.matches.length >= 6);
  const cross = pairs.filter(p => (p.i < 10) !== (p.j < 10)).length;
  const before = consistency(frames, pairs, noisy);
  const res = refineRotations(frames, pairs);
  const after = consistency(frames, pairs, res.q);
  console.log(`\n   two bands, ${pairs.length} pairs of which ${cross} join the level band to the tilted one`);
  console.log(`   disagreement before ${before.mean.toFixed(3)}° -> after ${after.mean.toFixed(3)}°`);
  check('the two bands are tied together by matches', cross >= 5, `${cross} cross-band pairs`);
  // Cross-band alignment lands weaker than within a band, and honestly so:
  // the two bands are tied only where they overlap, the patches are viewed at
  // 22 deg of relative tilt which a plain correlation window does not model,
  // and the accumulated drift between the first level frame and the last
  // tilted one is eight degrees. It improves by better than 2x and gets to a
  // few pixels; claiming sub-pixel here would be moving the goalposts.
  check('the two bands are pulled together', after.mean < before.mean * 0.5,
    `${before.mean.toFixed(3)}° -> ${after.mean.toFixed(3)}° (${(after.mean / DEG_PER_PX).toFixed(1)} px)`);
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exitCode = 1; }
else console.log('\nall bundle adjustment checks passed');
