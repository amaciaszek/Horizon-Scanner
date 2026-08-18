'use strict';
/* Diagnostic panorama.
 *
 * Builds an equirectangular azimuth/altitude mosaic from the stored keyframes
 * and draws, on top of it, every skyline the survey actually believed. The point
 * is not a pretty picture — it is to make three specific failure modes visible
 * at a glance, in the one coordinate system the profile is expressed in:
 *
 *   1. Geometry error. Each output pixel is taken from ONE keyframe — the one
 *      whose optical axis is closest to it — rather than blended. Blending hides
 *      misregistration behind a smooth average; nearest-axis selection turns it
 *      into a hard seam. A visible step in a roofline at a frame boundary is
 *      direct evidence of a rotation or focal-length error, and its size in
 *      degrees is readable off the azimuth scale.
 *
 *   2. Detection error. The per-keyframe skylines are drawn individually. Where
 *      the frames agree the tracks overlap into one thin line; where the
 *      segmenter was guessing they fan out into a band. The band's thickness is
 *      the disagreement, in degrees.
 *
 *   3. Scale error. A full lap is 360° by definition. If the mosaic wraps onto
 *      itself early or leaves a wedge unpainted, the focal length is wrong, and
 *      the overlap ratio at the seam gives the correction factor.
 *
 * The projection here is deliberately identical to Survey._projectKeyframe. If
 * the two ever disagree, the panorama is lying and should be trusted less than
 * the profile, not more.
 */

import { quatMul, quatConj, quatRotate, yawQuat, wrap360, clamp, angDiff, DEG } from './math3d.js';
import { BIN_COUNT, BIN_STEP, STATUS } from './survey.js';

export const PANO_DEFAULTS = {
  pxPerDeg: 8,
  altMin: -12,
  altMax: 62,
  azStart: 0
};

const INK = {
  bg: '#060d11',
  panel: '#0d171c',
  grid: '#1e2f37',
  gridStrong: '#33505c',
  text: '#7d949e',
  ink: '#e8f4f8',
  signal: '#2ec7e6',
  amber: '#e0a33c',
  coral: '#ff7a59',
  violet: '#b48cf2',
  thin: '#3d5a63'
};

/* ------------------------------------------------------------------ geometry */

/** Unit vector in the ENU world frame for an azimuth/altitude pair. */
export function azAltToVec(azDeg, altDeg) {
  const a = azDeg * DEG, e = altDeg * DEG;
  const ca = Math.cos(e);
  return [Math.sin(a) * ca, Math.cos(a) * ca, Math.sin(e)];
}

/**
 * World-to-camera quaternion for a keyframe, including the same yaw corrections
 * the survey applies. Mirrors Survey._projectKeyframe exactly.
 */
export function keyframeQuat(kf, yawDatum = 0) {
  const total = (kf.yawBase || 0) + (kf.yawCorrection || 0) + (yawDatum || 0);
  return total ? quatMul(yawQuat(total), kf.quat) : kf.quat;
}

/**
 * Project a world direction into a keyframe's normalised image coordinates.
 * Returns null when the direction is behind the camera or outside the frame.
 * u: -1 left .. +1 right, v: -1 bottom .. +1 top — the same convention as
 * cameraRay(), so this is its exact inverse.
 */
export function worldToImage(world, qConj, tanH, tanV) {
  const c = quatRotate(qConj, world);
  const depth = -c[2];
  if (depth <= 1e-6) return null;              // behind the camera
  const u = c[0] / depth / tanH;
  const v = c[1] / depth / tanV;
  if (u < -1 || u > 1 || v < -1 || v > 1) return null;
  return [u, v];
}

/** Bilinear RGB sample from a packed RGBA buffer. Clamped at the edges. */
function sampleRGB(src, fx, fy, out) {
  const { w, h, data } = src;
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
  if (x1 > w - 1) x1 = w - 1; if (y1 > h - 1) y1 = h - 1;
  if (x0 > w - 1) x0 = w - 1; if (y0 > h - 1) y0 = h - 1;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty, w11 = tx * ty;
  for (let k = 0; k < 3; k++) {
    out[k] = data[i00 + k] * w00 + data[i10 + k] * w10 +
             data[i01 + k] * w01 + data[i11 + k] * w11;
  }
}

