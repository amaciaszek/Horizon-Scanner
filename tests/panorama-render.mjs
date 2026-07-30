/* Renders sample diagnostic panoramas to PNG so the output can be inspected
 * without a phone. Two cases:
 *   A. correct intrinsics
 *   B. the aspect-crop focal error — the app told a 16:9 sensor's full FOV but
 *      analysing a 4:3 centre crop of it, so every angle is scaled by 1/0.75.
 * Case B is the one that matters: it shows what the failure LOOKS like.
 */

import { createCanvas } from '@napi-rs/canvas';
import fs from 'fs';
import {
  quatFromEuler, screenQuat, quatRotate, cameraRay, vecToAzAlt, wrap360, DEG
} from '../js/math3d.js';
import { Survey } from '../js/survey.js';
import { buildMosaic, skylineTracks, drawPanorama, disagreementByBin } from '../js/panorama.js';

const W = 384, H = 288;
const TRUE_HFOV = 66;                       // what the lens really gives the work frame
const tanH_true = Math.tan(TRUE_HFOV / 2 * DEG);
const tanV_true = tanH_true * (H / W);

function truth(azDeg) {
  const a = wrap360(azDeg);
  let alt = 8 + 2.5 * Math.sin(a * DEG * 3) + 1.5 * Math.sin(a * DEG * 7 + 1);
  if (a > 150 && a < 215) alt = 30 + 6 * Math.sin((a - 150) / 65 * Math.PI);
  if (a > 292 && a < 312) alt += 18 * Math.sin((a - 292) / 20 * Math.PI);
  return Math.max(0, alt);
}

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

/* Render a frame using the TRUE optics — the camera does not care what the app
 * believes. Landmark stripes every 15° of azimuth give the eye something to
 * judge continuity by, which is the whole point of a stitched diagnostic. */
function renderFrame(azDeg, elDeg) {
  const q = screenQuat(quatFromEuler(wrap360(360 - azDeg), 90 + elDeg, 0), 0);
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W * 2 - 1;
      const v = 1 - (y + 0.5) / H * 2;
      const { az, alt } = vecToAzAlt(quatRotate(q, cameraRay(u, v, tanH_true, tanV_true)));
      const p = (y * W + x) * 4;
      const t = truth(az);
      const stripe = Math.abs(wrap360(az) % 15) < 0.9;
      if (alt > t) {
        const g = Math.min(1, Math.max(0, alt / 50));
        rgba[p] = 172 - 48 * g + rnd() * 4;
        rgba[p + 1] = 192 - 30 * g + rnd() * 4;
        rgba[p + 2] = 214 + 22 * g + rnd() * 4;
        if (stripe) { rgba[p] += 26; rgba[p + 1] += 12; rgba[p + 2] -= 18; }
      } else {
        const n = rnd();
        const base = t > 20 ? 66 : 48;
        rgba[p] = base + n * 32;
        rgba[p + 1] = base - 4 + n * 28;
        rgba[p + 2] = base - 10 + n * 24;
        if (stripe) { rgba[p] += 34; rgba[p + 1] += 30; rgba[p + 2] += 22; }
      }
      rgba[p + 3] = 255;
    }
  }
  return { rgba, quat: q };
}

/* Build a survey. assumedHfov is what the APP thinks the field of view is. */
function build(assumedHfov) {
  const tanH = Math.tan(assumedHfov / 2 * DEG);
  const tanV = tanH * (H / W);
  const survey = new Survey();
  survey.yawDatum = 0;
  const sources = [];
  for (let az = 0; az < 360; az += 9) {
    const el = (az > 150 && az < 215) ? 30 : (az > 292 && az < 312) ? 26 : 12;
    const f = renderFrame(az, el);
    const boundary = new Float32Array(W);
    const confidence = new Float32Array(W);
    const flags = new Uint8Array(W);
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W * 2 - 1;
      let row = H - 1;
      for (let y = 0; y < H; y++) {
        const v = 1 - (y + 0.5) / H * 2;
        // The segmenter finds the boundary in the REAL image.
        const r = vecToAzAlt(quatRotate(f.quat, cameraRay(u, v, tanH_true, tanV_true)));
        if (r.alt <= truth(r.az)) { row = y; break; }
      }
      boundary[x] = row;
      confidence[x] = 0.9;
      if (row <= 1) flags[x] = 1; else if (row >= H - 2) flags[x] = 2;
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
  return { survey, sources };
}

function render(label, assumedHfov, file) {
  const { survey, sources } = build(assumedHfov);
  const opts = { pxPerDeg: 5, altMin: -10, altMax: 60, azStart: 0 };
  const mosaic = buildMosaic({ keyframes: survey.keyframes, sources, yawDatum: 0, ...opts });
  const tracks = skylineTracks(survey.keyframes, 0, opts);
  const dis = disagreementByBin(survey.keyframes, 0);
  const spans = dis.filter(d => d.n >= 2).map(d => d.span).sort((a, b) => a - b);
  const medSpan = spans.length ? spans[spans.length >> 1] : NaN;
  const p95Span = spans.length ? spans[Math.floor(0.95 * (spans.length - 1))] : NaN;

  // Profile error against truth.
  const errs = [];
  survey.bins.forEach((b, i) => {
    if (!Number.isFinite(b.alt)) return;
    errs.push(Math.abs(b.alt - truth(i * 0.5)));
  });
  errs.sort((a, b) => a - b);

  const canvas = createCanvas(10, 10);
  const ctx = canvas.getContext('2d');
  drawPanorama(ctx, mosaic, tracks, survey.bins, {});
  fs.writeFileSync(file, canvas.toBuffer('image/png'));

  console.log(`\n${label}`);
  console.log(`  assumed HFOV        ${assumedHfov.toFixed(1)}°   (true ${TRUE_HFOV}°)`);
  console.log(`  painted coverage    ${(mosaic.painted / (mosaic.width * mosaic.height) * 100).toFixed(1)}%`);
  console.log(`  inter-frame skyline disagreement  median ${medSpan.toFixed(2)}°  p95 ${p95Span.toFixed(2)}°`);
  console.log(`  profile error vs truth            median ${errs[errs.length >> 1].toFixed(2)}°  max ${errs[errs.length - 1].toFixed(2)}°`);
  console.log(`  -> ${file}`);
  return { medSpan, p95Span };
}

const good = render('A. Correct intrinsics', TRUE_HFOV, '/home/claude/hs/out-good.png');
// A 1920x1080 source cover-cropped into a 4:3 work frame keeps 75% of the width,
// so the work frame's true HFOV is 0.75x the sensor's. Believing the sensor
// figure inflates every angle by 1/0.75.
const badHfov = 2 * Math.atan(tanH_true / 0.75) / DEG;
const bad = render('B. Aspect-crop focal error (the 16:9 -> 4:3 crop bug)', badHfov, '/home/claude/hs/out-bad.png');

console.log(`\ndisagreement ratio bad/good: ${(bad.medSpan / good.medSpan).toFixed(1)}x`);
console.log('The panorama separates the two cases without any ground truth:');
console.log('a focal error cannot be made consistent, so frames that overlap');
console.log('disagree, and the disagreement is what the picture shows.');
