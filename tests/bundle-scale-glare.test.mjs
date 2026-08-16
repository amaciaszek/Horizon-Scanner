/* Two things the bundle adjuster has to get right about lenses and sunlight.
 *
 * SCALE. `rayOf` takes an optional focal scale, and it must move both half-angle
 * tangents together. Scaling one axis is not a change of focal length, it is a
 * change of pixel aspect ratio, and it would put an azimuth error at the frame
 * edges that grows with distance from the optical centre. The offline analysis
 * of the 2026-08-15 capture fitted only the vertical field of view and left the
 * horizontal at its old value, which is exactly that mistake.
 *
 * GLARE. Features must never be taken from blown highlights. A low sun in the
 * frame produces superbly corner-like structure — the clipped edge of the disc,
 * flare ghosts, the starburst off the aperture — and none of it is attached to
 * the ground. Flare ghosts move with the camera rather than with the scene, so
 * matching on them tells the solver the world rotated when it did not.
 *
 * The focal-length UNKNOWN inside the bundle adjustment is deliberately not
 * exercised for accuracy here. It exists, it is off, and js/focal-check.js
 * records why: measured against the real capture the cost surface it would have
 * to descend is flat, because parallax from a nearby house dominates it. What
 * is checked is that the option stays off and stays harmless.
 */
