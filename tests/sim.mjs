/* Headless end-to-end check.
 * Renders synthetic camera frames of a KNOWN horizon, runs them through the
 * real segmentation worker and the real projection/merge code, and compares the
 * reconstructed profile against ground truth. */

import { createRequire } from 'module';
import {
  quatFromEuler, screenQuat, quatRotate, cameraRay, vecToAzAlt, wrap360, DEG, angDiff
} from '../js/math3d.js';
import { Survey, BIN_COUNT, BIN_STEP, STATUS } from '../js/survey.js';
import { buildHzn1, buildHzn2, crc32 } from '../js/exporters.js';

const W = 384, H = 288;
const HFOV = 66;
const tanH = Math.tan(HFOV / 2 * DEG);
const tanV = tanH * (H / W);
const intrinsics = { tanHalfH: tanH, tanHalfV: tanV };

/* ---- load the segmentation worker with a fake self ---------------------- */
const require = createRequire(import.meta.url);
const ROOT = new URL('../', import.meta.url).pathname;
const fs = require('fs');
let workerOnMessage = null;
const fakeSelf = {
  set onmessage(fn) { workerOnMessage = fn; },
  postMessage: (msg) => { fakeSelf._last = msg; }
};
const src = fs.readFileSync(ROOT + 'workers/segment.worker.js', 'utf8');
new Function('self', src)(fakeSelf);

function segment(rgba) {
  const buf = rgba.buffer.slice(0);
  workerOnMessage({ data: { id: 1, width: W, height: H, buffer: buf } });
  return fakeSelf._last;
}

/* ---- ground truth horizon ---------------------------------------------- */
function truth(azDeg) {
  const a = wrap360(azDeg);
  let alt = 8 + 2.5 * Math.sin(a * DEG * 3) + 1.5 * Math.sin(a * DEG * 7 + 1);
  if (a > 150 && a < 215) alt = 30 + 6 * Math.sin((a - 150) / 65 * Math.PI);   // house
  if (a > 292 && a < 312) alt += 18 * Math.sin((a - 292) / 20 * Math.PI);      // tree
  return Math.max(0, alt);
}

/* ---- synthetic frame renderer ------------------------------------------ */
let seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

function renderFrame(azDeg, elDeg) {
  // alpha such that rawYaw = 360 - alpha = azDeg  ->  alpha = 360 - azDeg
  const q = screenQuat(quatFromEuler(wrap360(360 - azDeg), 90 + elDeg, 0), 0);
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W * 2 - 1;
      const v = 1 - (y + 0.5) / H * 2;
      const { az, alt } = vecToAzAlt(quatRotate(q, cameraRay(u, v, tanH, tanV)));
      const p = (y * W + x) * 4;
      const isSky = alt > truth(az);
      if (isSky) {
        // Overcast-to-blue gradient, low texture.
        const t = Math.min(1, Math.max(0, alt / 50));
        rgba[p]     = 168 - 46 * t + rnd() * 5;
        rgba[p + 1] = 190 - 30 * t + rnd() * 5;
        rgba[p + 2] = 214 + 24 * t + rnd() * 5;
      } else {
        // Obstruction: dark, textured.
        const n = rnd();
        const base = alt > 20 ? 62 : 48;
        rgba[p]     = base + n * 34;
        rgba[p + 1] = base - 4 + n * 30;
        rgba[p + 2] = base - 10 + n * 26;
      }
      rgba[p + 3] = 255;
    }
  }
  return { rgba, quat: q, elDeg };
}

/* ---- run a two-pass survey --------------------------------------------- */
const survey = new Survey();
survey.yawDatum = 0;

function runPass(passNo, stepDeg, elevationFor) {
  survey.pass = passNo;
  let accepted = 0, rejected = 0;
  for (let az = 0; az < 360; az += stepDeg) {
    const el = elevationFor(az);
    const f = renderFrame(az, el);
    const seg = segment(f.rgba);
    if (seg.error) { console.log('seg error', seg.error); continue; }
    if (seg.noSky || seg.allSky) { rejected++; continue; }
    let clipped = 0;
    for (let i = 0; i < seg.flags.length; i++) if (seg.flags[i] === 1) clipped++;
    if (clipped / seg.flags.length > 0.22) { rejected++; continue; }
    const kf = survey.addKeyframe({
      t: Date.now(), pass: passNo, quat: f.quat, screenAngle: 0,
      yawRaw: wrap360(az), yawFused: az, yawBase: 0,
      elevation: el, roll: 0, compass: null, visualQuality: 0.9,
      skyFraction: seg.skyFraction, height: H,
      boundary: seg.boundary, confidence: seg.confidence, flags: seg.flags
    });
    survey._projectKeyframe(kf, intrinsics);
    accepted++;
  }
  return { accepted, rejected };
}

console.log('=== Pass 1: 360° sweep, 12° steps, camera aimed 12° up ===');
const p1 = runPass(1, 12, () => 12);
console.log(`  keyframes accepted ${p1.accepted}, rejected ${p1.rejected}`);

