'use strict';
import { clamp, wrap360, angDiff } from './math3d.js';
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

export function drawOverlay(canvas, frame, directive) {
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