import { extractFeatures, matchPair, refineRotations, overlappingPairs, rayOf, verifyPair } from '../js/bundle.js';
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
  return Array.from({ length: 1400 }, () => ({
    az: (r() * 2 - 1) * Math.PI, alt: (r() - 0.5) * 1.1,
    s: 0.004 + r() * 0.016, a: (r() * 2 - 1) * 90
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

const TW = 200, TH = 150;
const TAN_H = Math.tan(45.6 / 2 * DEG);
const TAN_V = Math.tan(35.0 / 2 * DEG);

function render(q, hot = null) {
  const data = new Uint8ClampedArray(TW * TH * 4);
  for (let py = 0; py < TH; py++) {
    for (let px = 0; px < TW; px++) {
      const u = (px + 0.5) / TW * 2 - 1, v = 1 - (py + 0.5) / TH * 2;
      let val = worldTexture(quatRotate(q, cameraRay(u, v, TAN_H, TAN_V)));
      if (hot) {
        const r = Math.hypot(px - hot.px, py - hot.py);
        if (r < hot.r) val = 255;
        else if (r < hot.r + 6) val = 251;
      }
      const p = (py * TW + px) * 4;
      data[p] = data[p + 1] = data[p + 2] = val; data[p + 3] = 255;
    }
  }
  return { w: TW, h: TH, data };
}

function makeKf() {
  const cols = 96, height = 288;
  const boundary = new Float32Array(cols);
  for (let i = 0; i < cols; i++) boundary[i] = 0;      // no sky mask: use it all
  return { tanHalfH: TAN_H, tanHalfV: TAN_V, boundary, height };
}

console.log('=== rayOf scale is a focal length, not a stretch ===');
{
  const kf = makeKf();
  const q = [1, 0, 0, 0];
  // A scaled ray must equal the ray of a camera whose BOTH tangents are scaled.
  for (const [u, v] of [[0.8, 0.6], [-1, 1], [0.2, -0.4]]) {
    const scaled = rayOf(kf, u, v, q, 1.0655);
    const equivalent = quatRotate(q, cameraRay(u, v, kf.tanHalfH * 1.0655, kf.tanHalfV * 1.0655));
    const diff = Math.max(...scaled.map((x, i) => Math.abs(x - equivalent[i])));
    check(`scaling at (${u}, ${v}) matches a re-specified lens`, diff < 1e-12, `${diff.toExponential(1)}`);
  }
  // And it must NOT match scaling the vertical alone, which is the mistake.
  const oneAxis = quatRotate(q, cameraRay(0.8, 0.6, kf.tanHalfH, kf.tanHalfV * 1.0655));
  const both = rayOf(kf, 0.8, 0.6, q, 1.0655);
  check('differs from scaling one axis alone',
    Math.max(...both.map((x, i) => Math.abs(x - oneAxis[i]))) > 1e-3);
  // A scale of 1 must be a no-op, since every existing caller relies on it.
  const plain = rayOf(kf, 0.5, 0.5, q);
  const explicit = rayOf(kf, 0.5, 0.5, q, 1);
  check('scale defaults to 1 and changes nothing',
    plain.every((x, i) => x === explicit[i]));
}

console.log('\n=== Blown highlights yield no features ===');
{
  const kf = makeKf();
  const q = quatMul(quatFromAxisAngle(0, 0, 1, 0), quatFromAxisAngle(1, 0, 0, 90 * DEG));
  const hot = { px: TW * 0.5, py: TH * 0.55, r: 10 };
  const clean = extractFeatures(render(q), kf, { target: 150 });
  const flared = extractFeatures(render(q, hot), kf, { target: 150 });
  const near = f => f.feats.filter(p => Math.hypot(p.px - hot.px, p.py - hot.py) < 18).length;
  check('the clean frame does find features there', near(clean) > 0, `${near(clean)}`);
  check('the flared frame finds none', near(flared) === 0, `${near(flared)}`);
  check('the rest of the frame is still usable',
    flared.feats.length > clean.feats.length * 0.7,
    `${flared.feats.length} vs ${clean.feats.length}`);
  // Bright overcast must survive: 230 is a bright sky, not a blown highlight.
  const bright = extractFeatures(render(q, { px: TW * 0.5, py: TH * 0.55, r: 0 }), kf, { target: 150 });
  check('a bright but unclipped scene is unaffected',
    Math.abs(bright.feats.length - clean.feats.length) <= 2,
    `${bright.feats.length} vs ${clean.feats.length}`);
}

console.log('\n=== The focal unknown is off, and harmless when switched on ===');
{
  const kf = makeKf();
  const truth = Array.from({ length: 12 }, (_, i) => quatMul(
    quatFromAxisAngle(0, 0, 1, i * 18 * DEG), quatFromAxisAngle(1, 0, 0, 90 * DEG)));
  const rnd = rng(5);
  const noisy = truth.map((q, i) => quatMul(quatMul(
    quatFromAxisAngle(0, 0, 1, 0.5 * i * DEG),
    quatFromAxisAngle(1, 0, 0, (rnd() - 0.5) * 0.4 * DEG)), q));
  const srcs = truth.map(q => render(q));
  const frames = noisy.map(q => ({ kf, q }));
  const feats = srcs.map(s => extractFeatures(s, kf, { target: 150 }));
  const pairs = overlappingPairs(frames).map(p => ({
    ...p,
    matches: verifyPair(matchPair(feats[p.i], feats[p.j], kf, kf, frames[p.i].q, frames[p.j].q),
      kf, kf, frames[p.i].q, frames[p.j].q)
  })).filter(p => p.matches.length >= 6);

  const off = refineRotations(frames, pairs, { iterations: 24 });
  check('reports scale exactly 1 when not solving focal', off.focalScale === 1, `${off.focalScale}`);

  const on = refineRotations(frames, pairs, { iterations: 24, solveFocal: true });
  check('stays inside its clamp when solving focal',
    Math.abs(on.focalScale - 1) < 0.2, `${on.focalScale.toFixed(4)}`);
  check('does not wreck the rotation solution',
    Number.isFinite(on.rmsDeg) && on.rmsDeg < off.rmsDeg * 1.5,
    `rms ${on.rmsDeg.toFixed(4)}° vs ${off.rmsDeg.toFixed(4)}°`);
}

console.log('\n=== verifyPair honours the scale it is verifying at ===');
{
  const kf = makeKf();
  const q = quatMul(quatFromAxisAngle(0, 0, 1, 0), quatFromAxisAngle(1, 0, 0, 90 * DEG));
  const q2 = quatMul(quatFromAxisAngle(0, 0, 1, 14 * DEG), quatFromAxisAngle(1, 0, 0, 90 * DEG));
  const a = extractFeatures(render(q), kf, { target: 200 });
  const b = extractFeatures(render(q2), kf, { target: 200 });
  const raw = matchPair(a, b, kf, kf, q, q2, { searchPx: 40 });
  const atTruth = verifyPair(raw, kf, kf, q, q2, { scale: 1 });
  const atWrong = verifyPair(raw, kf, kf, q, q2, { scale: 1.25 });

  // Match COUNT is the wrong yardstick, and assuming otherwise was an error
  // worth recording: the schedule stops tightening rather than starve a pair,
  // so a badly wrong scale fits badly, breaks out at a loose tolerance, and
  // keeps MORE matches than a correct scale that tightened all the way down.
  // What the scale actually buys is the quality of the survivors.
  const residual = matches => {
    const errs = matches.map(m => {
      const a2 = rayOf(kf, m.ua, m.va, q, 1), b2 = rayOf(kf, m.ub, m.vb, q2, 1);
      const dot = Math.max(-1, Math.min(1, a2[0] * b2[0] + a2[1] * b2[1] + a2[2] * b2[2]));
      return Math.acos(dot) * RAD;
    }).sort((x, y) => x - y);
    return errs.length ? errs[errs.length >> 1] : NaN;
  };
  check('survivors of the correct scale are the more precise set',
    residual(atTruth) < residual(atWrong),
    `${residual(atTruth).toFixed(4)}° vs ${residual(atWrong).toFixed(4)}°`);
  check('the scale argument is actually wired through',
    atTruth.length !== atWrong.length || residual(atTruth) !== residual(atWrong));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
