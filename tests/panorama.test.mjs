/* Panorama geometry check.
 *
 * Renders synthetic frames of a KNOWN horizon, builds the diagnostic mosaic from
 * them, then reads the sky/ground boundary back OUT of the mosaic imagery and
 * compares it against ground truth. This validates the inverse mapping in
 * panorama.js independently of the segmenter: if the reprojection is wrong, the
 * painted horizon lands at the wrong altitude even though every input frame is
 * perfect.
 */

import {
  quatFromEuler, screenQuat, quatRotate, cameraRay, vecToAzAlt, wrap360, DEG
} from '../js/math3d.js';
import { Survey } from '../js/survey.js';
import { buildMosaic, skylineTracks, worldToImage, azAltToVec, keyframeQuat } from '../js/panorama.js';
import { quatConj } from '../js/math3d.js';

const W = 384, H = 288;
const HFOV = 66;
const tanH = Math.tan(HFOV / 2 * DEG);
const tanV = tanH * (H / W);

let fails = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
}

/* ---- 1. worldToImage is the exact inverse of cameraRay ------------------ */
{
  let worst = 0;
  const q = screenQuat(quatFromEuler(43, 102, 0), 0);
  const qc = quatConj(q);
  for (let i = 0; i < 400; i++) {
    const u = -0.95 + 1.9 * (i % 20) / 19;
    const v = -0.95 + 1.9 * Math.floor(i / 20) / 19;
    const world = quatRotate(q, cameraRay(u, v, tanH, tanV));
    const back = worldToImage(world, qc, tanH, tanV);
    if (!back) { worst = Infinity; break; }
    worst = Math.max(worst, Math.abs(back[0] - u), Math.abs(back[1] - v));
  }
  check('worldToImage inverts cameraRay', worst < 1e-9, `max err ${worst.toExponential(2)}`);
}

/* ---- 2. azAltToVec inverts vecToAzAlt ---------------------------------- */
{
  let worst = 0;
  for (let az = 0; az < 360; az += 7) {
    for (let alt = -80; alt <= 80; alt += 11) {
      const r = vecToAzAlt(azAltToVec(az, alt));
      let dAz = Math.abs(wrap360(r.az - az));
      if (dAz > 180) dAz = 360 - dAz;
      worst = Math.max(worst, dAz * Math.cos(alt * DEG), Math.abs(r.alt - alt));
    }
  }
  check('azAltToVec inverts vecToAzAlt', worst < 1e-9, `max err ${worst.toExponential(2)}`);
}

/* ---- ground truth + renderer (same shape as sim.mjs) ------------------- */
function truth(azDeg) {
  const a = wrap360(azDeg);
  let alt = 8 + 2.5 * Math.sin(a * DEG * 3) + 1.5 * Math.sin(a * DEG * 7 + 1);
  if (a > 150 && a < 215) alt = 30 + 6 * Math.sin((a - 150) / 65 * Math.PI);
  if (a > 292 && a < 312) alt += 18 * Math.sin((a - 292) / 20 * Math.PI);
  return Math.max(0, alt);
}

function renderFrame(azDeg, elDeg) {
  const q = screenQuat(quatFromEuler(wrap360(360 - azDeg), 90 + elDeg, 0), 0);
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W * 2 - 1;
      const v = 1 - (y + 0.5) / H * 2;
      const { az, alt } = vecToAzAlt(quatRotate(q, cameraRay(u, v, tanH, tanV)));
      const p = (y * W + x) * 4;
      // Deliberately hard-edged and noiseless: this test is about geometry.
      if (alt > truth(az)) { rgba[p] = 200; rgba[p + 1] = 215; rgba[p + 2] = 235; }
      else { rgba[p] = 30; rgba[p + 1] = 26; rgba[p + 2] = 22; }
      rgba[p + 3] = 255;
    }
  }
  return { rgba, quat: q };
}

/* ---- build keyframes over a full lap ----------------------------------- */
const survey = new Survey();
survey.yawDatum = 0;
const sources = [];
for (let az = 0; az < 360; az += 10) {
  const el = (az > 150 && az < 215) ? 30 : (az > 292 && az < 312) ? 26 : 12;
  const f = renderFrame(az, el);
  const n = W;
  // Perfect synthetic "segmentation": the true boundary row per column.
  const boundary = new Float32Array(n);
  const confidence = new Float32Array(n).fill(1);
  const flags = new Uint8Array(n);
  for (let x = 0; x < n; x++) {
    const u = (x + 0.5) / n * 2 - 1;
    let row = H - 1;
    for (let y = 0; y < H; y++) {
      const v = 1 - (y + 0.5) / H * 2;
      const { az: a2, alt } = vecToAzAlt(quatRotate(f.quat, cameraRay(u, v, tanH, tanV)));
      if (alt <= truth(a2)) { row = y; break; }
    }
    boundary[x] = row;
    if (row <= 1) flags[x] = 1;
    else if (row >= H - 2) flags[x] = 2;
  }
  const kf = survey.addKeyframe({
    pass: 1, tanHalfH: tanH, tanHalfV: tanV, quat: f.quat, screenAngle: 0,
    yawRaw: az, yawFused: az, yawBase: 0, height: H,
    boundary, confidence, flags
  });
  survey._projectKeyframe(kf, { tanHalfH: tanH, tanHalfV: tanV });
  sources.push({ w: W, h: H, data: f.rgba });
}
survey.recompute();
console.log(`\nkeyframes: ${survey.keyframes.length}`);