/**
 * Build the mosaic.
 *
 * keyframes : survey keyframes (need quat, tanHalfH/V, yawBase, height, boundary)
 * sources   : array parallel to keyframes; each {w, h, data} RGBA or null.
 *             Nulls are fine — geometry-only mode still produces the overlays.
 *
 * Returns { rgba, owner, axisDist, width, height, painted, opts }.
 * owner[i] is the keyframe index that won pixel i, or -1 if unpainted.
 */
export function buildMosaic({ keyframes, sources = [], yawDatum = 0, ...over }) {
  const opts = { ...PANO_DEFAULTS, ...over };
  const { pxPerDeg, altMin, altMax, azStart } = opts;
  const width = Math.round(360 * pxPerDeg);
  const height = Math.round((altMax - altMin) * pxPerDeg);

  const rgba = new Uint8ClampedArray(width * height * 4);
  const owner = new Int32Array(width * height).fill(-1);
  const axisDist = new Float32Array(width * height).fill(Infinity);

  /*
   * Two ways to fill a pixel, and they exist for opposite reasons.
   *
   * Nearest-axis (blend = false) is the diagnostic mode this file was written
   * for: one frame wins each pixel outright, so a rotation or focal error shows
   * up as a hard step in a roofline that can be measured off the azimuth scale.
   * It is unforgiving on purpose and it is what should be trusted when
   * something looks wrong.
   *
   * Feathered (blend = true) is what the offline reference does and what a
   * person actually wants to look at. Each frame contributes with a weight that
   * falls to zero at its own edges, so contributions cross-fade over the whole
   * overlap instead of stopping dead at a seam. The weight is
   * ((1-|u|)(1-|v|))^2 — one on the optical axis, zero at the frame border,
   * squared so the centre of a frame decisively outvotes the corner of its
   * neighbour.
   *
   * Blending does hide misregistration, which is exactly the objection above.
   * That is why the mode is a switch and not a replacement: `owner` and
   * `axisDist` are still filled by the nearest-axis rule in both modes, so
   * every overlay and every number derived from them is unchanged.
   */
  const blend = !!opts.blend;
  const accR = blend ? new Float32Array(width * height) : null;
  const accG = blend ? new Float32Array(width * height) : null;
  const accB = blend ? new Float32Array(width * height) : null;
  const accW = blend ? new Float32Array(width * height) : null;

  // Precompute the world ray for every output pixel column/row once.
  const azFor = new Float64Array(width);
  for (let x = 0; x < width; x++) azFor[x] = wrap360(azStart + (x + 0.5) / pxPerDeg);
  const altFor = new Float64Array(height);
  for (let y = 0; y < height; y++) altFor[y] = altMax - (y + 0.5) / pxPerDeg;

  const px = [0, 0, 0];
  let painted = 0;

  for (let k = 0; k < keyframes.length; k++) {
    const kf = keyframes[k];
    const src = sources[k];
    const tanH = kf.tanHalfH, tanV = kf.tanHalfV;
    if (!(tanH > 0) || !(tanV > 0)) continue;
    const qc = quatConj(keyframeQuat(kf, yawDatum));

    // Bound the search: a frame covers at most its diagonal half-angle from the
    // optical axis, so only scan output rows/cols within that of the axis.
    const axis = quatRotate(keyframeQuat(kf, yawDatum), [0, 0, -1]);
    const axisAlt = Math.atan2(axis[2], Math.hypot(axis[0], axis[1])) / DEG;
    const axisAz = wrap360(Math.atan2(axis[0], axis[1]) / DEG);
    const halfDiag = Math.atan(Math.hypot(tanH, tanV)) / DEG + 1;
    // Azimuth span widens as the frame tilts up; cos guard keeps it finite.
    const azPad = Math.min(180, halfDiag / Math.max(0.15, Math.cos(clamp(axisAlt, -80, 80) * DEG)));

    const yLo = Math.max(0, Math.floor((altMax - (axisAlt + halfDiag)) * pxPerDeg));
    const yHi = Math.min(height - 1, Math.ceil((altMax - (axisAlt - halfDiag)) * pxPerDeg));
    const xSpan = Math.ceil(azPad * pxPerDeg);
    const xMid = Math.round((wrap360(axisAz - azStart)) * pxPerDeg);

    for (let y = yLo; y <= yHi; y++) {
      const alt = altFor[y];
      for (let dx = -xSpan; dx <= xSpan; dx++) {
        const x = ((xMid + dx) % width + width) % width;
        const uv = worldToImage(azAltToVec(azFor[x], alt), qc, tanH, tanV);
        if (!uv) continue;
        const d = Math.max(Math.abs(uv[0]), Math.abs(uv[1]));
        const i = y * width + x;

        if (blend && src) {
          // Every frame that can see this pixel contributes, so this runs
          // before the nearest-axis test rather than inside it.
          const fu = 1 - Math.abs(uv[0]);
          const fv = 1 - Math.abs(uv[1]);
          if (fu > 0 && fv > 0) {
            const w = (fu * fv) * (fu * fv);
            sampleRGB(src, (uv[0] + 1) / 2 * src.w - 0.5, (1 - uv[1]) / 2 * src.h - 0.5, px);
            accR[i] += px[0] * w; accG[i] += px[1] * w; accB[i] += px[2] * w;
            accW[i] += w;
          }
        }

        if (d >= axisDist[i]) continue;         // an earlier frame saw it better
        axisDist[i] = d;
        if (owner[i] === -1) painted++;
        owner[i] = k;
        if (!src || blend) continue;
        sampleRGB(src, (uv[0] + 1) / 2 * src.w - 0.5, (1 - uv[1]) / 2 * src.h - 0.5, px);
        const p = i * 4;
        rgba[p] = px[0]; rgba[p + 1] = px[1]; rgba[p + 2] = px[2]; rgba[p + 3] = 255;
      }
    }
  }

  if (blend) {
    for (let i = 0; i < width * height; i++) {
      const w = accW[i];
      if (!(w > 0)) continue;
      const p = i * 4;
      rgba[p] = accR[i] / w; rgba[p + 1] = accG[i] / w; rgba[p + 2] = accB[i] / w;
      rgba[p + 3] = 255;
    }
  }

  return { rgba, owner, axisDist, width, height, painted, opts, yawDatum };
}