console.log('=== Pass 2: offset sweep, 12° steps from 6°, elevation varied ===');
const p2 = runPass(2, 12, az => (az > 150 && az < 215) ? 26 : (az > 290 && az < 315) ? 24 : 12);
// offset the second pass by half a step
survey.pass = 2;
for (let az = 6; az < 360; az += 12) {
  const el = (az > 150 && az < 215) ? 26 : (az > 290 && az < 315) ? 24 : 12;
  const f = renderFrame(az, el);
  const seg = segment(f.rgba);
  if (seg.noSky || seg.allSky) continue;
  let clipped = 0;
  for (let i = 0; i < seg.flags.length; i++) if (seg.flags[i] === 1) clipped++;
  if (clipped / seg.flags.length > 0.22) continue;
  const kf = survey.addKeyframe({
    t: Date.now(), pass: 2, quat: f.quat, screenAngle: 0,
    yawRaw: wrap360(az), yawFused: az, yawBase: 0,
    elevation: el, roll: 0, compass: null, visualQuality: 0.9,
    skyFraction: seg.skyFraction, height: H,
    boundary: seg.boundary, confidence: seg.confidence, flags: seg.flags
  });
  survey._projectKeyframe(kf, intrinsics);
}
console.log(`  keyframes accepted ${p2.accepted}, rejected ${p2.rejected}`);

survey.recompute();

/* ---- accuracy ----------------------------------------------------------- */
let errs = [], missing = 0;
for (let i = 0; i < BIN_COUNT; i++) {
  const b = survey.bins[i];
  if (!Number.isFinite(b.alt)) { missing++; continue; }
  errs.push(Math.abs(b.alt - truth(i * BIN_STEP)));
}
errs.sort((a, b) => a - b);
const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
const p50 = errs[Math.floor(errs.length * 0.5)];
const p95 = errs[Math.floor(errs.length * 0.95)];

const cov = survey.coverage();
console.log('');
console.log('=== Reconstruction vs ground truth ===');
console.log(`  bins with a value       ${BIN_COUNT - missing} / ${BIN_COUNT}`);
console.log(`  verified bins           ${cov.verifiedBins}`);
console.log(`  median observations     ${cov.medianObservations}`);
console.log(`  mean abs error          ${mean.toFixed(3)}°`);
console.log(`  median abs error        ${p50.toFixed(3)}°`);
console.log(`  95th pct abs error      ${p95.toFixed(3)}°`);
console.log(`  worst abs error         ${errs[errs.length - 1].toFixed(3)}°`);
console.log(`  max within-bin spread   ${cov.maxSpread.toFixed(3)}°`);
console.log(`  mean confidence         ${(cov.meanConfidence * 100).toFixed(1)}%`);

const rep = survey.report();
console.log('');
console.log('=== Report ===');
for (const c of rep.checks) console.log(`  ${c.pass ? '[pass]' : '[FAIL]'} ${c.name.padEnd(26)} ${c.detail}`);
console.log(`  GRADE: ${rep.grade}`);
console.log(`  weak sectors: ${rep.weak.length}`);

/* ---- exporters ---------------------------------------------------------- */
const meta = { siteName: 'Sim site', latitude: 42.1234567, longitude: -72.7654321, azOffset: -1.5, timestamp: 1700000000000 };
const b1 = buildHzn1(survey, meta);
const b2 = buildHzn2(survey, { ...meta, qualityGrade: 3, loopErrorDeg: 0.42, keyframeCount: survey.keyframes.length });
const v1 = new DataView(b1), u1 = new Uint8Array(b1);
console.log('');
console.log('=== Export byte checks ===');
console.log(`  HZN1 length ${b1.byteLength} (expect 764)`);
console.log(`  HZN1 magic  ${String.fromCharCode(...u1.slice(0, 4))}`);
console.log(`  HZN1 count  ${v1.getUint16(4, true)}  azOffset ${v1.getInt16(6, true)}  lat ${v1.getFloat32(8, true).toFixed(5)}`);
console.log(`  HZN1 name   "${new TextDecoder().decode(u1.slice(20, 44)).replace(/\0+$/, '')}"`);
console.log(`  HZN1 sample[0] ${u1[44]} -> ${(u1[44] / 2).toFixed(1)}° (truth ${truth(0).toFixed(1)}°)`);
const v2 = new DataView(b2), u2 = new Uint8Array(b2);
console.log(`  HZN2 length ${b2.byteLength} (expect ${64 + 720 * 2})`);
console.log(`  HZN2 magic  ${String.fromCharCode(...u2.slice(0, 4))}  crc ${v2.getUint32(60, true).toString(16)}`);
console.log(`  HZN2 crc verifies: ${crc32(u2.subarray(64)) === v2.getUint32(60, true)}`);

/* ---- weak sector detection ---------------------------------------------- */
const s2 = new Survey();
for (let i = 0; i < BIN_COUNT; i++) {
  const b = s2.bins[i];
  const inHole = (i * BIN_STEP > 74 && i * BIN_STEP < 91) || (i * BIN_STEP > 183 && i * BIN_STEP < 228);
  b.obs = inHole ? [{ value: 10, weight: 0.9, pass: 1 }] : Array.from({ length: 6 }, () => ({ value: 10, weight: 0.9, pass: 1 }));
  b.passes = new Set(inHole ? [1] : [1, 2]);
}
s2.recompute();
console.log('');
console.log('=== Weak sector detection (synthetic holes at 74–91 and 183–228) ===');
for (const w of s2.weakSectors()) console.log(`  ${w.fromDeg.toFixed(1)}° – ${w.toDeg.toFixed(1)}° (${w.widthDeg.toFixed(1)}° wide)`);