/* ---- 3. mosaic imagery lands at the correct altitude ------------------- */
const pxPerDeg = 6;
const mosaic = buildMosaic({
  keyframes: survey.keyframes, sources, yawDatum: 0,
  pxPerDeg, altMin: -12, altMax: 62, azStart: 0
});
const { rgba, owner, width, height, opts, painted } = mosaic;
console.log(`mosaic: ${width}x${height}, painted ${(painted / (width * height) * 100).toFixed(1)}%`);

// The truth horizon contains genuine vertical walls (the house edges at 150°
// and 215° rise ~22° within a fraction of a degree). At a cliff, a pointwise
// altitude comparison measures which side of the wall the sample fell on, not
// projection accuracy, so those columns are excluded and counted separately —
// the same distinction the acceptance report draws between a step and a spike.
const CLIFF = 8;   // deg-alt per deg-az
function isCliff(az) {
  for (let d = -1.2; d <= 1.2; d += 0.1) {
    if (Math.abs(truth(az + d + 0.05) - truth(az + d - 0.05)) / 0.1 > CLIFF) return true;
  }
  return false;
}

const errs = [];
let cliffCols = 0;
for (let x = 0; x < width; x++) {
  const az = wrap360(opts.azStart + (x + 0.5) / pxPerDeg);
  const t = truth(az);
  if (t > opts.altMax - 4 || t < opts.altMin + 4) continue;
  if (isCliff(az)) { cliffCols++; continue; }
  // Walk down from the top; first dark painted pixel is the painted horizon.
  let row = -1;
  for (let y = 0; y < height; y++) {
    const i = y * width + x;
    if (owner[i] < 0) continue;
    const lum = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    if (lum < 110) { row = y; break; }
  }
  if (row < 0) continue;
  const alt = opts.altMax - (row + 0.5) / pxPerDeg;
  errs.push(Math.abs(alt - t));
}
errs.sort((a, b) => a - b);
const median = errs[Math.floor(errs.length / 2)];
const p95 = errs[Math.floor(0.95 * (errs.length - 1))];
const max = errs[errs.length - 1];
console.log(`painted-horizon error over ${errs.length} columns (${cliffCols} wall columns excluded): median ${median.toFixed(3)}°, p95 ${p95.toFixed(3)}°, max ${max.toFixed(3)}°`);
// One mosaic pixel is 1/pxPerDeg = 0.167°. On a sloped horizon a column's
// azimuth quantisation also converts into altitude, so allow 2 px at p95.
const tol = 2.0 / pxPerDeg;
check('mosaic horizon within 2 px of truth', p95 <= tol, `p95 ${p95.toFixed(3)}° vs tol ${tol.toFixed(3)}°`);
check('no gross geometry error', max < 1.0, `max ${max.toFixed(3)}°`);

/* ---- 4. skyline tracks agree with the mosaic imagery ------------------- */
const tracks = skylineTracks(survey.keyframes, 0, opts);
let trackErr = [];
for (const t of tracks) {
  for (const seg of t.segs) {
    for (const p of seg) {
      const tt = truth(p.az);
      if (tt > opts.altMax - 4 || tt < opts.altMin + 4) continue;
      trackErr.push(Math.abs(p.alt - tt));
    }
  }
}
trackErr.sort((a, b) => a - b);
const tp95 = trackErr[Math.floor(0.95 * (trackErr.length - 1))];
console.log(`skyline track error over ${trackErr.length} points: p95 ${tp95.toFixed(3)}°`);
check('skyline tracks match truth', tp95 < 0.35, `p95 ${tp95.toFixed(3)}°`);

/* ---- 5. tracks land on the mosaic's own painted boundary --------------- */
// The strongest self-consistency check: the overlay must sit ON the seam it
// describes, or the picture would mislead rather than diagnose.
let onLine = 0, offLine = 0;
for (const t of tracks) {
  for (const seg of t.segs) {
    for (const p of seg) {
      const x = Math.round(p.x) % width, y = Math.round(p.y);
      if (y < 2 || y > height - 3) continue;
      const above = (y - 2) * width + x, below = (y + 2) * width + x;
      if (owner[above] < 0 || owner[below] < 0) continue;
      const lumA = 0.299 * rgba[above * 4] + 0.587 * rgba[above * 4 + 1] + 0.114 * rgba[above * 4 + 2];
      const lumB = 0.299 * rgba[below * 4] + 0.587 * rgba[below * 4 + 1] + 0.114 * rgba[below * 4 + 2];
      if (lumA > 110 && lumB < 110) onLine++; else offLine++;
    }
  }
}
const frac = onLine / (onLine + offLine);
console.log(`overlay-on-seam: ${(frac * 100).toFixed(1)}% of ${onLine + offLine} sampled points`);
check('overlay sits on the painted boundary', frac > 0.93, `${(frac * 100).toFixed(1)}%`);

console.log(fails ? `\n${fails} FAILED` : '\nall panorama checks passed');
process.exit(fails ? 1 : 0);