/**
 * Every keyframe's own skyline, in panorama pixel coordinates.
 * Returns [{ index, pass, kind, pts: [{x, y, az, alt, conf}] }].
 * Segments are split where they wrap the seam so a polyline never streaks
 * across the whole image.
 */
export function skylineTracks(keyframes, yawDatum, opts) {
  const { pxPerDeg, altMin, altMax, azStart } = { ...PANO_DEFAULTS, ...opts };
  const width = Math.round(360 * pxPerDeg);
  const out = [];
  for (const kf of keyframes) {
    const q = keyframeQuat(kf, yawDatum);
    const tanH = kf.tanHalfH, tanV = kf.tanHalfV;
    if (!(tanH > 0) || !(tanV > 0) || !kf.boundary) continue;
    const n = kf.boundary.length;
    const segs = [];
    let cur = [];
    let prevX = null;
    for (let x = 0; x < n; x++) {
      const flag = kf.flags ? kf.flags[x] : 0;
      const conf = kf.confidence ? kf.confidence[x] : 1;
      if (flag !== 0 || conf <= 0.05) { if (cur.length > 1) segs.push(cur); cur = []; prevX = null; continue; }
      const u = (x + 0.5) / n * 2 - 1;
      const v = 1 - (kf.boundary[x] / kf.height) * 2;
      // Forward-project through the identical path the survey uses.
      const cx = u * tanH, cy = v * tanV, cz = -1;
      const nrm = Math.hypot(cx, cy, cz);
      const world = quatRotate(q, [cx / nrm, cy / nrm, cz / nrm]);
      const h = Math.hypot(world[0], world[1]);
      const az = wrap360(Math.atan2(world[0], world[1]) / DEG);
      const alt = Math.atan2(world[2], h) / DEG;
      if (alt < altMin || alt > altMax) { if (cur.length > 1) segs.push(cur); cur = []; prevX = null; continue; }
      const pxX = wrap360(az - azStart) * pxPerDeg;
      const pxY = (altMax - alt) * pxPerDeg;
      if (prevX !== null && Math.abs(pxX - prevX) > width / 2) { if (cur.length > 1) segs.push(cur); cur = []; }
      cur.push({ x: pxX, y: pxY, az, alt, conf });
      prevX = pxX;
    }
    if (cur.length > 1) segs.push(cur);
    if (segs.length) out.push({ index: kf.index, pass: kf.pass, kind: kf.captureKind || 'sweep', segs });
  }
  return out;
}

