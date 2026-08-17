'use strict';
import { clamp, wrap360, angDiff, quatConj } from './math3d.js';
import { azAltToVec, worldToImage } from './panorama.js';
import { BIN_COUNT, BIN_STEP, STATUS } from './survey.js';

const COLOR = {
  empty: '#1b2a31',
  thin: '#3d5a63',
  weak: '#e0a33c',
  verified: '#2ec7e6',
  manual: '#b48cf2',
  target: '#ff7a59',
  grid: '#1e2f37',
  gridStrong: '#33505c',
  text: '#7d949e',
  ink: '#e8f4f8'
};

/* ------------------------------------------------------------------ the ring */

/**
 * The survey ring. Outer annulus = per-sector verification state, inner polar
 * plot = the skyline itself, needle = where the camera is pointing with its
 * field of view. This is the instrument the operator actually reads while
 * turning, so it has to answer "where am I" and "what still needs work" without
 * any text.
 */
export function drawRing(canvas, survey, view) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(rect.width * dpr)) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2 - 6;
  const ringOuter = R, ringInner = R - Math.max(9, R * 0.10);
  const plotR = ringInner - Math.max(8, R * 0.06);

  const toAngle = az => (az - 90) * Math.PI / 180;   // north at top, clockwise

  // Status annulus
  for (let i = 0; i < BIN_COUNT; i++) {
    const b = survey.bins[i];
    let c = COLOR.empty;
    if (b.manual || b.interpolated) c = COLOR.manual;
    else if (b.status === STATUS.VERIFIED) c = COLOR.verified;
    else if (b.status === STATUS.WEAK) c = COLOR.weak;
    else if (b.status === STATUS.THIN) c = COLOR.thin;
    const a0 = toAngle(i * BIN_STEP), a1 = toAngle((i + 1.02) * BIN_STEP);
    ctx.beginPath();
    ctx.arc(cx, cy, ringOuter, a0, a1);
    ctx.arc(cx, cy, ringInner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = c;
    ctx.fill();
  }

  // Target sector highlight
  if (view.target) {
    const a0 = toAngle(view.target.fromDeg), a1 = toAngle(view.target.fromDeg + view.target.widthDeg);
    ctx.beginPath();
    ctx.arc(cx, cy, ringOuter + 3, a0, a1);
    ctx.arc(cx, cy, ringInner - 3, a1, a0, true);
    ctx.closePath();
    ctx.strokeStyle = COLOR.target;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Altitude grid
  ctx.strokeStyle = COLOR.grid;
  ctx.lineWidth = 1;
  for (const alt of [15, 30, 45, 60, 75]) {
    ctx.beginPath();
    ctx.arc(cx, cy, plotR * (1 - alt / 90), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = COLOR.gridStrong;
  ctx.beginPath(); ctx.arc(cx, cy, plotR, 0, Math.PI * 2); ctx.stroke();

  for (const [az, label] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    const a = toAngle(az);
    ctx.strokeStyle = COLOR.grid;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * plotR * 0.12, cy + Math.sin(a) * plotR * 0.12);
    ctx.lineTo(cx + Math.cos(a) * plotR, cy + Math.sin(a) * plotR);
    ctx.stroke();
    ctx.fillStyle = COLOR.text;
    ctx.font = `600 ${Math.max(9, R * 0.075)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lr = (ringInner + ringOuter) / 2;
    ctx.fillText(label, cx + Math.cos(a) * lr, cy + Math.sin(a) * lr);
  }

  // Skyline silhouette: radius shrinks as altitude rises, so the plot reads as
  // "how much sky is left" rather than as an abstract curve.
  ctx.beginPath();
  let started = false;
  for (let i = 0; i <= BIN_COUNT; i++) {
    const b = survey.bins[i % BIN_COUNT];
    if (!Number.isFinite(b.alt)) { started = false; continue; }
    const r = plotR * (1 - clamp(b.alt, 0, 90) / 90);
    const a = toAngle(i * BIN_STEP);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = COLOR.ink;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // Field-of-view wedge and heading needle
  if (Number.isFinite(view.heading)) {
    const half = (view.hfovDeg || 66) / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, plotR, toAngle(view.heading - half), toAngle(view.heading + half));
    ctx.closePath();
    ctx.fillStyle = 'rgba(46,199,230,0.13)';
    ctx.fill();

    const a = toAngle(view.heading);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * plotR, cy + Math.sin(a) * plotR);
    ctx.strokeStyle = COLOR.verified;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = COLOR.verified;
    ctx.fill();
  }
}

/* --------------------------------------------------------------- the profile */

export function drawProfile(canvas, survey, view) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(rect.width * dpr)) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height;
  const padL = 30, padB = 18, padT = 8;
  const plotW = W - padL - 6, plotH = H - padB - padT;
  const maxAlt = view.maxAlt || 60;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a1418';
  ctx.fillRect(0, 0, W, H);

  const yOf = alt => padT + plotH * (1 - clamp(alt, 0, maxAlt) / maxAlt);
  const xOf = idx => padL + plotW * (idx / BIN_COUNT);

  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  const step = maxAlt <= 20 ? 5 : maxAlt <= 45 ? 10 : 15;
  for (let alt = 0; alt <= maxAlt; alt += step) {
    const y = yOf(alt);
    ctx.strokeStyle = alt === 0 ? COLOR.gridStrong : COLOR.grid;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - 6, y); ctx.stroke();
    ctx.fillStyle = COLOR.text;
    ctx.textAlign = 'right';
    ctx.fillText(`${alt}°`, padL - 5, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let az = 0; az <= 360; az += 45) {
    const x = xOf(az / BIN_STEP);
    ctx.strokeStyle = COLOR.grid;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    const labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW', 360: 'N' };
    ctx.fillStyle = COLOR.text;
    ctx.fillText(labels[az], clamp(x, padL + 8, W - 12), padT + plotH + 4);
  }

  // Spread band
  ctx.beginPath();
  let open = false;
  for (let i = 0; i < BIN_COUNT; i++) {
    const b = survey.bins[i];
    if (!Number.isFinite(b.alt)) { open = false; continue; }
    const x = xOf(i);
    if (!open) { ctx.moveTo(x, yOf(b.alt + b.spread)); open = true; } else ctx.lineTo(x, yOf(b.alt + b.spread));
  }
  for (let i = BIN_COUNT - 1; i >= 0; i--) {
    const b = survey.bins[i];
    if (!Number.isFinite(b.alt)) continue;
    ctx.lineTo(xOf(i), yOf(Math.max(0, b.alt - b.spread)));
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(46,199,230,0.14)';
  ctx.fill();

  // Filled silhouette
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < BIN_COUNT; i++) {
    const b = survey.bins[i];
    if (!Number.isFinite(b.alt)) { started = false; continue; }
    const x = xOf(i), y = yOf(b.alt);
    if (!started) { ctx.moveTo(x, padT + plotH); ctx.lineTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.lineTo(xOf(BIN_COUNT - 1), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(20,44,53,0.85)';
  ctx.fill();

  // Status-coloured line, drawn in runs
  let runStart = 0;
  const colorFor = b => b.manual || b.interpolated ? COLOR.manual
    : b.status === STATUS.VERIFIED ? COLOR.verified
      : b.status === STATUS.WEAK ? COLOR.weak
        : b.status === STATUS.THIN ? COLOR.thin : COLOR.empty;
  ctx.lineWidth = 2;
  while (runStart < BIN_COUNT) {
    const b0 = survey.bins[runStart];
    if (!Number.isFinite(b0.alt)) { runStart++; continue; }
    const c = colorFor(b0);
    let i = runStart;
    ctx.beginPath();
    ctx.moveTo(xOf(i), yOf(b0.alt));
    while (i + 1 < BIN_COUNT && Number.isFinite(survey.bins[i + 1].alt) && colorFor(survey.bins[i + 1]) === c) {
      i++;
      ctx.lineTo(xOf(i), yOf(survey.bins[i].alt));
    }
    ctx.strokeStyle = c;
    ctx.stroke();
    runStart = i + 1;
  }

  // Current heading marker
  if (Number.isFinite(view.heading)) {
    const x = xOf(wrap360(view.heading) / BIN_STEP);
    ctx.strokeStyle = 'rgba(232,244,248,0.55)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Target sector
  if (view.target) {
    const x0 = xOf(view.target.fromDeg / BIN_STEP);
    const w = plotW * (view.target.widthDeg / 360);
    ctx.fillStyle = 'rgba(255,122,89,0.16)';
    ctx.fillRect(x0, padT, w, plotH);
  }

  return { padL, padT, plotW, plotH, maxAlt };
}

/* ------------------------------------------------------- live camera overlay */

/**
 * The guidance dot and the coverage strip.
 *
 * `guide` is the object `ScanGuidance.update()` returned, plus the pose and
 * intrinsics needed to place a world bearing on the screen. The dot is drawn
 * where the camera would actually see that bearing — through the same
 * projection the panorama uses, roll and all — so following it means physically
 * turning to put it in the middle of the picture, which is the entire
 * interaction. When the bearing is off-frame the dot becomes an arrow pinned to
 * the edge it lies beyond, because a target you cannot find is not guidance.
 */
function drawGuidance(ctx, W, H, guide) {
  if (!guide) return;
  const { bearingDeg, state, summary, quat, tanHalfH, tanHalfV, altitudeDeg = 0 } = guide;

  // --- the 360-degree coverage strip -------------------------------------
  // Fixed mapping, north at the left, so a section that has been finished stays
  // put on screen instead of sliding about as the operator turns. Thin, low
  // contrast, bottom of frame: it answers "how much is left" at a glance and is
  // not asking to be studied.
  // Array-LIKE, not Array: the coverage map hands over its Float32Array
  // directly to avoid copying 180 floats every frame, and `Array.isArray` says
  // no to that. Getting this wrong meant the strip silently never drew.
  const scores = guide.scores;
  if (summary && scores && scores.length > 0) {
    const barH = 4;
    const y = H - 26;
    const n = scores.length;
    ctx.fillStyle = 'rgba(8,16,20,0.55)';
    ctx.fillRect(0, y - 2, W, barH + 4);
    for (let i = 0; i < n; i++) {
      const x0 = i / n * W, x1 = (i + 1) / n * W;
      const score = scores[i];
      const done = guide.covered && guide.covered[i];
      ctx.fillStyle = done ? 'rgba(46,199,230,0.95)'
        : score > 0.25 ? `rgba(46,199,230,${0.18 + score * 0.4})`
          : 'rgba(232,244,248,0.10)';
      ctx.fillRect(x0, y, Math.max(1, x1 - x0 + 0.5), barH);
    }
    // Where the camera is now, and where the dot is asking for.
    if (Number.isFinite(guide.headingDeg)) {
      const x = wrap360(guide.headingDeg) / 360 * W;
      ctx.fillStyle = 'rgba(232,244,248,0.9)';
      ctx.fillRect(x - 1, y - 3, 2, barH + 6);
    }
    if (Number.isFinite(bearingDeg) && state !== 'complete') {
      const x = wrap360(bearingDeg) / 360 * W;
      ctx.fillStyle = COLOR.target;
      ctx.beginPath();
      ctx.arc(x, y + barH / 2, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (state === 'complete' || !Number.isFinite(bearingDeg) || !quat) return;

  // --- the dot itself -----------------------------------------------------
  const uv = worldToImage(azAltToVec(bearingDeg, altitudeDeg), quatConj(quat), tanHalfH, tanHalfV);
  const waiting = state === 'waiting' || state === 'behind';
  const ink = waiting ? COLOR.weak : COLOR.target;

  if (uv) {
    const x = (uv[0] + 1) / 2 * W;
    const y = (1 - uv[1]) / 2 * H;
    const pulse = waiting ? 0.5 + 0.5 * Math.sin(Date.now() / 260) : 1;

    // A ring rather than a blob: the operator has to be able to see the horizon
    // through it, since lining the two up is the task.
    ctx.beginPath();
    ctx.arc(x, y, 26, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${0.20 + 0.25 * pulse})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 3;
    ctx.stroke();

    // While it is waiting, say so in the only place the operator is looking.
    if (waiting) {
      ctx.beginPath();
      ctx.arc(x, y, 26 + 8 * (1 - pulse), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(224,163,60,${0.5 * pulse})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    return;
  }

  // --- off-frame: an arrow at the edge, pointing the way round ------------
  const delta = angDiff(bearingDeg, guide.headingDeg);
  const left = delta < 0;
  const x = left ? 30 : W - 30;
  const y = H / 2;
  const dir = left ? -1 : 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.moveTo(dir * 17, 0);
  ctx.lineTo(dir * -8, -15);
  ctx.lineTo(dir * -8, 15);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(232,244,248,0.85)';
  ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText(`${Math.abs(delta).toFixed(0)}°`, x, y + 22);
}

export function drawOverlay(canvas, frame, directive, guide = null) {
  // When the director has declared the frame unusable, draw nothing. A traced
  // line on screen reads as a measurement whatever the confidence chip says.
  if (directive && (directive.headline === 'Too dark to survey' || directive.headline === 'Tracking lost — stop turning')) {
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(rect.width * dpr)) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);

  if (frame && frame.boundary) {
    const n = frame.boundary.length;
    // Confidence-coloured detected skyline
    for (let x = 0; x < n - 1; x++) {
      const c0 = frame.confidence[x];
      const flagged = frame.flags[x] !== 0;
      const y0 = frame.boundary[x] / frame.height * H;
      const y1 = frame.boundary[x + 1] / frame.height * H;
      ctx.beginPath();
      ctx.moveTo(x / n * W, y0);
      ctx.lineTo((x + 1) / n * W, y1);
      ctx.strokeStyle = flagged ? 'rgba(255,122,89,0.9)'
        : `rgba(${Math.round(255 - c0 * 209)},${Math.round(163 + c0 * 36)},${Math.round(60 + c0 * 170)},0.95)`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // Roll reference
  ctx.strokeStyle = 'rgba(232,244,248,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(W * 0.12, H / 2); ctx.lineTo(W * 0.88, H / 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W / 2, H * 0.12); ctx.lineTo(W / 2, H * 0.88); ctx.stroke();

  drawGuidance(ctx, W, H, guide);

  // Tilt arrows when the director asks for one
  if (directive && directive.tilt) {
    const up = directive.tilt > 0;
    const y = up ? H * 0.14 : H * 0.86;
    ctx.fillStyle = 'rgba(255,122,89,0.95)';
    ctx.beginPath();
    ctx.moveTo(W / 2, y + (up ? -14 : 14));
    ctx.lineTo(W / 2 - 13, y + (up ? 10 : -10));
    ctx.lineTo(W / 2 + 13, y + (up ? 10 : -10));
    ctx.closePath();
    ctx.fill();
  }
}

export { COLOR };

/* ------------------------------------------------- coverage map, for export */

/**
 * Draw the finished coverage map as a standalone picture for the debug archive.
 *
 * The JSON beside it has every number, but a ring you can look at answers the
 * question people actually ask — "where was the dot and why would it not move"
 * — in about a second. Covered sectors read solid, partly-covered ones fade
 * with their confidence, and anything the camera swept through without
 * capturing is marked distinctly from ground never visited at all, because
 * those two look identical on a plain progress meter and mean opposite things.
 *
 * Returns a PNG Blob, or null where the platform has no canvas.
 */
export function renderCoverageCard(coverage, guidance = null, { size = 520 } = {}) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const cx = size / 2, cy = size / 2 + 8;
  const R = size * 0.40;
  const inner = R - size * 0.085;
  const toAngle = az => (az - 90) * Math.PI / 180;
  const summary = coverage.completeness();

  ctx.fillStyle = '#0a1418';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < coverage.binCount; i++) {
    const covered = coverage.isCovered(i);
    const score = coverage.score[i];
    const visited = coverage.visited(i);
    let fill;
    if (covered) fill = COLOR.verified;
    else if (score > 0.05) fill = `rgba(46,199,230,${0.15 + score * 0.5})`;
    // Swept through and not captured is the interesting failure, and it is a
    // different fact from never having been pointed at. Amber, not blank.
    else if (visited) fill = 'rgba(224,163,60,0.55)';
    else fill = '#16262d';
    const a0 = toAngle(i * coverage.binSizeDeg);
    const a1 = toAngle((i + 1.03) * coverage.binSizeDeg);
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a1);
    ctx.arc(cx, cy, inner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  ctx.strokeStyle = COLOR.gridStrong;
  ctx.lineWidth = 1;
  for (const r of [R, inner]) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }

  ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [az, label] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    const a = toAngle(az);
    ctx.fillStyle = COLOR.text;
    ctx.fillText(label, cx + Math.cos(a) * (R + 16), cy + Math.sin(a) * (R + 16));
  }

  // Where the dot finished, and where the camera was pointing.
  const mark = (deg, colour, label) => {
    if (!Number.isFinite(deg)) return;
    const a = toAngle(deg);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (inner - 10), cy + Math.sin(a) * (inner - 10));
    ctx.lineTo(cx + Math.cos(a) * (R + 4), cy + Math.sin(a) * (R + 4));
    ctx.strokeStyle = colour; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * (inner - 16), cy + Math.sin(a) * (inner - 16), 5, 0, Math.PI * 2);
    ctx.fillStyle = colour; ctx.fill();
    ctx.fillStyle = colour;
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(label, cx + Math.cos(a) * (inner - 34), cy + Math.sin(a) * (inner - 34));
  };
  if (guidance) {
    mark(guidance.headingDeg, COLOR.ink, 'cam');
    if (guidance.state !== 'complete') mark(guidance.bearingDeg, COLOR.target, 'dot');
  }

  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR.ink;
  ctx.font = '600 15px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(`${Math.round(summary.fraction * 100)}% of the horizon covered`, 16, 14);
  ctx.fillStyle = COLOR.text;
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(`${summary.coveredBins}/${summary.binCount} bins · ${summary.remainingDeg}° remaining` +
    `${guidance ? ` · target ${guidance.state}` : ''}`, 16, 34);

  ctx.textAlign = 'center';
  const legend = [['covered', COLOR.verified], ['partial', 'rgba(46,199,230,0.45)'],
    ['swept, not captured', 'rgba(224,163,60,0.55)'], ['never pointed at', '#16262d']];
  let x = 18;
  for (const [label, colour] of legend) {
    ctx.fillStyle = colour;
    ctx.fillRect(x, size - 22, 10, 10);
    ctx.fillStyle = COLOR.text;
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 14, size - 21);
    x += 16 + ctx.measureText(label).width + 12;
  }

  return new Promise(resolve => {
    if (typeof canvas.toBlob !== 'function') { resolve(null); return; }
    canvas.toBlob(blob => resolve(blob), 'image/png');
  });
}