/**
 * Per-bin disagreement between keyframes, in degrees. This is the number that
 * localises a bad horizon line: a bin where six frames each report a different
 * altitude is not a noisy measurement, it is an unresolved one.
 */
export function disagreementByBin(keyframes, yawDatum) {
  const acc = Array.from({ length: BIN_COUNT }, () => []);
  for (const kf of keyframes) {
    const q = keyframeQuat(kf, yawDatum);
    const tanH = kf.tanHalfH, tanV = kf.tanHalfV;
    if (!(tanH > 0) || !(tanV > 0) || !kf.boundary) continue;
    const n = kf.boundary.length;
    for (let x = 0; x < n; x++) {
      if ((kf.flags ? kf.flags[x] : 0) !== 0) continue;
      if ((kf.confidence ? kf.confidence[x] : 1) <= 0.05) continue;
      const u = (x + 0.5) / n * 2 - 1;
      const v = 1 - (kf.boundary[x] / kf.height) * 2;
      const cx = u * tanH, cy = v * tanV, cz = -1;
      const nrm = Math.hypot(cx, cy, cz);
      const w = quatRotate(q, [cx / nrm, cy / nrm, cz / nrm]);
      const az = wrap360(Math.atan2(w[0], w[1]) / DEG);
      const alt = Math.atan2(w[2], Math.hypot(w[0], w[1])) / DEG;
      acc[Math.round(az / BIN_STEP) % BIN_COUNT].push(alt);
    }
  }
  return acc.map(list => {
    if (list.length < 2) return { n: list.length, span: 0, p5: NaN, p95: NaN };
    const s = list.slice().sort((a, b) => a - b);
    const p5 = s[Math.floor(0.05 * (s.length - 1))];
    const p95 = s[Math.ceil(0.95 * (s.length - 1))];
    return { n: s.length, span: p95 - p5, p5, p95 };
  });
}

/**
 * Seam analysis: where adjacent owners meet, how far apart do their two
 * skylines sit? A large step at a seam is a geometry error, and unlike a
 * confidence number it cannot be argued with.
 */
export function seamSteps(mosaic, tracks) {
  const { owner, width, height, opts } = mosaic;
  const byAzOwner = new Map();
  for (const t of tracks) {
    for (const seg of t.segs) {
      for (const p of seg) {
        const col = Math.round(p.x) % width;
        let m = byAzOwner.get(col);
        if (!m) { m = new Map(); byAzOwner.set(col, m); }
        m.set(t.index, p.alt);
      }
    }
  }
  const steps = [];
  for (let x = 1; x < width; x++) {
    // Owner of the topmost painted pixel changes => a frame boundary.
    let a = -1, b = -1;
    for (let y = 0; y < height; y++) { const o = owner[y * width + x - 1]; if (o >= 0) { a = o; break; } }
    for (let y = 0; y < height; y++) { const o = owner[y * width + x]; if (o >= 0) { b = o; break; } }
    if (a < 0 || b < 0 || a === b) continue;
    const m = byAzOwner.get(x % width);
    if (!m) continue;
    const ka = mosaic_kfIndex(mosaic, a), kb = mosaic_kfIndex(mosaic, b);
    const va = m.get(ka), vb = m.get(kb);
    if (va === undefined || vb === undefined) continue;
    steps.push({
      azDeg: wrap360(opts.azStart + x / opts.pxPerDeg),
      stepDeg: Math.abs(va - vb),
      frames: [ka, kb]
    });
  }
  steps.sort((p, q) => q.stepDeg - p.stepDeg);
  return steps;
}

// owner[] holds array positions; keyframes carry their own .index.
function mosaic_kfIndex(mosaic, pos) {
  return mosaic.keyframeIndex ? mosaic.keyframeIndex[pos] : pos;
}

/**
 * Convert a panorama pixel back to the azimuth/altitude the survey assigned it.
 *
 * This is what makes the mosaic checkable against the outside world. Everything
 * else here is self-consistent: the imagery is painted at the azimuth the app
 * believes, so a global offset or a slow drift in azimuth produces a picture
 * that looks entirely correct while pointing in the wrong direction. Reading a
 * recognisable landmark's assigned bearing off the image and comparing it with
 * its true bearing from a map is the only check that closes that loop.
 *
 * rulerHeight is the offset returned by drawPanorama, since the imagery does
 * not start at y=0.
 */
export function pixelToAzAlt(px, py, opts, rulerHeight = 0) {
  const o = { ...PANO_DEFAULTS, ...opts };
  return {
    az: wrap360(o.azStart + px / o.pxPerDeg),
    alt: o.altMax - (py - rulerHeight) / o.pxPerDeg
  };
}

/**
 * Compare landmarks of KNOWN true bearing against the bearings the survey
 * assigned them.
 *
 * The mean residual and its spread say different things and must not be
 * averaged together. A constant offset is just the datum — the mount corrects
 * it with one number and it harms nothing. A residual that varies with bearing
 * is drift or magnetic distortion, and that is what rotates parts of the
 * profile relative to other parts, which no single correction can undo.
 *
 * landmarks: [{ trueAz, measuredAz }]. Entries without both are ignored.
 */
export function landmarkResiduals(landmarks) {
  const rows = landmarks
    .filter(l => Number.isFinite(l.trueAz) && Number.isFinite(l.measuredAz))
    .map(l => ({ ...l, residual: angDiff(l.trueAz, l.measuredAz) }));
  if (!rows.length) return { rows, n: 0 };
  const r = rows.map(x => x.residual).sort((a, b) => a - b);
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  // Spread is the quantity that matters, so report the full span and, once
  // there are enough points for a percentile to mean anything, a robust one.
  const span = r[r.length - 1] - r[0];
  const p5 = r[Math.floor(0.05 * (r.length - 1))];
  const p95 = r[Math.ceil(0.95 * (r.length - 1))];
  return {
    rows: rows.sort((a, b) => a.trueAz - b.trueAz),
    n: r.length, mean, span,
    robustSpan: r.length >= 6 ? p95 - p5 : NaN,
    worst: rows.reduce((a, b) => Math.abs(b.residual - mean) > Math.abs(a.residual - mean) ? b : a)
  };
}

/* ------------------------------------------------------------------- drawing */

/**
 * Render the mosaic plus overlays onto a 2D canvas context.
 * bins is the survey's bin array; pass null to skip the profile overlay.
 */
export function drawPanorama(ctx, mosaic, tracks, bins, extras = {}) {
  const { width, height, opts, rgba, owner } = mosaic;
  const { pxPerDeg, altMax, altMin, azStart } = opts;
  const STRIP = 26;                 // bin-status strip under the image
  const RULER = 22;                 // azimuth ruler above it
  const total = height + STRIP + RULER;

  ctx.canvas.width = width;
  ctx.canvas.height = total;
  ctx.fillStyle = INK.bg;
  ctx.fillRect(0, 0, width, total);

  // Imagery, with unsurveyed pixels filled by a diagonal hatch so a gap reads
  // as a gap rather than as dark ground. Composed in the buffer because
  // putImageData replaces pixel data outright and would erase anything drawn
  // underneath it.
  const img = ctx.createImageData(width, height);
  const d = img.data;
  d.set(rgba);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (owner[i] >= 0) continue;
      const hatch = ((x + y) % 9) < 2;
      const p = i * 4;
      d[p] = hatch ? 74 : 18; d[p + 1] = hatch ? 34 : 26; d[p + 2] = hatch ? 27 : 31;
      d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, RULER);

  // Altitude grid.
  ctx.font = '11px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  for (let a = Math.ceil(altMin / 10) * 10; a <= altMax; a += 10) {
    const y = RULER + (altMax - a) * pxPerDeg;
    ctx.strokeStyle = a === 0 ? INK.gridStrong : INK.grid;
    ctx.lineWidth = a === 0 ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    ctx.fillStyle = INK.text;
    ctx.fillText(`${a}\u00b0`, 4, y - 7);
  }

  // Azimuth ruler with cardinals.
  const CARD = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  ctx.textBaseline = 'alphabetic';
  for (let az = 0; az < 360; az += 5) {
    const x = wrap360(az - azStart) * pxPerDeg;
    const major = az % 30 === 0;
    ctx.strokeStyle = major ? INK.gridStrong : INK.grid;
    ctx.beginPath();
    ctx.moveTo(x, RULER - (major ? 9 : 4)); ctx.lineTo(x, RULER);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = CARD[az] ? INK.ink : INK.text;
      ctx.font = CARD[az] ? 'bold 12px ui-monospace, monospace' : '11px ui-monospace, monospace';
      const label = CARD[az] || `${az}`;
      ctx.fillText(label, x - ctx.measureText(label).width / 2, RULER - 12);
      ctx.strokeStyle = 'rgba(46,199,230,0.10)';
      ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, RULER + height); ctx.stroke();
    }
  }

  // Per-keyframe skylines. Thin, low alpha, so overlap darkens into a band
  // whose thickness IS the disagreement.
  for (const t of tracks) {
    ctx.strokeStyle = t.pass === 2 ? 'rgba(224,163,60,0.45)' : 'rgba(46,199,230,0.40)';
    ctx.lineWidth = 1;
    for (const seg of t.segs) {
      ctx.beginPath();
      ctx.moveTo(seg[0].x, RULER + seg[0].y);
      for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, RULER + seg[i].y);
      ctx.stroke();
    }
  }

  // The committed profile, drawn last and solid: this is what the mount will use.
  if (bins) {
    ctx.strokeStyle = INK.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let open = false;
    for (let i = 0; i <= BIN_COUNT; i++) {
      const b = bins[i % BIN_COUNT];
      const az = (i % BIN_COUNT) * BIN_STEP;
      if (!b || !Number.isFinite(b.alt)) { open = false; continue; }
      const x = wrap360(az - azStart) * pxPerDeg;
      const y = RULER + (altMax - b.alt) * pxPerDeg;
      if (!open) { ctx.moveTo(x, y); open = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Status strip.
    const sy = RULER + height;
    for (let i = 0; i < BIN_COUNT; i++) {
      const b = bins[i];
      let c = INK.grid;
      if (b) {
        if (b.manual || b.interpolated) c = INK.violet;
        else if (b.status === STATUS.VERIFIED) c = INK.signal;
        else if (b.status === STATUS.WEAK) c = INK.amber;
        else if (b.status === STATUS.THIN) c = INK.thin;
      }
      const x0 = wrap360(i * BIN_STEP - azStart) * pxPerDeg;
      ctx.fillStyle = c;
      ctx.fillRect(x0, sy + 4, Math.max(1, BIN_STEP * pxPerDeg), STRIP - 12);
    }
    ctx.fillStyle = INK.text;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('bin status', 4, sy + STRIP - 1);
  }

  // Callouts for the worst seams, if supplied.
  if (extras.seams) {
    ctx.font = 'bold 11px ui-monospace, monospace';
    for (const s of extras.seams.slice(0, 6)) {
      const x = wrap360(s.azDeg - azStart) * pxPerDeg;
      ctx.strokeStyle = INK.coral;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, RULER + height); ctx.stroke();
      ctx.fillStyle = INK.coral;
      ctx.fillText(`${s.stepDeg.toFixed(1)}\u00b0`, x + 3, RULER + 14);
    }
  }

  return { width, height: total, rulerHeight: RULER };
}
